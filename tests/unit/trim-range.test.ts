import { describe, expect, it } from "vitest";

import {
  clampTime,
  getClipDurationSeconds,
  getClipRelativeTime,
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
});
