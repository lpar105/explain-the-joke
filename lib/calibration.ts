export type ManualInterval = { start: number; end: number };

// Effective values are part of the immutable input, not environment defaults.
export const CALIBRATION_PROCESSING = {
  contract: 'manual-calibration-v1',
  preprocessing: 'bandpass-afftdn-attenuation-v1',
  detector: 'rms-zcr-v1',
  fitting: 'duration-f0.5-v1',
  settings: {
    highpassHz: 120, lowpassHz: 3200, noiseReduction: 12,
    attenuationDb: -18, sampleRate: 16000, channels: 1, pcmBits: 16,
    frameSeconds: 0.04, smoothingSeconds: 0.24,
    minimumSegmentSeconds: 0.28, gapFrames: 4, automaticMergeSeconds: 0.2,
  },
} as const;

export function validateManualSample(duration: number, intervals: ManualInterval[]) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) {
    throw new Error('This calibration flow requires a Set of at most 60 seconds.');
  }
  let previousEnd = 0;
  let positive = 0;
  let hasNegative = false;
  for (const interval of intervals) {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) ||
        interval.start < previousEnd || interval.start < 0 ||
        interval.end <= interval.start || interval.end > duration) {
      throw new Error('Laugh marks must be sorted, disjoint, and inside the Set.');
    }
    hasNegative ||= interval.start > previousEnd;
    previousEnd = interval.end;
    positive += interval.end - interval.start;
  }
  hasNegative ||= previousEnd < duration;
  if (!(positive > 0 && hasNegative)) {
    throw new Error('Mark both laughter and unmarked non-laughter before confirming.');
  }
}

export type ScoreTrack = {
  version: 'rms-zcr-v1';
  preprocessingVersion: 'bandpass-afftdn-attenuation-v1';
  retainedMediaKey: string;
  retainedMediaSha256: string;
  totalDuration: number;
  frameSeconds: number;
  intensityReference: number;
  scores: number[];
};

export function manualRegions(args: {
  duration: number;
  intervals: ManualInterval[];
  track: ScoreTrack;
  lines: Array<{ ordinal: number; startSeconds: number; endSeconds: number }>;
}) {
  validateManualSample(args.duration, args.intervals);
  const { track } = args;
  if (track.version !== CALIBRATION_PROCESSING.detector ||
      track.preprocessingVersion !== CALIBRATION_PROCESSING.preprocessing ||
      track.frameSeconds !== CALIBRATION_PROCESSING.settings.frameSeconds ||
      !Number.isFinite(track.totalDuration) || Math.abs(track.totalDuration - args.duration) > 0.05 ||
      !Number.isFinite(track.intensityReference) || track.intensityReference < 0 ||
      track.scores.length !== Math.ceil(track.totalDuration / track.frameSeconds) ||
      track.scores.some(score => !Number.isFinite(score) || score < 0)) {
    throw new Error('Invalid calibration score track.');
  }
  return args.intervals.map((interval, ordinal) => {
    const line = args.lines.find(line => line.startSeconds <= interval.start && line.endSeconds > interval.start);
    if (!line) throw new Error('Transcript ownership is unavailable.');
    let peak = 0;
    for (let index = 0; index < track.scores.length; index++) {
      if (index * track.frameSeconds < interval.end && (index + 1) * track.frameSeconds > interval.start) {
        peak = Math.max(peak, track.scores[index]);
      }
    }
    return {
      ordinal, lineOrdinal: line.ordinal,
      startSeconds: interval.start, endSeconds: interval.end,
      intensityScore: Number(Math.min(1, Math.max(0, peak / Math.max(track.intensityReference * 1.75, 1e-6))).toFixed(4)),
    };
  });
}
