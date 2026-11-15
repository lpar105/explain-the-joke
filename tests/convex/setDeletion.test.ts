import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import { createConvexTest } from "./test.setup";

async function seedSetGraph(t = createConvexTest(), name = "delete") {
  const ids = await t.run(async (ctx) => {
    const setId = await ctx.db.insert("sets", {
      ownerTokenIdentifier: "clerk:owner",
      setStatus: "playable",
      title: name,
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
      playbackId: `playback_${name}`,
      provider: "mux",
      providerAssetId: `asset_${name}`,
      providerUploadId: `upload_${name}`,
      setId,
    });
    const uploadSessionId = await ctx.db.insert("uploadSessions", {
      confirmedSetId: setId,
      muxAssetId: `asset_${name}`,
      muxPlaybackId: `playback_${name}`,
      muxUploadId: `upload_${name}`,
      originalFileName: "delete.mp4",
      ownerTokenIdentifier: "clerk:owner",
      status: "confirmed",
    });
    return { attemptId, breakdownId, ingestJobId, setId, uploadSessionId };
  });

  return { ids, t };
}

describe("Set deletion", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    await expect(asOwner.mutation(api.setDeletion.requestDeletion, { setId: ids.setId })).resolves.toBeNull();

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

  it("deletes only the target Set graph in bounded batches and leaves no ledger", async () => {
    const { ids, t } = await seedSetGraph();
    await seedSetGraph(t, "keep");
    const getGraphs = () => t.run(async (ctx) => ({
      artifacts: await ctx.db.query("ingestArtifacts").take(3),
      attempts: await ctx.db.query("ingestStepAttempts").take(3),
      breakdowns: await ctx.db.query("breakdowns").take(3),
      jobs: await ctx.db.query("ingestJobs").take(3),
      laughs: await ctx.db.query("laughRegions").take(3),
      lines: await ctx.db.query("lines").take(3),
      playback: await ctx.db.query("playbackSources").take(3),
      sets: await ctx.db.query("sets").take(3),
      uploads: await ctx.db.query("uploadSessions").take(3),
    }));
    const before = await getGraphs();
    expect(Object.values(before).map(rows => rows.length)).toEqual(Array(9).fill(2));

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

    const after = await getGraphs();
    for (const table of Object.keys(before) as Array<keyof typeof before>) {
      expect(after[table]).toEqual(before[table].slice(1));
    }
    expect(await t.run(ctx => ctx.db.query("setDeletionJobs").take(1))).toEqual([]);
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
    vi.useFakeTimers();
    const { ids, t } = await seedSetGraph();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "owner",
      tokenIdentifier: "clerk:owner",
    });
    await t.run(ctx => ctx.db.patch(ids.attemptId, { status: "running" }));
    const lateKey = `set-ingest/${ids.setId}/${ids.breakdownId}/late.json`;
    await asOwner.mutation(api.setDeletion.requestDeletion, { setId: ids.setId });

    await expect(
      t.mutation(internal.setIngest.reportModalStepResult, {
        artifacts: [
          {
            fileName: "late.json",
            isCanonical: true,
            key: lateKey,
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
    const scheduled = await t.run(ctx => ctx.db.system.query("_scheduled_functions").take(10));
    expect(scheduled).toContainEqual(expect.objectContaining({
      name: "setDeletion:cleanupLateArtifacts",
      args: [{ keys: [lateKey] }],
    }));
  });
});
