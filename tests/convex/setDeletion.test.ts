import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import { createConvexTest } from "./test.setup";

async function seedSetGraph() {
  const t = createConvexTest();
  const ids = await t.run(async (ctx) => {
    const setId = await ctx.db.insert("sets", {
      ownerTokenIdentifier: "clerk:owner",
      setStatus: "playable",
      title: "Delete Me",
      trimRangeEndSeconds: 60,
      trimRangeStartSeconds: 0,
    });
    const breakdownId = await ctx.db.insert("breakdowns", {
      editability: "editable",
      laughSeedingState: "ready",
      lineSeedingState: "ready",
      setId,
    });
    await ctx.db.patch(setId, { currentBreakdownId: breakdownId });
    const ingestJobId = await ctx.db.insert("ingestJobs", {
      breakdownId,
      setId,
      status: "completed",
    });
    const attemptId = await ctx.db.insert("ingestStepAttempts", {
      attemptNumber: 1,
      ingestJobId,
      runner: "modal",
      startedAt: Date.now(),
      status: "succeeded",
      stepName: "prepareRetainedMedia",
    });
    await ctx.db.insert("ingestArtifacts", {
      createdByAttemptId: attemptId,
      fileName: "playback.mp4",
      ingestJobId,
      isCanonical: true,
      kind: "playbackMedia",
      path: `set-ingest/${setId}/${breakdownId}/prepareRetainedMedia/attempt-1/playback.mp4`,
      stepName: "prepareRetainedMedia",
    });
    const lineId = await ctx.db.insert("lines", {
      breakdownId,
      endSeconds: 5,
      laughCount: 1,
      laughIntensityScore: 0.8,
      ordinal: 1,
      startSeconds: 0,
      text: "A line",
      wordCount: 2,
    });
    await ctx.db.insert("laughRegions", {
      breakdownId,
      endSeconds: 4,
      intensityScore: 0.8,
      lineId,
      ordinal: 1,
      startSeconds: 3,
    });
    await ctx.db.insert("playbackSources", {
      isActive: true,
      kind: "temporary",
      playbackId: "playback_delete",
      provider: "mux",
      providerAssetId: "asset_delete",
      providerUploadId: "upload_delete",
      setId,
    });
    const uploadSessionId = await ctx.db.insert("uploadSessions", {
      confirmedSetId: setId,
      muxAssetId: "asset_delete",
      muxPlaybackId: "playback_delete",
      muxUploadId: "upload_delete",
      originalFileName: "delete.mp4",
      ownerTokenIdentifier: "clerk:owner",
      status: "confirmed",
    });
    return { breakdownId, ingestJobId, setId, uploadSessionId };
  });

  return { ids, t };
}

