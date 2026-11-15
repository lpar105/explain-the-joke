from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import tempfile
import wave
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Literal
from urllib import error as urlerror
from urllib import request

import modal

WHISPER_MODEL_DIR = "/models/faster-whisper"
WHISPER_MODEL_NAME = os.environ.get("MODAL_WHISPER_MODEL_NAME", "small.en")
MODAL_SECRET_NAME = os.environ.get("MODAL_SECRET_NAME", "custom-secret")
MODAL_SECRETS = [modal.Secret.from_name(MODAL_SECRET_NAME)]
IMAGE_PYTHON_PACKAGES = (
    "httpx==0.28.1",
    "faster-whisper==1.1.1",
    "numpy==2.1.3",
    "requests==2.33.0",
)
LAUGH_SAMPLE_RATE = 48000
LAUGH_FFT_SIZE = 2048
LAUGH_HOP_LENGTH = 512
LAUGH_MODEL = "MossFormer2_SE_48K"
LAUGH_PREPROCESS_CPUS = 4
WHISPER_CACHE = modal.Volume.from_name(
    "tight-five-whisper-cache",
    create_if_missing=True,
)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(*IMAGE_PYTHON_PACKAGES)
    .env({"HF_HOME": WHISPER_MODEL_DIR})
)

app = modal.App("tight-five-ingest", image=image)

# ClearVoice requires NumPy 1.x. Keep its dependencies out of the other workers.
speech_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0", "build-essential")
    .pip_install(
        "clearvoice==0.1.2", "numpy==1.26.4", "scipy==1.14.1",
        "torch==2.6.0", "torchaudio==2.6.0", "torchvision==0.21.0",
        "huggingface-hub==0.34.4",
    )
    .workdir("/opt/clearvoice")
    .run_commands(
        'python -c "from huggingface_hub import snapshot_download; '
        f"snapshot_download('alibabasglab/{LAUGH_MODEL}', revision='eff8c97', "
        f"local_dir='checkpoints/{LAUGH_MODEL}', allow_patterns='last_best_checkpoint*')\"",
    )
)


@dataclass
class Artifact:
    fileName: str
    isCanonical: bool
    key: str
    kind: Literal[
        "retainedMedia",
        "playbackMedia",
        "thumbnail",
        "cleanedAudio",
        "residualAudio",
        "scoreTrack",
        "transcriptRaw",
        "laughCandidatesRaw",
    ]
    contentType: str | None = None
    expiresAt: int | None = None
    size: int | None = None


@dataclass
class TrimSource:
    muxAssetId: str
    muxPlaybackId: str
    sourceHlsUrl: str
    trimRangeEndSeconds: float
    trimRangeStartSeconds: float


@dataclass
class WorkerPayload:
    attemptNumber: int
    breakdownId: str
    callbackSecret: str
    callbackUrl: str
    ingestJobId: str
    inputArtifacts: list[Artifact]
    outputArtifacts: list[Artifact]
    setId: str
    stepName: str
    trimSource: TrimSource | None = None


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def _parse_payload(raw: dict[str, Any]) -> WorkerPayload:
    trim_source = raw.get("trimSource")
    parsed_trim_source = (
        TrimSource(**dict(trim_source))
        if isinstance(trim_source, Mapping)
        else None
    )
    return WorkerPayload(
        attemptNumber=int(raw["attemptNumber"]),
        breakdownId=str(raw["breakdownId"]),
        callbackSecret=str(raw["callbackSecret"]),
        callbackUrl=str(raw["callbackUrl"]),
        ingestJobId=str(raw["ingestJobId"]),
        inputArtifacts=[Artifact(**artifact) for artifact in raw.get("inputArtifacts", [])],
        outputArtifacts=[Artifact(**artifact) for artifact in raw.get("outputArtifacts", [])],
        setId=str(raw["setId"]),
        stepName=str(raw["stepName"]),
        trimSource=parsed_trim_source,
    )


