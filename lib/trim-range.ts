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

export function getPlaybackWindowForSource(
  provider: "mux" | "bunny" | null,
  trimRangeStartSeconds: number,
  trimRangeEndSeconds: number,
) {
  if (provider === "mux") {
    return {
      startSeconds: trimRangeStartSeconds,
      endSeconds: trimRangeEndSeconds,
    };
  }

  return {
    startSeconds: 0,
    endSeconds: getClipDurationSeconds(
      trimRangeStartSeconds,
      trimRangeEndSeconds,
    ),
  };
}

export function getSourceTimeFromClipTime(
  clipSeconds: number,
  provider: "mux" | "bunny" | null,
  trimRangeStartSeconds: number,
  trimRangeEndSeconds: number,
) {
  const playbackWindow = getPlaybackWindowForSource(
    provider,
    trimRangeStartSeconds,
    trimRangeEndSeconds,
  );
  const clipDurationSeconds = getClipDurationSeconds(
    trimRangeStartSeconds,
    trimRangeEndSeconds,
  );
  const clampedClipSeconds = clampTime(clipSeconds, 0, clipDurationSeconds);

  return clampTime(
    playbackWindow.startSeconds + clampedClipSeconds,
    playbackWindow.startSeconds,
    playbackWindow.endSeconds,
  );
}

export function getClipTimeFromSourceTime(
  sourceSeconds: number,
  provider: "mux" | "bunny" | null,
  trimRangeStartSeconds: number,
  trimRangeEndSeconds: number,
) {
  const playbackWindow = getPlaybackWindowForSource(
    provider,
    trimRangeStartSeconds,
    trimRangeEndSeconds,
  );

  return Math.max(
    0,
    clampTime(
      sourceSeconds,
      playbackWindow.startSeconds,
      playbackWindow.endSeconds,
    ) - playbackWindow.startSeconds,
  );
}
