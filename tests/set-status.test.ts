import { describe, expect, it } from "vitest";

import {
  getBreakdownBadgeLabel,
  getBreakdownSummary,
  getSetStatusLabel,
} from "../lib/set-status";

describe("set status helpers", () => {
  it("formats the current set status label", () => {
    expect(getSetStatusLabel("playbackPending")).toBe("Playback Pending");
  });

  it("surfaces a locked breakdown badge when only lines are ready", () => {
    expect(getBreakdownBadgeLabel("locked", "ready", "pending")).toBe(
      "Breakdown Locked",
    );
  });

  it("summarizes a failed line seeding state", () => {
    expect(getBreakdownSummary("locked", "failed", "pending")).toBe(
      "This Set may still become playable, but the current Breakdown is unavailable.",
    );
  });
});
