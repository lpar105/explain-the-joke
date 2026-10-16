# Approved calibration annotation prototype

Throwaway design reference for https://github.com/lpar105/explain-the-joke/issues/32. Never merge this branch as implementation.

Run pnpm dev, then open /library?prototype=calibration. Choose a local video; no upload occurs. The prototype starts after the conceptual Trim Range confirmation, and does not modify the real upload pipeline.

Approved flow: two sequential modals using the existing trim modal's video preview, thumbnail timeline, styling, and dimensions. First select a continuous 60-second window (entire retained Set if shorter); then manually mark every laugh, with draggable boundaries, looping, I/O controls, zoom, and deletion on the timeline. Only the portion of a boundary-crossing laugh inside the sample is labeled. All unmarked time is non-laughter. Require both classes; no usable sample blocks upload with no bypass. Manual labels are authoritative in the sample; intensity annotation is unnecessary.

Approved simplification: taller thumbnail timelines in both modals; no sample start/end/duration box, list of laughs, review checkbox, verbose no-usable-sample warning, class-duration summary, or extra red seek slider. The Confirm Calibration action completes annotation without a separate attestation.

Validation: pnpm typecheck passed after final edits. Modal transition and invalid-sample gate were checked in-browser. This is a UI reference, with no persistence, worker integration, quality validation, or detector accuracy evidence. Persistence/cancellation and pipeline timing are the next decision.
