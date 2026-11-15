import { describe, expect, it } from "vitest";
import { timingWindowAt, zoomTimingWindow } from "../../lib/set-review";

describe("laugh timing window", () => {
  it.each([
    { playhead: 2, duration: 78, start: 0, nextStart: -4, nextEnd: 56 },
    { playhead: 77, duration: 78, start: 60, nextStart: 26, nextEnd: 86 },
    { playhead: 78, duration: 78, start: 60, nextStart: 24, nextEnd: 84 },
  ])("preserves the playhead position at $playhead seconds while zooming out", ({
    playhead, duration, start, nextStart, nextEnd,
  }) => {
    const zoom = zoomTimingWindow(playhead, start, 20, 60);
    const window = timingWindowAt(playhead, duration, zoom.length, zoom.origin);
    expect(window.start).toBeCloseTo(nextStart);
    expect(window.end).toBeCloseTo(nextEnd);
    expect((playhead - window.start) / 60).toBeCloseTo((playhead - start) / 20);
  });

  it("pages between full windows and keeps playback end on the last playable page", () => {
    const duration = 37.125;
    const length = 10;
    const origin = 7.125;
    const first = timingWindowAt(0, duration, length, origin);
    expect(first).toEqual({ start: -2.875, end: 7.125, hasPrevious: false, hasNext: true });
    expect(timingWindowAt(first.end - 0.00000001, duration, length, origin).start).toBe(first.end);
    expect(timingWindowAt(duration, duration, length, origin)).toEqual({
      start: 27.125, end: duration, hasPrevious: true, hasNext: false,
    });
  });
});
