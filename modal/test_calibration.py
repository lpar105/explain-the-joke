import hashlib
import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

import numpy as np
import ingest


class ManualCalibrationTests(unittest.TestCase):
    def write_audio(self, path, duration, silent=False):
        time = np.arange(int(duration * 16000)) / 16000
        samples = np.zeros(len(time), dtype=np.int16) if silent else (12000 * np.sin(time * 800)).astype(np.int16)
        with wave.open(str(path), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(samples.tobytes())

    def test_short_and_exact_minute_score_extraction_has_no_detection(self):
        for duration in [0.013, 12.345, 60]:
            with self.subTest(duration=duration), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'retained.wav'
                self.write_audio(path, duration)
                track = ingest._manual_score_track(path, path, 'immutable-retained')
                self.assertEqual(track['retainedMediaSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                self.assertEqual(track['retainedMediaKey'], 'immutable-retained')
                self.assertAlmostEqual(track['totalDuration'], duration)
                self.assertEqual(len(track['scores']), int(np.ceil(duration / 0.04)))
                self.assertTrue(np.all(np.isfinite(track['scores'])))
                self.assertNotIn('threshold', track)
                self.assertNotIn('segments', track)
                self.assertEqual(track['version'], 'rms-zcr-v1')

    def test_silence_is_zero_but_empty_or_unreadable_audio_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'audio.wav'
            self.write_audio(path, 1, silent=True)
            track = ingest._manual_score_track(path, path, 'retained')
            self.assertTrue(all(value == 0 for value in track['scores']))
            self.assertEqual(track['intensityReference'], 0)
            self.write_audio(path, 0)
            with self.assertRaises(RuntimeError):
                ingest._manual_score_track(path, path, 'retained')
            path.write_bytes(b'invalid')
            with self.assertRaises((wave.Error, EOFError)):
                ingest._manual_score_track(path, path, 'retained')

    @mock.patch('ingest._detect_laugh_candidates_impl', side_effect=AssertionError('Manual-only must not detect'))
    @mock.patch.dict('os.environ', {'MODAL_LAUGH_HIGHPASS_HZ': '999', 'MODAL_LAUGH_NORMALIZE_TARGET_DB': '50'})
    def test_manual_preprocessing_uses_frozen_settings_and_artifact_identity(self, detector):
        with tempfile.TemporaryDirectory() as directory:
            retained = Path(directory) / 'retained.wav'
            self.write_audio(retained, 1)
            outputs = [ingest.Artifact(name, True, 'set-ingest/set/' + name, kind)
                       for name, kind in [('cleaned.wav', 'cleanedAudio'), ('scores.json', 'scoreTrack')]]
            payload = ingest.WorkerPayload(1, 'breakdown', 'secret', 'callback', 'job',
                [ingest.Artifact('retained.wav', True, 'retained-identity', 'retainedMedia')], outputs, 'set', 'preprocessLaughAudio')
            captured = {}

            def upload(path, artifact):
                if artifact.kind == 'scoreTrack':
                    captured.update(json.loads(path.read_text()))
                return artifact

            with mock.patch('ingest._download_artifact', return_value=retained), mock.patch('ingest._upload_to_bunny', side_effect=upload), mock.patch('ingest._run_ffmpeg', wraps=ingest._run_ffmpeg) as ffmpeg:
                result = ingest._preprocess_laugh_audio_impl(payload)
            self.assertEqual(len(result), 2)
            self.assertIn('highpass=f=120,lowpass=f=3200,afftdn=nr=12,volume=-18dB', ffmpeg.call_args.args[0])
            self.assertEqual(captured['retainedMediaKey'], 'retained-identity')
            detector.assert_not_called()


class ResidualAudioTests(unittest.TestCase):
    def test_preprocess_and_detection_compare_retained_audio_to_reconstructed_speech(self):
        sample_rate = ingest.LAUGH_SAMPLE_RATE
        random = np.random.default_rng(42)
        speech = (random.normal(0, 0.002, sample_rate * 3)).astype(np.float32)
        event = np.zeros_like(speech)
        event[sample_rate:sample_rate * 2] = random.normal(0, 0.05, sample_rate)
        clean = ingest.Artifact('speech-reconstruction.wav', True, 'clean', 'cleanedAudio')
        retained = ingest.Artifact('retained.wav', True, 'retained', 'retainedMedia')
        residual = ingest.Artifact('laughter-residual.wav', True, 'residual', 'residualAudio')
        scores = ingest.Artifact('score-track.json', True, 'scores', 'scoreTrack')
        candidates = ingest.Artifact('laugh-candidates.json', True, 'candidates', 'laughCandidatesRaw')

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            ingest._write_laugh_wav(folder / retained.key, speech + event)
            ingest._write_laugh_wav(folder / 'speech.wav', speech)
            quantized_speech = ingest._read_laugh_wav(folder / 'speech.wav')

            def upload(path, artifact):
                (folder / artifact.key).write_bytes(path.read_bytes())
                return artifact

            payload = ingest.WorkerPayload(1, 'breakdown', 'secret', 'callback', 'job',
                [retained], [clean, residual, scores], 'set', 'preprocessLaughAudio')
            with mock.patch('ingest._download_artifact', side_effect=lambda artifact, _: folder / artifact.key), \
                mock.patch('ingest._upload_to_bunny', side_effect=upload), \
                mock.patch('ingest._reconstruct_speech', return_value=quantized_speech):
                self.assertEqual(ingest._preprocess_laugh_audio_impl(payload), [clean, residual, scores])
                payload.inputArtifacts = [retained, clean]
                payload.outputArtifacts = [candidates]
                payload.stepName = 'detectLaughCandidates'
                self.assertEqual(ingest._detect_laugh_candidates_impl(payload), [candidates])

            result = ingest._read_laugh_wav(folder / residual.key)
            np.testing.assert_allclose(result, event, atol=1 / 32768)
            track = json.loads((folder / scores.key).read_text())
            self.assertEqual(track['version'], 'spectral-difference-v1')
            self.assertEqual(track['retainedMediaKey'], retained.key)
            self.assertEqual(len(track['scores']), 75)
            self.assertEqual(track['scores'][0], 0)
            self.assertGreater(track['scores'][30], 0.03)
            segments = json.loads((folder / candidates.key).read_text())['segments']
            self.assertEqual(len(segments), 1)
            self.assertAlmostEqual(segments[0]['start_time'], 1, delta=0.04)
            self.assertAlmostEqual(segments[0]['end_time'], 2, delta=0.04)

    def test_alignment_cancels_delayed_speech_without_moving_the_recording(self):
        original = np.zeros(48000, dtype=np.float32)
        original[2500:4500] = np.random.default_rng(42).uniform(-1, 1, 2000)
        delayed = np.pad(original, (400, 0))[:len(original)]
        np.testing.assert_array_equal(ingest._align_speech(original, delayed), original)
        self.assertEqual(ingest._residual_laugh_segments(original, original), [])


if __name__ == '__main__':
    unittest.main()