def _callback(
    payload: WorkerPayload,
    *,
    outcome: Literal["succeeded", "failed"],
    artifacts: list[Artifact] | None = None,
    failure_code: str | None = None,
    failure_detail: str | None = None,
) -> None:
    body: dict[str, Any] = {
        "attemptNumber": payload.attemptNumber,
        "ingestJobId": payload.ingestJobId,
        "outcome": outcome,
        "stepName": payload.stepName,
    }

    if artifacts:
        body["artifacts"] = [
            {
                key: value
                for key, value in asdict(artifact).items()
                if value is not None
            }
            for artifact in artifacts
        ]

    if failure_code is not None:
        body["failureCode"] = failure_code

    if failure_detail is not None:
        body["failureDetail"] = failure_detail

    data = json.dumps(body).encode("utf-8")
    req = request.Request(
        payload.callbackUrl,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-set-ingest-callback-secret": payload.callbackSecret,
        },
    )
    with request.urlopen(req) as response:
        if response.status >= 300:
            raise RuntimeError(
                f"Callback failed for {payload.stepName}: {response.status}",
            )


def _storage_endpoint(region: str) -> str:
    return {
        "default": "storage.bunnycdn.com",
        "de": "storage.bunnycdn.com",
        "ny": "ny.storage.bunnycdn.com",
        "la": "la.storage.bunnycdn.com",
        "sg": "sg.storage.bunnycdn.com",
        "syd": "syd.storage.bunnycdn.com",
        "br": "br.storage.bunnycdn.com",
        "jh": "jh.storage.bunnycdn.com",
    }.get(region, "storage.bunnycdn.com")


def _upload_to_bunny(file_path: Path, artifact: Artifact) -> Artifact:
    storage_zone = _require_env("BUNNY_STORAGE_ZONE")
    api_key = _require_env("BUNNY_API_KEY")
    region = os.environ.get("BUNNY_REGION", "default")
    upload_url = (
        f"https://{_storage_endpoint(region)}/{storage_zone}/{artifact.key}"
    )

    with file_path.open("rb") as file_handle:
        req = request.Request(
            upload_url,
            data=file_handle.read(),
            method="PUT",
            headers={
                "AccessKey": api_key,
                "Content-Type": artifact.contentType or "application/octet-stream",
            },
        )
        try:
            with request.urlopen(req) as response:
                if response.status >= 300:
                    raise RuntimeError(
                        f"Bunny upload failed for {artifact.key}: {response.status}",
                    )
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(
                f"Bunny upload failed for {artifact.key}: {exc.code} {detail}",
            ) from exc

    artifact.size = file_path.stat().st_size
    return artifact


def _run_ffmpeg(args: list[str]) -> None:
    completed = subprocess.run(
        ["ffmpeg", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed with code {completed.returncode}: {completed.stderr.strip()}",
        )


def _expect_output_artifact(
    payload: WorkerPayload,
    kind: Literal[
        "retainedMedia",
        "playbackMedia",
        "thumbnail",
        "cleanedAudio",
        "residualAudio",
        "scoreTrack",
        "transcriptRaw",
        "laughCandidatesRaw",
    ],
) -> Artifact:
    for artifact in payload.outputArtifacts:
        if artifact.kind == kind:
            return artifact
    raise RuntimeError(f"Missing required output artifact definition for {kind}")


def _expect_input_artifact(
    payload: WorkerPayload,
    kind: Literal["retainedMedia", "cleanedAudio", "transcriptRaw"],
) -> Artifact:
    for artifact in payload.inputArtifacts:
        if artifact.kind == kind:
            return artifact
    raise RuntimeError(f"Missing required input artifact definition for {kind}")


def _download_artifact(artifact: Artifact, destination: Path) -> Path:
    storage_zone = _require_env("BUNNY_STORAGE_ZONE")
    api_key = _require_env("BUNNY_API_KEY")
    region = os.environ.get("BUNNY_REGION", "default")
    artifact_url = (
        f"https://{_storage_endpoint(region)}/{storage_zone}/{artifact.key}"
    )
    req = request.Request(
        artifact_url,
        method="GET",
        headers={
            "AccessKey": api_key,
        },
    )
    try:
        with request.urlopen(req) as response:
            if response.status >= 300:
                raise RuntimeError(
                    f"Failed to download artifact {artifact.key}: {response.status}",
                )
            destination.write_bytes(response.read())
    except urlerror.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(
            f"Failed to download artifact {artifact.key}: {exc.code} {detail}",
        ) from exc
    return destination


def _run_worker(
    raw_payload: dict[str, Any],
    implementation: Callable[[WorkerPayload], list[Artifact]],
) -> None:
    payload = _parse_payload(raw_payload)
    try:
        artifacts = implementation(payload)
        _callback(payload, outcome="succeeded", artifacts=artifacts)
    except Exception as exc:
        _callback(
            payload,
            outcome="failed",
            failure_code="external_worker_failed",
            failure_detail=str(exc),
        )
        raise


def _prepare_retained_media_impl(payload: WorkerPayload) -> list[Artifact]:
    if payload.trimSource is None:
        raise RuntimeError("trimSource is required for prepareRetainedMedia")

    retained_artifact = _expect_output_artifact(payload, "retainedMedia")
    playback_artifact = _expect_output_artifact(payload, "playbackMedia")
    thumbnail_artifact = _expect_output_artifact(payload, "thumbnail")

    with tempfile.TemporaryDirectory(prefix="tight-five-modal-") as temp_dir:
        temp_path = Path(temp_dir)
        retained_path = temp_path / retained_artifact.fileName
        playback_path = temp_path / playback_artifact.fileName
        thumbnail_path = temp_path / thumbnail_artifact.fileName

        source = payload.trimSource
        input_args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            source.sourceHlsUrl,
        ]
        trim_args = [
            "-ss",
            f"{source.trimRangeStartSeconds:.3f}",
            "-t",
            f"{source.trimRangeEndSeconds - source.trimRangeStartSeconds:.3f}",
        ]

        _run_ffmpeg(
            [
                *input_args,
                *trim_args,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(retained_path),
            ],
        )

        _run_ffmpeg(
            [
                *input_args,
                *trim_args,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(playback_path),
            ],
        )

        thumbnail_offset_seconds = min(
            1.0,
            (source.trimRangeEndSeconds - source.trimRangeStartSeconds) / 2,
        )
        _run_ffmpeg(
            [
                *input_args,
                "-ss",
                f"{source.trimRangeStartSeconds + thumbnail_offset_seconds:.3f}",
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(thumbnail_path),
            ],
        )

        return [
            _upload_to_bunny(retained_path, retained_artifact),
            _upload_to_bunny(playback_path, playback_artifact),
            _upload_to_bunny(thumbnail_path, thumbnail_artifact),
        ]


