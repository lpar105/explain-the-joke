from __future__ import annotations

import json
import os
import subprocess
import tempfile
import wave
from collections.abc import Mapping
from dataclasses import asdict, dataclass
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


@dataclass
class Artifact:
    fileName: str
    isCanonical: bool
    key: str
    kind: Literal[
        "retainedMedia",
        "playbackMedia",
        "cleanedAudio",
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
        "cleanedAudio",
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

    with tempfile.TemporaryDirectory(prefix="tight-five-modal-") as temp_dir:
        temp_path = Path(temp_dir)
        retained_path = temp_path / retained_artifact.fileName
        playback_path = temp_path / playback_artifact.fileName

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

        return [
            _upload_to_bunny(retained_path, retained_artifact),
            _upload_to_bunny(playback_path, playback_artifact),
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
    retained_artifact = _expect_input_artifact(payload, "retainedMedia")
    cleaned_artifact = _expect_output_artifact(payload, "cleanedAudio")

    highpass_hz = os.environ.get("MODAL_LAUGH_HIGHPASS_HZ", "120")
    lowpass_hz = os.environ.get("MODAL_LAUGH_LOWPASS_HZ", "3200")
    noise_reduction = os.environ.get("MODAL_LAUGH_NOISE_REDUCTION", "12")
    normalize_target = os.environ.get("MODAL_LAUGH_NORMALIZE_TARGET_DB", "-18")

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

        return [_upload_to_bunny(cleaned_path, cleaned_artifact)]


def _detect_laugh_candidates_impl(payload: WorkerPayload) -> list[Artifact]:
    import numpy as np

    cleaned_artifact = _expect_input_artifact(payload, "cleanedAudio")
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


@app.function(image=image, cpu=2, secrets=MODAL_SECRETS, timeout=60 * 20)
def preprocess_laugh_audio(**raw_payload: Any) -> None:
    _run_worker(raw_payload, _preprocess_laugh_audio_impl)


@app.function(image=image, cpu=2, secrets=MODAL_SECRETS, timeout=60 * 20)
def detect_laugh_candidates(**raw_payload: Any) -> None:
    _run_worker(raw_payload, _detect_laugh_candidates_impl)
