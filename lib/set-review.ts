import type { TranscriptSentence } from "./setAnalysis";

export function formatReviewTime(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