@app.cls(
    image=image,
    cpu=2,
    secrets=MODAL_SECRETS,
    scaledown_window=60 * 10,
    timeout=60 * 20,
    volumes={WHISPER_MODEL_DIR: WHISPER_CACHE},
)
class WhisperTranscriber:
    @modal.enter()
    def load_model(self) -> None:
        from faster_whisper import WhisperModel

        compute_type = os.environ.get("MODAL_WHISPER_COMPUTE_TYPE", "int8")
        device = os.environ.get("MODAL_WHISPER_DEVICE", "cpu")

        self.model = WhisperModel(
            WHISPER_MODEL_NAME,
            device=device,
            compute_type=compute_type,
            download_root=WHISPER_MODEL_DIR,
        )

    @modal.method()
    def transcribe_artifact(self, raw_artifact: dict[str, Any]) -> dict[str, Any]:
        artifact = Artifact(**raw_artifact)
        with tempfile.TemporaryDirectory(prefix="tight-five-whisper-") as temp_dir:
            audio_path = _download_artifact(
                artifact,
                Path(temp_dir) / artifact.fileName,
            )
            return self._transcribe_file(audio_path)

    def _transcribe_file(self, audio_path: Path) -> dict[str, Any]:
        beam_size = int(os.environ.get("MODAL_WHISPER_BEAM_SIZE", "5"))
        language = os.environ.get("MODAL_WHISPER_LANGUAGE", "en")
        vad_filter = os.environ.get("MODAL_WHISPER_VAD_FILTER", "true").lower() != "false"

        segments, info = self.model.transcribe(
            str(audio_path),
            beam_size=beam_size,
            language=language,
            vad_filter=vad_filter,
            word_timestamps=True,
        )

        word_entries: list[dict[str, Any]] = []
        sentence_entries: list[dict[str, Any]] = []
        text_parts: list[str] = []

        for sentence_index, segment in enumerate(segments):
            segment_text = (segment.text or "").strip()
            if segment_text:
                text_parts.append(segment_text)

            sentence_entries.append(
                {
                    "index": sentence_index + 1,
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": segment_text,
                },
            )

            for word in segment.words or []:
                token = (word.word or "").strip()
                if not token:
                    continue
                word_entries.append(
                    {
                        "word": token,
                        "start": float(word.start),
                        "end": float(word.end),
                        "sentence_idx": sentence_index,
                    },
                )

        return {
            "language": getattr(info, "language", None),
            "duration": float(getattr(info, "duration", 0.0) or 0.0),
            "text": " ".join(text_parts).strip(),
            "words": word_entries,
            "sentences": sentence_entries,
        }


