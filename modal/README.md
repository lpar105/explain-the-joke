# Modal Ingest Workers

This directory contains the remote worker implementation for the Set ingest
pipeline.

## What lives here

- `ingest.py`
  - `prepare_retained_media`
  - `transcribe_words`
  - `preprocess_laugh_audio`
  - `detect_laugh_candidates`

All workers share the same payload shape and the same callback behavior:

1. Convex spawns a Modal function with keyword args.
2. The worker performs its step.
3. The worker uploads produced files directly to Bunny when needed.
4. The worker calls Convex back at `/modal/workflow-callback`.

## Current status

- `prepare_retained_media` is implemented.
- `transcribe_words` is implemented with a shared Whisper worker.
- `preprocess_laugh_audio` is implemented.
- `detect_laugh_candidates` is implemented.

## Worker contract

Each worker receives kwargs including:

- `attemptNumber`
- `breakdownId`
- `callbackSecret`
- `callbackUrl`
- `ingestJobId`
- `inputArtifacts`
- `outputArtifacts`
- `setId`
- `stepName`
- `trimSource` for `prepareRetainedMedia`

## Local setup

1. Install Modal and authenticate.
2. Copy `.env.example` to `.env`.
3. Fill in the Bunny settings.
4. Adjust Whisper settings if needed.
5. Create or update the Modal secret that holds the worker env vars. By default
   the workers expect a Modal secret named `custom-secret`, with env var names
   preserved as-is, for example `BUNNY_API_KEY`.
6. Run `modal setup` if you have not authenticated before.

## Transcription implementation

`transcribe_words` uses a shared Whisper class worker so the model can be
loaded once and reused across calls.

It currently:

- passes the canonical `retainedMedia` artifact metadata to the shared Whisper
  worker, which downloads the media inside its own container
- runs Whisper with word timestamps enabled
- writes a `transcriptRaw` JSON payload containing:
  - `text`
  - `duration`
  - `language`
  - `words`
  - `sentences`
- uploads the transcript artifact to Bunny
- calls Convex back with the artifact metadata

## Laugh preprocessing implementation

`preprocess_laugh_audio` is a deterministic ffmpeg-based cleanup pass.

It currently:

- downloads the canonical `retainedMedia` artifact from Bunny
- applies a high-pass filter
- applies a low-pass filter
- runs spectral denoising
- normalizes loudness with a fixed target gain
- writes a mono 16kHz WAV as `cleanedAudio`
- uploads the cleaned audio artifact to Bunny
- calls Convex back with the artifact metadata

## Laugh candidate detection implementation

`detect_laugh_candidates` is currently a deterministic segmentation pass over the
cleaned WAV.

It currently:

- downloads the canonical `cleanedAudio` artifact from Bunny
- measures short-window energy and zero-crossing activity
- smooths the activity over time
- thresholds the smoothed signal into candidate regions
- merges short gaps and drops very short regions
- writes a `laughCandidatesRaw` JSON payload containing:
  - `sample_rate`
  - `total_duration`
  - `segments`
- uploads the artifact to Bunny
- calls Convex back with the artifact metadata

## Deploy

```bash
modal deploy modal/ingest.py
```

The workers mount the Modal secret named `custom-secret` by default. If you use a
different Modal secret name, set `MODAL_SECRET_NAME` before deploy so the worker
decorators attach the right secret.

If your Modal app name differs, set Convex env vars to match:

- `MODAL_APP_NAME`
- `MODAL_PREPARE_RETAINED_MEDIA_FUNCTION_NAME`
- `MODAL_TRANSCRIBE_FUNCTION_NAME`
- `MODAL_PREPROCESS_LAUGH_AUDIO_FUNCTION_NAME`
- `MODAL_DETECT_LAUGH_CANDIDATES_FUNCTION_NAME`

## Important note

The Convex pipeline now assumes production architecture:

- Convex orchestrates
- Modal computes
- Bunny stores artifacts

Do not add local `ffmpeg`-based fallback logic back into Convex.
