export type TimedWord = { word: string; start: number; end: number };

type SpokenLine = {
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  wordCount: number;
};

export type AcceptedLaugh = {
  startSeconds: number;
  endSeconds: number;
  intensityScore: number;
};

export function joinWords(words: string[]) {
  let result = "";
  for (const word of words) {
    if (/^[,.;!?)]/.test(word) || result.endsWith("(") || result.length === 0) {
      result += word;
    } else {
      result += ` ${word}`;
    }
  }
  return result.trim();
}

const compact = (text: string) => text.replace(/\s/g, "");

function alignWords(lines: SpokenLine[], words: TimedWord[]) {
  // Match the entire saved transcript in order before treating gaps as silence.
  if (!words.length || words.some((word, index) =>
    !word.word.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
    word.start < 0 || word.end < word.start || (index > 0 && word.start < words[index - 1].start),
  )) return null;

  let cursor = 0;
  const matched = [];
  for (const [index, line] of lines.entries()) {
    const target = compact(line.text);
    const first = cursor;
    let text = "";
    while (cursor < words.length && text.length < target.length) {
      const word = words[cursor++];
      const nextStart = lines[index + 1]?.startSeconds ?? line.endSeconds;
      // The original seeding rounded Line boundaries to milliseconds.
      if (word.start < line.startSeconds - 0.0005 || word.start >= nextStart + 0.0005) return null;
      text += compact(word.word);
    }
    if (text !== target) return null;
    matched.push(words.slice(first, cursor));
  }
  return cursor === words.length ? matched : null;
}

export function mergeLaugh(first: AcceptedLaugh, second: AcceptedLaugh) {
  return {
    startSeconds: first.startSeconds,
    endSeconds: Math.max(first.endSeconds, second.endSeconds),
    intensityScore: Math.max(first.intensityScore, second.intensityScore),
  };
}

export function splitLinesForLaughs(
  savedLines: SpokenLine[],
  acceptedLaughs: AcceptedLaugh[],
  words: TimedWord[],
  duration: number,
) {
  const lines = savedLines.filter((line) => line.text.trim());
  if (!lines.length) return [];

  const aligned = alignWords(lines, words);
  const laughs: AcceptedLaugh[] = [];
  let wordIndex = 0;
  for (const laugh of [...acceptedLaughs].sort((a, b) => a.startSeconds - b.startSeconds)) {
    const previous = laughs.at(-1);
    if (previous && aligned) {
      while (wordIndex < words.length && words[wordIndex].start <= previous.startSeconds) wordIndex++;
    }
    if (previous && aligned && (words[wordIndex]?.start ?? Infinity) > laugh.startSeconds) {
      laughs[laughs.length - 1] = mergeLaugh(previous, laugh);
    } else {
      laughs.push(laugh);
    }
  }

  const result: Array<{
    sourceOrdinal: number;
    startSeconds: number;
    endSeconds: number;
    text: string;
    wordCount: number;
    laugh?: AcceptedLaugh;
  }> = [];
  let laughIndex = 0;
  for (const [index, line] of lines.entries()) {
    const end = lines[index + 1]?.startSeconds ?? duration;
    let start = index === 0 ? 0 : line.startSeconds;
    let remainingWords = aligned?.[index];
    let laugh: AcceptedLaugh | undefined;
    let split = false;

    while (laughIndex < laughs.length && (laughs[laughIndex].startSeconds < end || index === lines.length - 1)) {
      const next = laughs[laughIndex++];
      if (!laugh) {
        laugh = next;
        continue;
      }

      // Prefer the first word after the previous laugh ends, up to the next laugh.
      // An overlap can instead require a boundary at the next laugh's start.
      const afterLaugh = remainingWords?.find(({ start }) => start >= laugh!.endSeconds && start <= next.startSeconds);
      let boundary = afterLaugh?.start ?? next.startSeconds;
      let cut = remainingWords?.findIndex((word) => word.start >= boundary) ?? -1;
      if (cut === -1 && remainingWords) {
        // Keep the last fragment spoken when the next laugh starts after its words.
        const lastStart = remainingWords.at(-1)?.start ?? 0;
        if (lastStart > laugh.startSeconds && lastStart <= next.startSeconds) {
          boundary = lastStart;
          cut = remainingWords.findIndex((word) => word.start >= boundary);
        }
      }

      if (!remainingWords || cut <= 0 || boundary <= start) {
        laugh = mergeLaugh(laugh, next);
        continue;
      }

      const before = remainingWords.slice(0, cut);
      result.push({ sourceOrdinal: line.ordinal, startSeconds: start, endSeconds: boundary,
        text: joinWords(before.map((word) => word.word)), wordCount: before.length, laugh });
      remainingWords = remainingWords.slice(cut);
      start = boundary;
      laugh = next;
      split = true;
    }

    result.push({
      sourceOrdinal: line.ordinal,
      startSeconds: start,
      endSeconds: end,
      text: split ? joinWords(remainingWords!.map((word) => word.word)) : line.text,
      wordCount: split ? remainingWords!.length : line.wordCount,
      laugh,
    });
  }
  return result;
}
