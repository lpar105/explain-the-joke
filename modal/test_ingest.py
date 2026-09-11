import unittest
from unittest import mock

import ingest


class WhisperTranscriberTests(unittest.TestCase):
    def test_modal_image_installs_whisper_runtime_dependencies(self) -> None:
        self.assertIn(
            "requests==2.33.0",
            ingest.IMAGE_PYTHON_PACKAGES,
            "faster-whisper imports requests during WhisperTranscriber startup",
        )

    def test_transcribe_artifact_is_a_remote_modal_method(self) -> None:
        transcribe_artifact = ingest.WhisperTranscriber().transcribe_artifact

        self.assertTrue(
            hasattr(transcribe_artifact, "remote"),
            "WhisperTranscriber.transcribe_artifact must be decorated with @modal.method()",
        )

    @mock.patch("ingest._upload_to_bunny", side_effect=lambda _path, artifact: artifact)
    @mock.patch("ingest._download_artifact")
    @mock.patch("ingest.WhisperTranscriber")
    def test_transcribe_words_sends_artifact_metadata_to_remote_container(
        self,
        transcriber_class: mock.Mock,
        download_artifact: mock.Mock,
        _upload_to_bunny: mock.Mock,
    ) -> None:
        remote = transcriber_class.return_value.transcribe_artifact.remote
        remote.return_value = {
            "duration": 1.0,
            "language": "en",
            "sentences": [],
            "text": "hello",
            "words": [],
        }
        retained_artifact = ingest.Artifact(
            contentType="audio/wav",
            fileName="retained-media.wav",
            isCanonical=True,
            key="sets/set-id/retained-media.wav",
            kind="retainedMedia",
        )
        payload = ingest.WorkerPayload(
            attemptNumber=1,
            breakdownId="breakdown-id",
            callbackSecret="secret",
            callbackUrl="https://example.com/callback",
            ingestJobId="job-id",
            inputArtifacts=[retained_artifact],
            outputArtifacts=[
                ingest.Artifact(
                    contentType="application/json",
                    fileName="transcript.json",
                    isCanonical=True,
                    key="sets/set-id/transcript.json",
                    kind="transcriptRaw",
                ),
            ],
            setId="set-id",
            stepName="transcribeWords",
        )

        ingest._transcribe_words_impl(payload)

        remote.assert_called_once_with(ingest.asdict(retained_artifact))
        download_artifact.assert_not_called()


class PrepareRetainedMediaTests(unittest.TestCase):
    @mock.patch("ingest._upload_to_bunny", side_effect=lambda _path, artifact: artifact)
    @mock.patch("ingest._run_ffmpeg")
    def test_uses_output_side_seek_for_hls_input(
        self,
        run_ffmpeg: mock.Mock,
        _upload_to_bunny: mock.Mock,
    ) -> None:
        payload = ingest.WorkerPayload(
            attemptNumber=1,
            breakdownId="breakdown-id",
            callbackSecret="secret",
            callbackUrl="https://example.com/callback",
            ingestJobId="job-id",
            inputArtifacts=[],
            outputArtifacts=[
                ingest.Artifact(
                    contentType="audio/wav",
                    fileName="retained-media.wav",
                    isCanonical=True,
                    key="retained-media.wav",
                    kind="retainedMedia",
                ),
                ingest.Artifact(
                    contentType="video/mp4",
                    fileName="playback.mp4",
                    isCanonical=True,
                    key="playback.mp4",
                    kind="playbackMedia",
                ),
            ],
            setId="set-id",
            stepName="prepareRetainedMedia",
            trimSource=ingest.TrimSource(
                muxAssetId="asset-id",
                muxPlaybackId="playback-id",
                sourceHlsUrl="https://stream.mux.com/playback-id.m3u8",
                trimRangeEndSeconds=39.667,
                trimRangeStartSeconds=3.415,
            ),
        )

        ingest._prepare_retained_media_impl(payload)

        self.assertEqual(run_ffmpeg.call_count, 2)
        for ffmpeg_call in run_ffmpeg.call_args_list:
            args = ffmpeg_call.args[0]
            self.assertLess(args.index("-i"), args.index("-ss"))
            self.assertNotIn("-to", args)
            self.assertEqual(args[args.index("-ss") + 1], "3.415")
            self.assertEqual(args[args.index("-t") + 1], "36.252")

if __name__ == "__main__":
    unittest.main()
