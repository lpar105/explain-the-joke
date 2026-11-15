import type { TranscriptSentence } from "./setAnalysis";
import { clampTime } from "./trim-range";

export function timingWindowAt(playhead: number, duration: number, length: number, origin: number) {
  // Treat sub-microsecond differences at a page boundary as the same playback time.
  const pageAt = (time: number) => {
    const page = (time - origin) / length;
    const nearest = Math.round(page);
    return Math.abs(page - nearest) < 1e-6 / length ? nearest : page;
  };
  const first = Math.floor(pageAt(0));
  const last = Math.max(first, Math.ceil(pageAt(duration)) - 1);
  const page = clampTime(Math.floor(pageAt(playhead)), first, last);
  const start = origin + page * length;
  return { start, end: origin + (page + 1) * length, hasPrevious: page > first, hasNext: page < last };
}

export function zoomTimingWindow(playhead: number, start: number, oldLength: number, newLength: number) {
  const playheadFraction = clampTime((playhead - start) / oldLength, 0, 1);
  return { length: newLength, origin: playhead - playheadFraction * newLength };
}

export function formatReviewTime(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function laughIntensityColor(score: number) {
  return `color-mix(in srgb, var(--tf-accent-red) ${30 + 70 * score}%, var(--tf-paper-alt))`;
}

export function reviewLaughs(lines: TranscriptSentence[]) {
  return lines.flatMap((line) => line.laughs.map((laugh) => ({ laugh, line })))
    .sort((a, b) => a.laugh.start_time - b.laugh.start_time || a.laugh.index - b.laugh.index);
}

export function strongestLines(lines: TranscriptSentence[]) {
  return [...lines].sort((a, b) =>
    Number(b.laughs.length > 0) - Number(a.laughs.length > 0) ||
    (b.laughs.length && a.laughs.length ? b.laugh_intensity_score - a.laugh_intensity_score : 0) ||
    a.start - b.start || a.index - b.index,
  );
}

export function activeReviewLine(lines: TranscriptSentence[], time: number) {
  return lines.findLast((line) => line.start <= time) ?? lines[0];
}

export function laughNeighbors(
  regions: ReturnType<typeof reviewLaughs>,
  time: number,
  navigationTarget: (typeof regions)[number] | null,
) {
  const active = navigationTarget
    ? regions.indexOf(navigationTarget)
    : regions.findLastIndex(({ laugh }) => laugh.start_time <= time && time < laugh.end_time);
  if (active >= 0) return { previous: regions[active - 1], next: regions[active + 1] };

  const previous = regions.reduce<(typeof regions)[number] | undefined>((latest, region) => {
    if (region.laugh.end_time > time || (latest && latest.laugh.end_time > region.laugh.end_time)) {
      return latest;
    }
    return region;
  }, undefined);
  return { previous, next: regions.find(({ laugh }) => laugh.start_time > time) };
}