def _transcribe_words_impl(payload: WorkerPayload) -> list[Artifact]:
    retained_artifact = _expect_input_artifact(payload, "retainedMedia")
    transcript_artifact = _expect_output_artifact(payload, "transcriptRaw")

    with tempfile.TemporaryDirectory(prefix="tight-five-modal-") as temp_dir:
        temp_path = Path(temp_dir)
        transcript_path = temp_path / transcript_artifact.fileName

        transcription = WhisperTranscriber().transcribe_artifact.remote(
            asdict(retained_artifact),
        )
        transcript_path.write_text(
            json.dumps(transcription, ensure_ascii=True),
            encoding="utf-8",
        )

        return [_upload_to_bunny(transcript_path, transcript_artifact)]


def _preprocess_laugh_audio_impl(payload: WorkerPayload) -> list[Artifact]:
    if any(artifact.kind == "residualAudio" for artifact in payload.outputArtifacts):
        return _preprocess_residual_audio(payload)

    retained_artifact = _expect_input_artifact(payload, "retainedMedia")
    cleaned_artifact = _expect_output_artifact(payload, "cleanedAudio")

    manual_only = any(a.kind == "scoreTrack" for a in payload.outputArtifacts)
    highpass_hz = "120" if manual_only else os.environ.get("MODAL_LAUGH_HIGHPASS_HZ", "120")
    lowpass_hz = "3200" if manual_only else os.environ.get("MODAL_LAUGH_LOWPASS_HZ", "3200")
    noise_reduction = "12" if manual_only else os.environ.get("MODAL_LAUGH_NOISE_REDUCTION", "12")
    normalize_target = "-18" if manual_only else os.environ.get("MODAL_LAUGH_NORMALIZE_TARGET_DB", "-18")

    filter_chain = ",".join(
        [
            f"highpass=f={highpass_hz}",
            f"lowpass=f={lowpass_hz}",
            f"afftdn=nr={noise_reduction}",
            f"volume={normalize_target}dB",
        ],
    )

    with tempfile.TemporaryDirectory(prefix="tight-five-modal-") as temp_dir:
        temp_path = Path(temp_dir)
        retained_path = _download_artifact(
            retained_artifact,
            temp_path / retained_artifact.fileName,
        )
        cleaned_path = temp_path / cleaned_artifact.fileName

        _run_ffmpeg(
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(retained_path),
                "-af",
                filter_chain,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(cleaned_path),
            ],
        )

        outputs = [_upload_to_bunny(cleaned_path, cleaned_artifact)]
        if manual_only:
            score_artifact = _expect_output_artifact(payload, "scoreTrack")
            track = _manual_score_track(cleaned_path, retained_path, retained_artifact.key)
            score_path = temp_path / score_artifact.fileName
            score_path.write_text(json.dumps(track, allow_nan=False), encoding="utf-8")
            outputs.append(_upload_to_bunny(score_path, score_artifact))
        return outputs


def _extract_laugh_wav(source: Path, destination: Path) -> None:
    _run_ffmpeg([
        "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-vn",
        "-ac", "1", "-ar", str(LAUGH_SAMPLE_RATE), "-c:a", "pcm_s16le", str(destination),
    ])


def _read_laugh_wav(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as audio:
        if (audio.getframerate(), audio.getsampwidth(), audio.getnchannels()) != (LAUGH_SAMPLE_RATE, 2, 1):
            raise RuntimeError("Expected mono 48 kHz PCM16 audio")
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")
    if not samples.size:
        raise RuntimeError("Empty laugh audio")
    return samples.astype(np.float32) / 32768


def _write_laugh_wav(path: Path, samples) -> None:
    import numpy as np

    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, LAUGH_SAMPLE_RATE, 0, "NONE", "not compressed"))
        audio.writeframes(np.clip(np.rint(samples * 32768), -32768, 32767).astype("<i2").tobytes())


@lru_cache(maxsize=1)
def _speech_enhancer():
    import torch
    from clearvoice import ClearVoice

    torch.set_num_threads(LAUGH_PREPROCESS_CPUS)
    return ClearVoice(task="speech_enhancement", model_names=[LAUGH_MODEL])


