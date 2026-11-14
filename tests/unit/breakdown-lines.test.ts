import { describe, expect, it } from "vitest";
import { splitLinesForLaughs } from "../../lib/breakdown-lines";

const region = (startSeconds: number, endSeconds: number, intensityScore: number) => ({
  startSeconds, endSeconds, intensityScore,
});
const word = (word: string, start: number) => ({ word, start, end: start + 0.05 });
const line = (text: string, ordinal = 1, startSeconds = 0, endSeconds = 8) => ({
  text, ordinal, startSeconds, endSeconds, wordCount: text.trim().split(/\s+/).length,
});

describe("persisted spoken Lines", () => {
  it("splits at the intervening word and preserves the full accepted regions", () => {
    const first = region(2, 2.4, 0.9);
    const second = region(3.1, 5.3, 0.4);
    const result = splitLinesForLaughs(
      [line("First second", 1, 0, 4), line("Third", 2, 4, 8)],
      [first, second],
      [word("First", 1), word("second", 2.6), word("Third", 4)],
      8,
    );
    expect(result).toMatchObject([
      { startSeconds: 0, endSeconds: 2.6, text: "First", laugh: first },
      { startSeconds: 2.6, endSeconds: 4, text: "second", laugh: second },
      { startSeconds: 4, endSeconds: 8, text: "Third", laugh: undefined },
    ]);
  });

  it("uses the Line that starts at the shared boundary", () => {
    const first = region(2, 5, 0.9);
    const second = region(4, 6, 0.4);
    const result = splitLinesForLaughs([line("First", 1, 0, 4), line("Second", 2, 4)], [first, second],
      [word("First", 1), word("Second", 4)], 8);
    expect(result.map(item => item.laugh)).toEqual([first, second]);
  });

  it("merges confirmed silence and uses the highest intensity and latest end", () => {
    const result = splitLinesForLaughs([line("First second")], [region(2, 2.4, 0.9), region(3.1, 5.3, 0.4)],
      [word("First", 1), word("second", 6)], 8);
    expect(result).toMatchObject([{ text: "First second", laugh: region(2, 5.3, 0.9) }]);
  });

  it("preserves saved words with unreliable timings and discards laughs on a wordless Set", () => {
    const laughs = [region(2, 2.4, 0.9), region(3.1, 5.3, 0.4)];
    const result = splitLinesForLaughs([line("Saved text")], laughs, [word("Different", 3)], 8);
    expect(result).toMatchObject([{ text: "Saved text", laugh: region(2, 5.3, 0.9) }]);
    expect(splitLinesForLaughs([line(" ")], laughs, [], 8)).toEqual([]);
  });

  it("keeps both fragments spoken when an overlapping laugh ends after the next starts", () => {
    const laughs = [region(2, 5, 0.9), region(3.1, 5.3, 0.4)];
    const result = splitLinesForLaughs([line("First second")], laughs, [word("First", 1), word("second", 2.9)], 8);
    expect(result).toMatchObject([
      { text: "First", endSeconds: 2.9, laugh: laughs[0] },
      { text: "second", startSeconds: 2.9, laugh: laughs[1] },
    ]);
  });
});
