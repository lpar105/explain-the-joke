import { describe, expect, it } from 'vitest';
import { calibratedRegions, constrainLaughMark, previewCalibratedRegions, retimeLaughMark, validateManualSample, type ScoreTrack } from '../../lib/calibration';

describe('manual laugh mark editing', () => {
  const sample = { start: 5, end: 65 };
  const marks = [{ start: 10, end: 12 }, { start: 20, end: 24 }, { start: 30, end: 32 }];

  it('limits new marks to the gap where they started in either direction', () => {
    expect(constrainLaughMark(15, 26, sample, marks)).toEqual({ start: 15, end: 20 });
    expect(constrainLaughMark(15, 8, sample, marks)).toEqual({ start: 12, end: 15 });
    expect(constrainLaughMark(11, 15, sample, marks)).toBeNull();
    expect(constrainLaughMark(12, 15, sample, marks)).toEqual({ start: 12, end: 15 });
    expect(constrainLaughMark(20, 15, sample, marks)).toEqual({ start: 15, end: 20 });
  });

  it('limits each red edge to its neighbor or sample boundary', () => {
    expect(retimeLaughMark(marks, 1, 'start', 6, sample)[1]).toEqual({ start: 12, end: 24 });
    expect(retimeLaughMark(marks, 1, 'end', 40, sample)[1]).toEqual({ start: 20, end: 30 });
    expect(retimeLaughMark(marks, 0, 'start', 0, sample)[0].start).toBe(5);
    expect(retimeLaughMark(marks, 2, 'end', 80, sample)[2].end).toBe(65);
  });
});

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
  it('allows the final minute of a longer Set and rejects a sample past the end', () => {
    const intervals = [{ start: 88, end: 89 }];
    expect(validateManualSample(90, intervals, 30)).toEqual({ start: 30, end: 90 });
    expect(() => validateManualSample(90, intervals, 30.001)).toThrow();
    expect(() => validateManualSample(90, [{ start: 30, end: 90 }], 30)).toThrow();
    expect(() => validateManualSample(60, intervals, 1)).toThrow();
  });

  it('preserves manual labels on an all-zero track and publishes no automatic laughter', () => {
    const intervals = [{ start: 24.013, end: 24.501 }];
    const result = calibratedRegions({
      duration: 90, sampleStart: 20, intervals,
      track: {
        version: 'rms-zcr-v1', preprocessingVersion: 'bandpass-afftdn-attenuation-v1',
        retainedMediaKey: 'retained', retainedMediaSha256: 'a'.repeat(64),
        totalDuration: 90, frameSeconds: 0.04, intensityReference: 0, scores: Array(2250).fill(0),
      },
      lines: [{ ordinal: 1, startSeconds: 0, endSeconds: 90 }],
    });
    expect(result.fit).toMatchObject({ candidateCount: 0, f05: 0 });
    expect(result.regions).toEqual([
      { ordinal: 0, lineOrdinal: 1, source: 'manual', startSeconds: 24.013, endSeconds: 24.501, intensityScore: 0 },
    ]);
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
    expect(calibratedRegions(args).regions).toEqual([
      { ordinal: 0, lineOrdinal: 1, source: 'manual', startSeconds: 0.013, endSeconds: 0.501, intensityScore: 0.2857 },
      { ordinal: 1, lineOrdinal: 2, source: 'manual', startSeconds: 0.502, endSeconds: 0.999, intensityScore: 0.2857 },
    ]);
    expect(calibratedRegions({ ...args, track: { ...track, scores: Array(25).fill(0), intensityReference: 0 } }).regions[0].intensityScore).toBe(0);
    expect(calibratedRegions({ ...args, track: { ...track, scores: Array(25).fill(100) } }).regions[0].intensityScore).toBe(1);
    expect(() => calibratedRegions({ ...args, track: { ...track, intensityReference: NaN } })).toThrow();
    expect(() => calibratedRegions({ ...args, track: { ...track, scores: [Infinity] } })).toThrow();
  });

  it('changes automatic suggestions at a new cutoff while preserving manual sample labels', () => {
    const scores = Array<number>(2250).fill(0);
    scores.fill(0.5, 125, 150);
    scores.fill(0.5, 500, 525);
    scores.fill(0.9, 2125, 2150);
    const track: ScoreTrack = {
      version: 'rms-zcr-v1', preprocessingVersion: 'bandpass-afftdn-attenuation-v1',
      retainedMediaKey: 'retained', retainedMediaSha256: 'a'.repeat(64),
      totalDuration: 90, frameSeconds: 0.04, intensityReference: 0.5, scores,
    };
    const intervals = [{ start: 20.013, end: 20.983 }];
    const sample = { start: 10, end: 70 };
    const args = { track, duration: 90, intervals, sample };
    const { fit, regions } = calibratedRegions({ ...args, sampleStart: sample.start,
      lines: [{ ordinal: 0, startSeconds: 0, endSeconds: 90 }] });

    const atFittedCutoff = previewCalibratedRegions({ ...args, threshold: fit!.threshold });
    expect(atFittedCutoff.map(({ start, end }) => [start, end]))
      .toEqual(regions.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]));
    const higher = previewCalibratedRegions({ ...args, threshold: 0.6 });
    expect(higher).toMatchObject([
      { ...intervals[0], source: 'manual' },
      { start: 85, end: 86, source: 'automatic' },
    ]);
    expect(higher[0]).toEqual(atFittedCutoff.find(region => region.source === 'manual'));
  });
});
