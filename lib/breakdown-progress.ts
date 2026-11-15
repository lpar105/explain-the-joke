import type { Infer } from "convex/values";
import type { ingestJobStatusValidator, lineSeedingStateValidator } from "../convex/schema";

export type BreakdownPathState = Infer<typeof lineSeedingStateValidator>;
export type IngestJobState = Infer<typeof ingestJobStatusValidator> | null;

export type BreakdownTrack = "transcript" | "laughs";

export function getEffectivePathState(
  pathState: BreakdownPathState,
  ingestJobState: IngestJobState,
): BreakdownPathState {
  if (
    ingestJobState === "failed" &&
    pathState !== "ready" &&
    pathState !== "failed"
  ) {
    return "failed";
  }

  return pathState;
}

export function getTrackLabel(
  track: BreakdownTrack,
  state: BreakdownPathState,
) {
  if (state === "retrying") {
    return "Trying again…";
  }

  if (state === "ready") {
    return "Ready";
  }

  if (state === "failed") {
    return track === "transcript"
      ? "Transcript unavailable"
      : "Laugh analysis unavailable";
  }

  if (track === "transcript") {
    return state === "pending" ? "Transcript queued" : "Building transcript";
  }

  return state === "pending"
    ? "Laugh analysis queued"
    : "Finding audience reactions";
}

export function getOverallProgressLabel(
  transcriptState: BreakdownPathState,
  laughState: BreakdownPathState,
) {
  if (transcriptState === "failed") {
    return "Breakdown unavailable";
  }

  if (transcriptState === "ready" && laughState === "failed") {
    return "Transcript ready";
  }

  if (transcriptState === "ready" && laughState === "ready") {
    return "Breakdown ready";
  }

  if (transcriptState === "ready") {
    return "Finishing breakdown";
  }

  return "Preparing breakdown";
}

export function isPathProcessing(state: BreakdownPathState) {
  return state === "pending" || state === "running" || state === "retrying";
}
