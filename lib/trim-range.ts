export function clampTime(value: number, min: number, max: number) {
  if (min > max) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export function getClipDurationSeconds(
  trimRangeStartSeconds: number,
  trimRangeEndSeconds: number,
) {
  return Math.max(0, trimRangeEndSeconds - trimRangeStartSeconds);
}

export function getClipRelativeTime(
  absoluteSeconds: number,
  trimRangeStartSeconds: number,
  trimRangeEndSeconds: number,
) {
  const clampedAbsoluteSeconds = clampTime(
    absoluteSeconds,
    trimRangeStartSeconds,
    trimRangeEndSeconds,
  );

  return Math.max(0, clampedAbsoluteSeconds - trimRangeStartSeconds);
}
