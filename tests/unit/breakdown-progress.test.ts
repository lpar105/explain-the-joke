import { describe, expect, it } from "vitest";

import {
  getEffectivePathState,
  getOverallProgressLabel,
  getTrackLabel,
  isPathProcessing,
} from "../../lib/breakdown-progress";

describe("breakdown progress", () => {
  it("turns an unfinished path into a failure when the overall ingest failed", () => {
    expect(getEffectivePathState("pending", "failed")).toBe("failed");
    expect(getEffectivePathState("running", "failed")).toBe("failed");
    expect(getEffectivePathState("ready", "failed")).toBe("ready");
  });

  it("uses product language for each genuine path state", () => {
    expect(getTrackLabel("transcript", "pending")).toBe("Transcript queued");
    expect(getTrackLabel("transcript", "running")).toBe(
      "Building transcript",
    );
    expect(getTrackLabel("laughs", "running")).toBe(
      "Finding audience reactions",
    );
    expect(getTrackLabel("laughs", "retrying")).toBe("Trying again…");
  });

  it("describes partial success without hiding a degraded laugh analysis", () => {
    expect(getOverallProgressLabel("ready", "running")).toBe(
      "Finishing breakdown",
    );
    expect(getOverallProgressLabel("ready", "failed")).toBe(
      "Transcript ready",
    );
    expect(getOverallProgressLabel("failed", "pending")).toBe(
      "Breakdown unavailable",
    );
  });

  it("only marks unfinished states as processing", () => {
    expect(isPathProcessing("retrying")).toBe(true);
    expect(isPathProcessing("ready")).toBe(false);
    expect(isPathProcessing("failed")).toBe(false);
  });
});
