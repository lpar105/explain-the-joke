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

export const CALIBRATION_SAMPLE_SECONDS = 60;

export function constrainLaughMark(origin: number, target: number, sample: ManualInterval, marks: ManualInterval[]) {
  if (marks.some(mark => mark.start < origin && origin < mark.end)) return null;

  const previous = marks.findLast(mark => mark.end <= origin);
  const next = marks.find(mark => mark.start >= origin);
  const start = Math.max(Math.min(origin, target), previous?.end ?? sample.start);
  const end = Math.min(Math.max(origin, target), next?.start ?? sample.end);
  return start < end ? { start, end } : null;
}

export function retimeLaughMark(marks: ManualInterval[], index: number, edge: 'start' | 'end', target: number, sample: ManualInterval) {
  const mark = marks[index];
  const minimumLength = Math.min(0.05, mark.end - mark.start);
  const boundary = edge === 'start'
    ? Math.max(marks[index - 1]?.end ?? sample.start, Math.min(target, mark.end - minimumLength))
    : Math.min(marks[index + 1]?.start ?? sample.end, Math.max(target, mark.start + minimumLength));
  return marks.map((mark, i) => i === index ? { ...mark, [edge]: boundary } : mark);
}

export function validateManualSample(duration: number, intervals: ManualInterval[], start = 0) {
  const length = Math.min(duration, CALIBRATION_SAMPLE_SECONDS);
  if (!Number.isFinite(duration) || duration <= 0 ||
      !Number.isFinite(start) || start < 0 || start > duration - length) {
    throw new Error('Choose a calibration sample inside the retained Set.');
  }
  const end = Math.min(duration, start + length);
  let previousEnd = start;
  let hasNegative = false;
  for (const interval of intervals) {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) ||
        interval.start < previousEnd || interval.end <= interval.start || interval.end > end) {
      throw new Error('Laugh marks must be sorted, disjoint, and inside the calibration sample.');
    }
    hasNegative ||= interval.start > previousEnd;
    previousEnd = interval.end;
  }
  if (!intervals.length || (!hasNegative && previousEnd === end)) {
    throw new Error('Mark laughter and leave non-laughter unmarked before confirming.');
  }
  return { start, end };
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

function detectRegions(track: ScoreTrack, threshold: number, duration: number) {
  const { frameSeconds, scores } = track;
  const { gapFrames, minimumSegmentSeconds, automaticMergeSeconds } = CALIBRATION_PROCESSING.settings;
  const segments: ManualInterval[] = [];
  let first = -1;
  let last = -1;

  function finishSegment() {
    const start = first * frameSeconds;
    const end = Math.min(duration, (last + 1) * frameSeconds);
    if (end - start + 1e-9 < minimumSegmentSeconds) return;
    const previous = segments.at(-1);
    if (previous && start - previous.end <= automaticMergeSeconds + 1e-9) {
      previous.end = end;
    } else {
      segments.push({ start, end });
    }
  }

  for (let index = 0; index < scores.length && index * frameSeconds < duration; index++) {
    if (scores[index] <= 0 || scores[index] < threshold) continue;
    if (first < 0 || index - last > gapFrames) {
      if (first >= 0) finishSegment();
      first = index;
    }
    last = index;
  }
  if (first >= 0) finishSegment();
  return segments;
}

function measureFit(regions: ManualInterval[], sample: ManualInterval, labels: ManualInterval[], labeledSeconds: number) {
  let predictedSeconds = 0;
  let matchedSeconds = 0;
  let labelIndex = 0;
  for (const region of regions) {
    const start = Math.max(region.start, sample.start);
    const end = Math.min(region.end, sample.end);
    if (start >= end) continue;
    predictedSeconds += end - start;
    while (labelIndex < labels.length && labels[labelIndex].end <= start) labelIndex++;
    for (let index = labelIndex; index < labels.length && labels[index].start < end; index++) {
      const label = labels[index];
      matchedSeconds += Math.min(end, label.end) - Math.max(start, label.start);
    }
  }
  return {
    f05: 1.25 * matchedSeconds / (0.25 * labeledSeconds + predictedSeconds),
    precision: predictedSeconds > 0 ? matchedSeconds / predictedSeconds : 0,
  };
}

