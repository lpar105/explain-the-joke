import { describe, expect, it } from "vitest";

import { normalizeLaughRegionsAfterLines } from "../../lib/set-ingest-orchestration";

describe("set ingest orchestration", () => {
  it("waits for normalized lines before normalizing laugh regions", async () => {
    let releaseLineNormalization!: () => void;
    const lineNormalizationGate = new Promise<void>((resolve) => {
      releaseLineNormalization = resolve;
    });
    const events: string[] = [];

    events.push("lines-started");
    const linesReady = lineNormalizationGate.then(() => {
      events.push("lines-ready");
    });
    events.push("laugh-candidates-ready");

    const analysis = normalizeLaughRegionsAfterLines({
      linesReady,
      normalizeLaughRegions: async () => {
        events.push("laugh-regions-normalized");
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["lines-started", "laugh-candidates-ready"]);

    releaseLineNormalization();
    await analysis;

    expect(events).toEqual([
      "lines-started",
      "laugh-candidates-ready",
      "lines-ready",
      "laugh-regions-normalized",
    ]);
  });
});
