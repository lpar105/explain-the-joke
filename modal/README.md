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

`preprocess_laugh_audio` extracts mono 48 kHz audio from `retainedMedia`. The
Modal worker runs ClearVoice's `MossFormer2_SE_48K` speech enhancement model
and aligns the reconstruction to the original by cross-correlation. It uploads
`speech-reconstruction.wav` as `cleanedAudio` and the signed difference
`original - reconstructed speech` as `laughter-residual.wav` (`residualAudio`).
The Set's `/dev` page can switch between these recordings on the same timeline.

The worker image installs ClearVoice and downloads its pinned model checkpoint
at build time. Existing jobs created with the original calibration contract
continue to use their 16 kHz FFmpeg cleanup and RMS/ZCR score track.

## Laugh candidate detection implementation

For jobs with a speech reconstruction, the detector compares the original and
aligned reconstruction using Tight Five's per-frame normalized magnitude
spectral difference. The automatic detector uses a 0.03 threshold and 0.7-second
gap and duration settings. It weights candidates by the subtraction signal's
RMS, spectral centroid and duration and publishes `laughCandidatesRaw`.

The calibration path groups the spectral differences into 40 ms score bins and
uses the manually marked sample to fit its cutoff for the rest of the Set. A Set
that fits entirely in the marked sample uses the user's marks for its regions.

## Deploy

```bash
modal deploy modal/ingest.py
```

Deploy the Modal workers before deploying the Convex workflow that requests the
new residual artifact.

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
