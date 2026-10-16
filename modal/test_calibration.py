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


if __name__ == '__main__':
    unittest.main()