def _align_speech(original, speech):
    import numpy as np
    from scipy.signal import correlate, correlation_lags

    # Match Tight Five's correlation alignment and keep the original timeline.
    window = min(len(original), len(speech), 10 * LAUGH_SAMPLE_RATE)
    reference, target = original[:window], speech[:window]
    shift = 0
    if np.any(reference) and np.any(target):
        correlation = correlate(reference, target, method="fft")
        lags = correlation_lags(window, window)
        allowed = np.abs(lags) <= LAUGH_SAMPLE_RATE
        shift = int(lags[allowed][np.argmax(correlation[allowed])])

    aligned = np.zeros_like(original)
    start = max(0, shift)
    skip = max(0, -shift)
    length = min(len(original) - start, len(speech) - skip)
    aligned[start:start + length] = speech[skip:skip + length]
    return aligned


def _reconstruct_speech(original_path: Path, original):
    import numpy as np

    if not np.any(original):
        return np.zeros_like(original)
    # The model's feature extractor needs context even for a very short trim.
    model_input = original_path
    if len(original) < LAUGH_SAMPLE_RATE:
        model_input = original_path.with_name("padded.wav")
        _write_laugh_wav(model_input, np.pad(original, (0, LAUGH_SAMPLE_RATE - len(original))))

    model_output = original_path.parent / "enhanced"
    _speech_enhancer()(input_path=str(model_input), online_write=True, output_path=str(model_output))
    model_wav = model_output / LAUGH_MODEL / model_input.name
    return _align_speech(original, _read_laugh_wav(model_wav)[:len(original)])


