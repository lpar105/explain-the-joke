import { describe, expect, it } from "vitest";

import { internal } from "../../convex/_generated/api";
import { createConvexTest } from "./test.setup";

describe("set ingest attempts", () => {
  it("publishes a canonical thumbnail on the set as soon as Modal returns it", async () => {
    const t = createConvexTest();

    const ids = await t.run(async (ctx) => {
      const setId = await ctx.db.insert("sets", {
        ownerTokenIdentifier: "clerk:user_123",
        setStatus: "playable",
        title: "Thumbnail Test",
        trimRangeEndSeconds: 60,
        trimRangeStartSeconds: 5,
      });
      const breakdownId = await ctx.db.insert("breakdowns", {
        editability: "locked",
        laughSeedingState: "pending",
        lineSeedingState: "pending",
        setId,
      });
      const ingestJobId = await ctx.db.insert("ingestJobs", {
        breakdownId,
        setId,
        status: "running",
      });

      return { ingestJobId, setId };
    });

    const started = await t.mutation(internal.setIngest.beginStepAttempt, {
      ingestJobId: ids.ingestJobId,
      runner: "modal",
      stepName: "prepareRetainedMedia",
    });
    const thumbnailStorageKey =
      "set-ingest/set_123/breakdown_123/prepareRetainedMedia/attempt-1/thumbnail.jpg";

    await t.mutation(internal.setIngest.reportModalStepResult, {
      artifacts: [
        {
          contentType: "image/jpeg",
          fileName: "thumbnail.jpg",
          isCanonical: true,
          key: thumbnailStorageKey,
          kind: "thumbnail",
          size: 12_345,
        },
      ],
      attemptNumber: started.attemptNumber,
      ingestJobId: ids.ingestJobId,
      outcome: "succeeded",
      stepName: "prepareRetainedMedia",
    });

    const set = await t.run((ctx) => ctx.db.get(ids.setId));
    expect(set?.thumbnailStorageKey).toBe(thumbnailStorageKey);
  });

  it("finalizes a Modal spawn failure instead of leaving the attempt running", async () => {
    const t = createConvexTest();

    const ids = await t.run(async (ctx) => {
      const setId = await ctx.db.insert("sets", {
        ownerTokenIdentifier: "clerk:user_123",
        setStatus: "playable",
        title: "Spawn Failure",
        trimRangeEndSeconds: 120,
        trimRangeStartSeconds: 5,
      });
      const breakdownId = await ctx.db.insert("breakdowns", {
        editability: "locked",
        laughSeedingState: "pending",
        lineSeedingState: "pending",
        setId,
      });
      const ingestJobId = await ctx.db.insert("ingestJobs", {
        breakdownId,
        setId,
        status: "running",
      });

      return { breakdownId, ingestJobId, setId };
    });

    const started = await t.mutation(internal.setIngest.beginStepAttempt, {
      ingestJobId: ids.ingestJobId,
      runner: "modal",
      stepName: "prepareRetainedMedia",
      workflowEventName: "prepareRetainedMedia:1",
    });

    await t.mutation(internal.setIngest.failStepAttempt, {
      attemptId: started.attemptId,
      failureCode: "modal_spawn_failed",
      failureDetail: "Missing SET_INGEST_CALLBACK_BASE_URL in the Convex environment.",
    });

    const attempt = await t.run(async (ctx) => {
      return ctx.db.get(started.attemptId);
    });

    expect(attempt).toMatchObject({
      _id: started.attemptId,
      attemptNumber: 1,
      failureCode: "modal_spawn_failed",
      failureDetail:
        "Missing SET_INGEST_CALLBACK_BASE_URL in the Convex environment.",
      runner: "modal",
      status: "failed",
      stepName: "prepareRetainedMedia",
      workflowEventName: "prepareRetainedMedia:1",
    });
    expect(attempt).not.toHaveProperty("modalFunctionCallId");
    expect(typeof attempt?.finishedAt).toBe("number");
  });
});

it("backfills a legacy Breakdown once and preserves its distinct timed Laugh Regions", async () => {
  const t = createConvexTest();
  const breakdownId = await t.run(async (ctx) => {
    const setId = await ctx.db.insert("sets", {
      ownerTokenIdentifier: "clerk:legacy",
      setStatus: "playable",
      title: "Legacy Set",
      trimRangeStartSeconds: 12,
      trimRangeEndSeconds: 20,
    });
    const breakdownId = await ctx.db.insert("breakdowns", {
      setId,
      editability: "editable",
      lineSeedingState: "ready",
      laughSeedingState: "ready",
    });
    const lineId = await ctx.db.insert("lines", {
      breakdownId, ordinal: 1, startSeconds: 0, endSeconds: 8, text: "First second",
      wordCount: 2, laughCount: 2, laughIntensityScore: 0.94,
    });
    await ctx.db.insert("laughRegions", {
      breakdownId, lineId, ordinal: 1, startSeconds: 2, endSeconds: 2.4, intensityScore: 0.9,
    });
    await ctx.db.insert("laughRegions", {
      breakdownId, lineId, ordinal: 2, startSeconds: 3.1, endSeconds: 5.3, intensityScore: 0.4,
    });
    return breakdownId;
  });

  const args = { breakdownId, words: [[
    { word: "First", start: 1, end: 1.4 },
    { word: "second", start: 2.6, end: 2.9 },
  ]] };
  expect(await t.mutation(internal.setIngest.backfillSpokenLineBreakdown, args)).toBe(true);
  expect(await t.mutation(internal.setIngest.backfillSpokenLineBreakdown, args)).toBe(false);
  const saved = await t.run(async (ctx) => ({
    lines: await ctx.db.query("lines").collect(),
    laughs: await ctx.db.query("laughRegions").collect(),
  }));
  expect(saved.lines).toMatchObject([
    { text: "First", startSeconds: 0, endSeconds: 2.6, laughCount: 1, laughIntensityScore: 0.9 },
    { text: "second", startSeconds: 2.6, endSeconds: 8, laughCount: 1, laughIntensityScore: 0.4 },
  ]);
  expect(saved.laughs).toMatchObject([
    { lineId: saved.lines[0]._id, startSeconds: 2, endSeconds: 2.4, intensityScore: 0.9 },
    { lineId: saved.lines[1]._id, startSeconds: 3.1, endSeconds: 5.3, intensityScore: 0.4 },
  ]);
});