describe("Set deletion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts deletion only from the owner and removes the Set immediately", async () => {
    const { ids, t } = await seedSetGraph();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "owner",
      tokenIdentifier: "clerk:owner",
    });
    const asOtherViewer = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "other",
      tokenIdentifier: "clerk:other",
    });

    await expect(
      asOtherViewer.mutation(api.setDeletion.requestDeletion, { setId: ids.setId }),
    ).rejects.toBeInstanceOf(ConvexError);

    await asOwner.mutation(api.setDeletion.requestDeletion, { setId: ids.setId });

    expect(await asOwner.query(api.sets.listForViewer)).toEqual([]);
    const state = await t.run(async (ctx) => ({
      job: await ctx.db
        .query("setDeletionJobs")
        .withIndex("by_setId", (q) => q.eq("setId", ids.setId))
        .unique(),
      set: await ctx.db.get(ids.setId),
    }));
    expect(state.set).toBeNull();
    expect(state.job).toMatchObject({
      setId: ids.setId,
      status: "cancelingWork",
    });
  });

  it("deletes every current Convex child in bounded batches and leaves no ledger", async () => {
    const { ids, t } = await seedSetGraph();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "owner",
      tokenIdentifier: "clerk:owner",
    });
    await asOwner.mutation(api.setDeletion.requestDeletion, { setId: ids.setId });

    const deletionJobId = await t.run(async (ctx) => {
      const job = await ctx.db
        .query("setDeletionJobs")
        .withIndex("by_setId", (q) => q.eq("setId", ids.setId))
        .unique();
      if (job === null) throw new Error("Missing deletion job");
      return job._id;
    });

    for (let batch = 0; batch < 20; batch += 1) {
      const result = await t.mutation(internal.setDeletion.deleteDataBatch, {
        deletionJobId,
      });
      if (result.done) break;
    }
    await t.mutation(internal.setDeletion.finishDeletion, { deletionJobId });

    const remaining = await t.run(async (ctx) => ({
      artifacts: await ctx.db.query("ingestArtifacts").take(1),
      attempts: await ctx.db.query("ingestStepAttempts").take(1),
      breakdowns: await ctx.db.query("breakdowns").take(1),
      jobs: await ctx.db.query("ingestJobs").take(1),
      laughs: await ctx.db.query("laughRegions").take(1),
      lines: await ctx.db.query("lines").take(1),
      playback: await ctx.db.query("playbackSources").take(1),
      ledger: await ctx.db.query("setDeletionJobs").take(1),
      uploads: await ctx.db.query("uploadSessions").take(1),
    }));
    expect(remaining).toEqual({
      artifacts: [],
      attempts: [],
      breakdowns: [],
      jobs: [],
      laughs: [],
      lines: [],
      playback: [],
      ledger: [],
      uploads: [],
    });
  });

  it("deletes Mux assets, the Bunny prefix, and the Bunny CDN cache", async () => {
    const { ids, t } = await seedSetGraph();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "owner",
      tokenIdentifier: "clerk:owner",
    });
    vi.stubEnv("MUX_TOKEN_ID", "mux-token");
    vi.stubEnv("MUX_TOKEN_SECRET", "mux-secret");
    vi.stubEnv("BUNNY_STORAGE_ZONE", "test-zone");
    vi.stubEnv("BUNNY_API_KEY", "storage-key");
    vi.stubEnv("BUNNY_CDN_HOSTNAME", "cdn.example.test");
    vi.stubEnv("BUNNY_CDN_API_KEY", "cdn-key");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        const url = String(input);
        if (url.includes("/video/v1/uploads/")) {
          return new Response(null, { status: 404 });
        }
        if (url.includes("/video/v1/assets/")) {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 200 });
      },
    );

    await asOwner.mutation(api.setDeletion.requestDeletion, { setId: ids.setId });
    const deletionJobId = await t.run(async (ctx) => {
      const job = await ctx.db
        .query("setDeletionJobs")
        .withIndex("by_setId", (q) => q.eq("setId", ids.setId))
        .unique();
      if (job === null) throw new Error("Missing deletion job");
      return job._id;
    });

    await t.action(internal.setDeletion.runCleanup, { deletionJobId });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.mux.com/video/v1/assets/asset_delete",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/test-zone/set-ingest/${ids.setId}/`),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.bunny.net/purge?"),
      expect.objectContaining({
        headers: { AccessKey: "cdn-key" },
        method: "POST",
      }),
    );
    const job = await t.run((ctx) => ctx.db.get(deletionJobId));
    expect(job?.status).toBe("deletingData");
  });

  it("ignores a late Modal callback after deletion begins", async () => {
    const { ids, t } = await seedSetGraph();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "owner",
      tokenIdentifier: "clerk:owner",
    });
    await asOwner.mutation(api.setDeletion.requestDeletion, { setId: ids.setId });

    await expect(
      t.mutation(internal.setIngest.reportModalStepResult, {
        artifacts: [
          {
            fileName: "late.json",
            isCanonical: true,
            key: `set-ingest/${ids.setId}/${ids.breakdownId}/late.json`,
            kind: "transcriptRaw",
          },
        ],
        attemptNumber: 1,
        ingestJobId: ids.ingestJobId,
        outcome: "succeeded",
        stepName: "prepareRetainedMedia",
      }),
    ).resolves.toBeNull();

    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("ingestArtifacts")
        .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ids.ingestJobId))
        .take(10),
    );
    expect(artifacts).toHaveLength(1);
  });
});