def _spectrum_batches(samples):
    import numpy as np

    padded = np.pad(samples, LAUGH_FFT_SIZE // 2)
    frames = np.lib.stride_tricks.sliding_window_view(padded, LAUGH_FFT_SIZE)[::LAUGH_HOP_LENGTH]
    window = np.hanning(LAUGH_FFT_SIZE + 1)[:-1].astype(np.float32)
    for index in range(0, len(frames), 512):
        yield np.abs(np.fft.rfft(frames[index:index + 512] * window, axis=1))


def _spectral_difference(original, speech):
    import numpy as np

    scores = []
    for raw, clean in zip(_spectrum_batches(original), _spectrum_batches(speech), strict=True):
        raw /= raw.max(axis=1, keepdims=True) + 1e-8
        clean /= clean.max(axis=1, keepdims=True) + 1e-8
        scores.append(np.mean(np.abs(raw - clean), axis=1))
    return np.concatenate(scores)


def _residual_score_track(original, speech, retained_path: Path, retained_key: str) -> dict[str, Any]:
    import numpy as np

    scores = _spectral_difference(original, speech)
    # Group native STFT frames into the 40 ms intervals used by calibration.
    samples_per_frame = 1920
    frame_count = (len(original) + samples_per_frame - 1) // samples_per_frame
    bins = np.minimum(np.arange(len(scores)) * LAUGH_HOP_LENGTH // samples_per_frame, frame_count - 1)
    grouped = np.zeros(frame_count)
    np.maximum.at(grouped, bins, scores)
    digest = hashlib.sha256()
    with retained_path.open("rb") as retained:
        for chunk in iter(lambda: retained.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "version": "spectral-difference-v1",
        "preprocessingVersion": "mossformer2-residual-v1",
        "retainedMediaKey": retained_key,
        "retainedMediaSha256": digest.hexdigest(),
        "totalDuration": len(original) / LAUGH_SAMPLE_RATE,
        "frameSeconds": 0.04,
        "intensityReference": 0.03,
        "scores": grouped.tolist(),
    }


def _preprocess_residual_audio(payload: WorkerPayload) -> list[Artifact]:
    retained = _expect_input_artifact(payload, "retainedMedia")
    cleaned = _expect_output_artifact(payload, "cleanedAudio")
    residual = _expect_output_artifact(payload, "residualAudio")
    with tempfile.TemporaryDirectory(prefix="tight-five-modal-") as directory:
        folder = Path(directory)
        retained_path = _download_artifact(retained, folder / retained.fileName)
        original_path = folder / "original.wav"
        _extract_laugh_wav(retained_path, original_path)
        original = _read_laugh_wav(original_path)
        speech = _reconstruct_speech(original_path, original)
        cleaned_path, residual_path = folder / cleaned.fileName, folder / residual.fileName
        _write_laugh_wav(cleaned_path, speech)
        _write_laugh_wav(residual_path, original - speech)

        outputs = [(cleaned_path, cleaned), (residual_path, residual)]
        if any(artifact.kind == "scoreTrack" for artifact in payload.outputArtifacts):
            scores = _expect_output_artifact(payload, "scoreTrack")
            score_path = folder / scores.fileName
            track = _residual_score_track(original, speech, retained_path, retained.key)
            score_path.write_text(json.dumps(track, allow_nan=False), encoding="utf-8")
            outputs.append((score_path, scores))
        return [_upload_to_bunny(path, artifact) for path, artifact in outputs]


def _manual_score_track(cleaned_path: Path, retained_path: Path, retained_key: str) -> dict[str, Any]:
    """Score extraction only: no threshold fitting or automatic segmentation."""
    import numpy as np

    with wave.open(str(cleaned_path), "rb") as wav_file:
        if (wav_file.getframerate(), wav_file.getsampwidth(), wav_file.getnchannels()) != (16000, 2, 1):
            raise RuntimeError("Invalid cleaned audio format")
        raw = wav_file.readframes(wav_file.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if len(audio) == 0:
        raise RuntimeError("Empty cleaned audio")
    energies = []
    for start in range(0, len(audio), 640):
        frame = audio[start:start + 640]
        zcr = float(np.mean(np.abs(np.diff(np.signbit(frame).astype(np.int8))))) if len(frame) > 1 else 0.0
        energies.append(float(np.sqrt(np.mean(np.square(frame)))) * (1.0 + zcr))
    # Explicit padding preserves one frame per input frame, including tiny Sets.
    values = np.array(energies, dtype=np.float32)
    smoothed = np.convolve(np.pad(values, (3, 2)), np.ones(6, dtype=np.float32) / 6, mode="valid")
    if not np.all(np.isfinite(smoothed)):
        raise RuntimeError("Non-finite score track")
    reference = max(float(np.percentile(smoothed, 75)), float(smoothed.mean()) + 1.85 * float(smoothed.std()))
    return {
        "version": "rms-zcr-v1", "preprocessingVersion": "bandpass-afftdn-attenuation-v1",
        "retainedMediaKey": retained_key,
        "retainedMediaSha256": hashlib.sha256(retained_path.read_bytes()).hexdigest(),
        "totalDuration": len(audio) / 16000, "frameSeconds": 0.04,
        "intensityReference": reference, "scores": smoothed.tolist(),
    }


def _detect_laugh_candidates_impl(payload: WorkerPayload) -> list[Artifact]:
    import numpy as np

    cleaned_artifact = _expect_input_artifact(payload, "cleanedAudio")
    if cleaned_artifact.fileName == "speech-reconstruction.wav":
        return _detect_residual_laughs(payload, cleaned_artifact)
    laugh_candidates_artifact = _expect_output_artifact(
        payload,
        "laughCandidatesRaw",
    )

    frame_ms = int(os.environ.get("MODAL_LAUGH_FRAME_MS", "40"))
    smoothing_ms = int(os.environ.get("MODAL_LAUGH_SMOOTHING_MS", "240"))
    min_segment_ms = int(os.environ.get("MODAL_LAUGH_MIN_SEGMENT_MS", "280"))
    max_gap_ms = int(os.environ.get("MODAL_LAUGH_MAX_GAP_MS", "180"))
    threshold_multiplier = float(
        os.environ.get("MODAL_LAUGH_THRESHOLD_MULTIPLIER", "1.85"),
    )
    percentile_floor = float(
        os.environ.get("MODAL_LAUGH_THRESHOLD_PERCENTILE", "75"),
    )

    with tempfile.TemporaryDirectory(prefix="tight-five-modal-") as temp_dir:
        temp_path = Path(temp_dir)
        cleaned_path = _download_artifact(
            cleaned_artifact,
            temp_path / cleaned_artifact.fileName,
        )
        candidates_path = temp_path / laugh_candidates_artifact.fileName

        with wave.open(str(cleaned_path), "rb") as wav_file:
            sample_rate = wav_file.getframerate()
            sample_width = wav_file.getsampwidth()
            channel_count = wav_file.getnchannels()
            frame_count = wav_file.getnframes()
            raw_bytes = wav_file.readframes(frame_count)

        if sample_width != 2:
            raise RuntimeError(
                f"Expected 16-bit PCM WAV for cleanedAudio, got sample width {sample_width}",
            )

        audio = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32)
        if channel_count > 1:
            audio = audio.reshape(-1, channel_count).mean(axis=1)
        audio /= 32768.0

        total_duration = len(audio) / sample_rate if sample_rate > 0 else 0.0
        samples_per_frame = max(1, int(sample_rate * (frame_ms / 1000.0)))
        smoothing_frames = max(1, int(round(smoothing_ms / frame_ms)))
        min_segment_frames = max(1, int(round(min_segment_ms / frame_ms)))
        max_gap_frames = max(1, int(round(max_gap_ms / frame_ms)))

        if len(audio) == 0:
            payload_json = {
                "sample_rate": sample_rate,
                "total_duration": total_duration,
                "segments": [],
            }
            candidates_path.write_text(
                json.dumps(payload_json, ensure_ascii=True),
                encoding="utf-8",
            )
            return [_upload_to_bunny(candidates_path, laugh_candidates_artifact)]

        frame_starts = range(0, len(audio), samples_per_frame)
        energies = []

        for start in frame_starts:
            frame = audio[start : start + samples_per_frame]
            if len(frame) == 0:
                continue
            rms = float(np.sqrt(np.mean(np.square(frame))))
            zero_crossings = float(
                np.mean(np.abs(np.diff(np.signbit(frame).astype(np.int8)))),
            )
            energies.append(rms * (1.0 + zero_crossings))

        energy_array = np.array(energies, dtype=np.float32)
        if len(energy_array) == 0:
            smoothed = energy_array
        else:
            kernel = np.ones(smoothing_frames, dtype=np.float32) / smoothing_frames
            smoothed = np.convolve(energy_array, kernel, mode="same")

        mean_energy = float(smoothed.mean()) if len(smoothed) else 0.0
        std_energy = float(smoothed.std()) if len(smoothed) else 0.0
        percentile_energy = (
            float(np.percentile(smoothed, percentile_floor)) if len(smoothed) else 0.0
        )
        threshold = max(
            percentile_energy,
            mean_energy + std_energy * threshold_multiplier,
        )

        active_frames = smoothed >= threshold
        segments: list[dict[str, float]] = []
        open_start: int | None = None
        last_active_index: int | None = None

        for frame_index, is_active in enumerate(active_frames.tolist()):
            if is_active:
                if open_start is None:
                    open_start = frame_index
                last_active_index = frame_index
                continue

            if open_start is None or last_active_index is None:
                continue

            if frame_index - last_active_index <= max_gap_frames:
                continue

            if last_active_index - open_start + 1 >= min_segment_frames:
                start_seconds = (open_start * samples_per_frame) / sample_rate
                end_seconds = min(
                    total_duration,
                    ((last_active_index + 1) * samples_per_frame) / sample_rate,
                )
                window = smoothed[open_start : last_active_index + 1]
                intensity = float(
                    min(
                        1.0,
                        window.max() / max(threshold * 1.75, 1e-6),
                    ),
                )
                segments.append(
                    {
                        "start_time": round(start_seconds, 3),
                        "end_time": round(end_seconds, 3),
                        "duration": round(max(0.0, end_seconds - start_seconds), 3),
                        "intensity_score": round(max(0.0, intensity), 4),
                    },
                )

            open_start = None
            last_active_index = None

        if open_start is not None and last_active_index is not None:
            if last_active_index - open_start + 1 >= min_segment_frames:
                start_seconds = (open_start * samples_per_frame) / sample_rate
                end_seconds = min(
                    total_duration,
                    ((last_active_index + 1) * samples_per_frame) / sample_rate,
                )
                window = smoothed[open_start : last_active_index + 1]
                intensity = float(
                    min(
                        1.0,
                        window.max() / max(threshold * 1.75, 1e-6),
                    ),
                )
                segments.append(
                    {
                        "start_time": round(start_seconds, 3),
                        "end_time": round(end_seconds, 3),
                        "duration": round(max(0.0, end_seconds - start_seconds), 3),
                        "intensity_score": round(max(0.0, intensity), 4),
                    },
                )

        payload_json = {
            "sample_rate": sample_rate,
            "total_duration": round(total_duration, 3),
            "segments": segments,
        }
        candidates_path.write_text(
            json.dumps(payload_json, ensure_ascii=True),
            encoding="utf-8",
        )

        return [_upload_to_bunny(candidates_path, laugh_candidates_artifact)]


def _residual_laugh_segments(original, speech) -> list[dict[str, float]]:
    import numpy as np

    hop_seconds = LAUGH_HOP_LENGTH / LAUGH_SAMPLE_RATE
    active = np.flatnonzero(_spectral_difference(original, speech) > 0.03)
    if not active.size:
        return []

    frequencies = np.fft.rfftfreq(LAUGH_FFT_SIZE, 1 / LAUGH_SAMPLE_RATE)
    segments = []
    for group in np.split(active, np.flatnonzero(np.diff(active) * hop_seconds > 0.7) + 1):
        start = int(group[0]) * LAUGH_HOP_LENGTH
        end = min(len(original), (int(group[-1]) + 1) * LAUGH_HOP_LENGTH)
        duration = (end - start) / LAUGH_SAMPLE_RATE
        if duration < 0.7:
            continue
        residual = np.abs(original[start:end] - speech[start:end])
        rms = float(np.sqrt(np.mean(residual ** 2)))
        centroids = []
        for spectrum in _spectrum_batches(residual):
            centroids.extend((spectrum * frequencies).sum(axis=1) / np.maximum(spectrum.sum(axis=1), 1e-8))
        intensity = rms * float(np.mean(centroids)) / 1000 * math.log1p(duration)
        segments.append({
            "start_time": round(start / LAUGH_SAMPLE_RATE, 6),
            "end_time": round(end / LAUGH_SAMPLE_RATE, 6),
            "duration": round(duration, 6),
            "intensity_score": intensity,
        })

    peak = max((segment["intensity_score"] for segment in segments), default=0)
    if peak <= 0:
        return []
    for segment in segments:
        segment["intensity_score"] = round(segment["intensity_score"] / peak, 4)
    return [segment for segment in segments if segment["intensity_score"] >= 0.05]


def _detect_residual_laughs(payload: WorkerPayload, cleaned: Artifact) -> list[Artifact]:
    retained = _expect_input_artifact(payload, "retainedMedia")
    candidates = _expect_output_artifact(payload, "laughCandidatesRaw")
    with tempfile.TemporaryDirectory(prefix="tight-five-modal-") as directory:
        folder = Path(directory)
        retained_path = _download_artifact(retained, folder / retained.fileName)
        cleaned_path = _download_artifact(cleaned, folder / cleaned.fileName)
        original_path = folder / "original.wav"
        _extract_laugh_wav(retained_path, original_path)
        original, speech = _read_laugh_wav(original_path), _read_laugh_wav(cleaned_path)
        if len(original) != len(speech):
            raise RuntimeError("Speech reconstruction does not match the retained audio duration")
        candidates_path = folder / candidates.fileName
        candidates_path.write_text(json.dumps({
            "sample_rate": LAUGH_SAMPLE_RATE,
            "total_duration": len(original) / LAUGH_SAMPLE_RATE,
            "segments": _residual_laugh_segments(original, speech),
        }, allow_nan=False), encoding="utf-8")
        return [_upload_to_bunny(candidates_path, candidates)]


def _not_implemented_impl(payload: WorkerPayload) -> list[Artifact]:
    raise RuntimeError(
        f"{payload.stepName} is scaffolded in Modal but not implemented yet.",
    )


@app.function(image=image, cpu=2, secrets=MODAL_SECRETS, timeout=60 * 20)
def prepare_retained_media(**raw_payload: Any) -> None:
    _run_worker(raw_payload, _prepare_retained_media_impl)


@app.function(image=image, cpu=2, secrets=MODAL_SECRETS, timeout=60 * 20)
def transcribe_words(**raw_payload: Any) -> None:
    _run_worker(raw_payload, _transcribe_words_impl)


@app.function(image=speech_image, cpu=LAUGH_PREPROCESS_CPUS, memory=8192, secrets=MODAL_SECRETS, timeout=60 * 60)
def preprocess_laugh_audio(**raw_payload: Any) -> None:
    _run_worker(raw_payload, _preprocess_laugh_audio_impl)


@app.function(image=image, cpu=2, secrets=MODAL_SECRETS, timeout=60 * 20)
def detect_laugh_candidates(**raw_payload: Any) -> None:
    _run_worker(raw_payload, _detect_laugh_candidates_impl)