function fitThreshold(track: ScoreTrack, duration: number, sample: ManualInterval, labels: ManualInterval[]) {
  const sampleScores = track.scores.slice(
    Math.floor(sample.start / track.frameSeconds),
    Math.ceil(sample.end / track.frameSeconds),
  );
  const maximum = Math.max(...sampleScores);
  const aboveMaximum = maximum + Math.max(1, maximum) * Number.EPSILON;
  // Descending thresholds preserve the higher threshold when both metrics tie.
  const thresholds = Array.from(new Set(sampleScores)).sort((a, b) => b - a);
  const labeledSeconds = labels.reduce((sum, label) => sum + label.end - label.start, 0);
  let best = { threshold: aboveMaximum, f05: 0, precision: 0 };
  let bestRegions = detectRegions(track, aboveMaximum, duration);

  for (const threshold of thresholds) {
    const regions = detectRegions(track, threshold, duration);
    const measured = measureFit(regions, sample, labels, labeledSeconds);
    if (measured.f05 > best.f05 ||
        (measured.f05 === best.f05 && measured.precision > best.precision)) {
      best = { threshold, ...measured };
      bestRegions = regions;
    }
  }
  return { ...best, candidates: bestRegions };
}

export function validateCalibrationTrack(track: ScoreTrack, duration: number) {
  if (track.version !== CALIBRATION_PROCESSING.detector ||
      track.preprocessingVersion !== CALIBRATION_PROCESSING.preprocessing ||
      track.frameSeconds !== CALIBRATION_PROCESSING.settings.frameSeconds ||
      !Number.isFinite(track.totalDuration) || track.totalDuration <= 0 ||
      Math.abs(track.totalDuration - duration) > 0.05 ||
      !Number.isFinite(track.intensityReference) || track.intensityReference < 0 ||
      track.scores.length !== Math.ceil(track.totalDuration / track.frameSeconds) ||
      track.scores.some(score => !Number.isFinite(score) || score < 0)) {
    throw new Error('Invalid calibration score track.');
  }
}

function overlayManualSample(labels: ManualInterval[], sample: ManualInterval, candidates: ManualInterval[]) {
  const intervals: Array<ManualInterval & { source: 'manual' | 'automatic' }> =
    labels.map(interval => ({ ...interval, source: 'manual' }));
  for (const region of candidates) {
    if (region.start < sample.start) {
      intervals.push({ start: region.start, end: Math.min(region.end, sample.start), source: 'automatic' });
    }
    if (region.end > sample.end) {
      intervals.push({ start: Math.max(region.start, sample.end), end: region.end, source: 'automatic' });
    }
  }
  return intervals.sort((a, b) => a.start - b.start);
}

function regionIntensity(track: ScoreTrack, interval: ManualInterval) {
  let peak = 0;
  const firstFrame = Math.floor(interval.start / track.frameSeconds);
  const endFrame = Math.min(track.scores.length, Math.ceil(interval.end / track.frameSeconds));
  for (let index = firstFrame; index < endFrame; index++) {
    if (index * track.frameSeconds < interval.end && (index + 1) * track.frameSeconds > interval.start) {
      peak = Math.max(peak, track.scores[index]);
    }
  }
  return Number(Math.min(1, peak / Math.max(track.intensityReference * 1.75, 1e-6)).toFixed(4));
}

export function previewCalibratedRegions(args: {
  duration: number;
  sample: ManualInterval;
  intervals: ManualInterval[];
  track: ScoreTrack;
  threshold: number;
}) {
  const { track, threshold, duration, sample, intervals } = args;
  const candidates = detectRegions(track, threshold, duration);
  return overlayManualSample(intervals, sample, candidates).map(interval => ({
    ...interval, intensityScore: regionIntensity(track, interval),
  }));
}

export function calibratedRegions(args: {
  duration: number;
  sampleStart?: number;
  intervals: ManualInterval[];
  track: ScoreTrack;
  lines: Array<{ ordinal: number; startSeconds: number; endSeconds: number }>;
}) {
  const sample = validateManualSample(args.duration, args.intervals, args.sampleStart);
  const { track } = args;
  validateCalibrationTrack(track, args.duration);

  const fitted = args.duration > CALIBRATION_SAMPLE_SECONDS
    ? fitThreshold(track, args.duration, sample, args.intervals)
    : null;
  const intervals = overlayManualSample(args.intervals, sample, fitted?.candidates ?? []);
  const fit = fitted && {
    threshold: fitted.threshold,
    f05: fitted.f05,
    precision: fitted.precision,
    candidateCount: intervals.length - args.intervals.length,
  };

  const regions = (args.lines.length ? intervals : []).map((interval, ordinal) => {
    const line = args.lines.find(line => line.startSeconds <= interval.start && line.endSeconds > interval.start);
    if (!line) throw new Error('Transcript ownership is unavailable.');
    return {
      ordinal, lineOrdinal: line.ordinal, source: interval.source,
      startSeconds: interval.start, endSeconds: interval.end,
      intensityScore: regionIntensity(track, interval),
    };
  });

  return { regions, fit };
}
