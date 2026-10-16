import { describe, expect, it } from 'vitest';
import { manualRegions, validateManualSample, type ScoreTrack } from '../../lib/calibration';

describe('whole-Set manual calibration', () => {
  it.each([12.345, 60])('accepts both classes over the entire %s-second Set', duration => {
    expect(() => validateManualSample(duration, [{ start: 0.013, end: duration - 0.001 }])).not.toThrow();
  });
  it.each([
    [], [{ start: 0, end: 60 }], [{ start: -1, end: 1 }],
    [{ start: 1, end: Infinity }], [{ start: NaN, end: 2 }],
    [{ start: 2, end: 3 }, { start: 1, end: 1.5 }],
    [{ start: 1, end: 3 }, { start: 2, end: 4 }],
    [{ start: 3, end: 3 }], [{ start: 59, end: 61 }],
  ].map(intervals => ({ intervals })))('rejects invalid labels without repairing them: %j', ({ intervals }) => {
    expect(() => validateManualSample(60, intervals)).toThrow();
  });
  it('preserves sub-frame boundaries, tiny negative gaps, and starting-Line ownership', () => {
    const track: ScoreTrack = {
      version: 'rms-zcr-v1', preprocessingVersion: 'bandpass-afftdn-attenuation-v1', retainedMediaKey: 'retained', retainedMediaSha256: 'a'.repeat(64),
      totalDuration: 1, frameSeconds: 0.04, intensityReference: 2,
      scores: Array(25).fill(1),
    };
    const intervals = [{ start: 0.013, end: 0.501 }, { start: 0.502, end: 0.999 }];
    const args = { duration: 1, intervals, track, lines: [
      { ordinal: 1, startSeconds: 0, endSeconds: 0.5 },
      { ordinal: 2, startSeconds: 0.5, endSeconds: 1 },
    ] };
    expect(manualRegions(args)).toEqual([
      { ordinal: 0, lineOrdinal: 1, startSeconds: 0.013, endSeconds: 0.501, intensityScore: 0.2857 },
      { ordinal: 1, lineOrdinal: 2, startSeconds: 0.502, endSeconds: 0.999, intensityScore: 0.2857 },
    ]);
    expect(manualRegions({ ...args, track: { ...track, scores: Array(25).fill(0), intensityReference: 0 } })[0].intensityScore).toBe(0);
    expect(manualRegions({ ...args, track: { ...track, scores: Array(25).fill(100) } })[0].intensityScore).toBe(1);
    expect(() => manualRegions({ ...args, track: { ...track, intensityReference: NaN } })).toThrow();
    expect(() => manualRegions({ ...args, track: { ...track, scores: [Infinity] } })).toThrow();
  });
});
