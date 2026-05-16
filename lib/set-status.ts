import type { Doc } from "../convex/_generated/dataModel";

type SetStatus = Doc<"sets">["setStatus"];
type BreakdownEditability = Doc<"breakdowns">["editability"];
type LineSeedingState = Doc<"breakdowns">["lineSeedingState"];
type LaughSeedingState = Doc<"breakdowns">["laughSeedingState"];

export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);

  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function formatTimestamp(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);

  return `${minutes.toString().padStart(2, "0")}:${remainder
    .toString()
    .padStart(2, "0")}`;
}

export function formatCreationDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-NZ", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

export function getSetStatusLabel(status: SetStatus) {
  switch (status) {
    case "playbackPending":
      return "Playback Pending";
    case "playable":
      return "Playable";
    case "unavailable":
      return "Unavailable";
    default:
      return status;
  }
}

export function getBreakdownBadgeLabel(
  editability: BreakdownEditability,
  lineSeedingState: LineSeedingState,
  laughSeedingState: LaughSeedingState,
) {
  if (editability === "editable") {
    return "Breakdown Editable";
  }

  if (lineSeedingState === "failed") {
    return "Lines Failed";
  }

  if (laughSeedingState === "failed") {
    return "Laughs Failed";
  }

  if (lineSeedingState === "ready" && laughSeedingState !== "ready") {
    return "Breakdown Locked";
  }

  return "Breakdown Pending";
}

export function getBreakdownSummary(
  editability: BreakdownEditability,
  lineSeedingState: LineSeedingState,
  laughSeedingState: LaughSeedingState,
) {
  if (editability === "editable") {
    return "Lines and Laugh Regions are ready for editing.";
  }

  if (lineSeedingState === "failed") {
    return "This Set may still become playable, but the current Breakdown is unavailable.";
  }

  if (laughSeedingState === "failed") {
    return "Lines can be reviewed while laugh seeding failed and manual laugh editing stays pending unlock.";
  }

  if (lineSeedingState === "ready") {
    return "The review surface can open while the current Breakdown stays locked.";
  }

  return "The current Breakdown shell exists, but seeded Lines and Laugh Regions are still pending.";
}
