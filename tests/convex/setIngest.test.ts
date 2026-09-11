import { describe, expect, it } from "vitest";

import { internal } from "../../convex/_generated/api";
import { createConvexTest } from "./test.setup";

describe("set ingest attempts", () => {
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
