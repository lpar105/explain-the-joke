import { describe, expect, it } from "vitest";

import {
  clampTime,
  getClipDurationSeconds,
  getClipTimeFromSourceTime,
  getClipRelativeTime,
  getPlaybackWindowForSource,
  getSourceTimeFromClipTime,
} from "../../lib/trim-range";

describe("trim range helpers", () => {
  it("clamps values into the active trim window", () => {
    expect(clampTime(-2, 5, 10)).toBe(5);
    expect(clampTime(7, 5, 10)).toBe(7);
    expect(clampTime(15, 5, 10)).toBe(10);
  });

  it("computes retained clip duration from upload-relative trim offsets", () => {
    expect(getClipDurationSeconds(32, 95)).toBe(63);
  });

  it("maps absolute playback time to retained clip time", () => {
    expect(getClipRelativeTime(42, 30, 90)).toBe(12);
    expect(getClipRelativeTime(18, 30, 90)).toBe(0);
    expect(getClipRelativeTime(140, 30, 90)).toBe(60);
  });

  it("uses the upload timeline for temporary mux playback and clip-relative time for bunny playback", () => {
    expect(getPlaybackWindowForSource("mux", 30, 90)).toEqual({
      startSeconds: 30,
      endSeconds: 90,
    });
    expect(getPlaybackWindowForSource("bunny", 30, 90)).toEqual({
      startSeconds: 0,
      endSeconds: 60,
    });
  });

  it("converts between clip-relative and source-relative playback time", () => {
    expect(getSourceTimeFromClipTime(12, "mux", 30, 90)).toBe(42);
    expect(getSourceTimeFromClipTime(12, "bunny", 30, 90)).toBe(12);
    expect(getSourceTimeFromClipTime(80, "mux", 30, 90)).toBe(90);

    expect(getClipTimeFromSourceTime(42, "mux", 30, 90)).toBe(12);
    expect(getClipTimeFromSourceTime(12, "bunny", 30, 90)).toBe(12);
    expect(getClipTimeFromSourceTime(12, "mux", 30, 90)).toBe(0);
  });
});
