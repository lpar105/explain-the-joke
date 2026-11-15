import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { createConvexTest } from "./test.setup";

// Viewer and playback tests start from an already saved Set.
async function markCalibrationSaved(
  t: ReturnType<typeof createConvexTest>,
  uploadSessionId: Id<"uploadSessions">,
  setId: Id<"sets">,
) {
  await t.run(async ctx => {
    await ctx.db.patch(setId, { provisional: false });
    await ctx.db.patch(uploadSessionId, { status: "confirmed" });
  });
}


async function registerUploadFixture(
  t: ReturnType<typeof createConvexTest>,
  muxUploadId: string,
  originalFileName: string,
) {
  const session = await t.mutation(internal.sets.startUploadSession, {
    ownerTokenIdentifier: "clerk:user_123",
    muxUploadId,
    originalFileName,
  });
  if (!session) throw new Error("Duplicate upload fixture.");
  return session;
}

async function expectMutationToFailWithCode(
  operation: Promise<unknown>,
  code: string,
) {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data).toMatchObject({ code });
    return;
  }

  throw new Error(`Expected mutation to fail with code "${code}".`);
}

describe("sets", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("registers only the upload Mux created for the authenticated owner", async () => {
    const t = createConvexTest();
    const owner = t.withIdentity({ tokenIdentifier: "clerk:owner" });
    const other = t.withIdentity({ tokenIdentifier: "clerk:other" });
    const args = { originalFileName: "set.mp4", corsOrigin: "https://example.test" };
    vi.stubEnv("MUX_TOKEN_ID", "test-token");
    vi.stubEnv("MUX_TOKEN_SECRET", "test-secret");
    const fetchMux = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      data: { id: "upload-1", url: "https://example.test/upload" },
    }));

    try {
      await expectMutationToFailWithCode(t.action(api.sets.createDirectUpload, args), "auth");
      expect(fetchMux).not.toHaveBeenCalled();

      const result = await owner.action(api.sets.createDirectUpload, args);
      expect(result).toMatchObject({ uploadId: "upload-1", uploadUrl: "https://example.test/upload" });
      expect(fetchMux).toHaveBeenCalledWith("https://api.mux.com/video/v1/uploads", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cors_origin: args.corsOrigin, new_asset_settings: { playback_policy: ["public"] } }),
      }));
      await expect(other.action(api.sets.createDirectUpload, args)).rejects.toThrow();
      expect(fetchMux).toHaveBeenCalledTimes(2);
      expect(await other.query(api.sets.getUploadSessionByMuxUploadIdForViewer, { muxUploadId: result.uploadId })).toBeNull();
      expect(await owner.query(api.sets.getUploadSessionByMuxUploadIdForViewer, { muxUploadId: result.uploadId })).toMatchObject({
        _id: result.uploadSessionId, ownerTokenIdentifier: "clerk:owner", status: "waitingForUpload",
      });
    } finally {
      fetchMux.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("confirms a ready upload session into one set, one breakdown, and one active temporary playback source", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      name: "Taylor",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_123", "late-show.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_123",
      muxUploadId: "upl_123",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 240,
      muxAssetId: "asset_123",
      muxPlaybackId: "playback_123",
      muxUploadId: "upl_123",
    });

    const created = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Late Show Tape",
      trimRangeEndSeconds: 185,
      trimRangeStartSeconds: 5,
      durationSeconds: 240,
      muxAssetId: "asset_123",
      muxPlaybackId: "playback_123",
    });
    expect(created.needsCalibration).toBe(true);
    expect(await asOwner.query(api.sets.listForViewer)).toEqual([]);
    expect(await asOwner.query(api.sets.getUploadSessionForViewer, { uploadSessionId })).toMatchObject({
      status: "calibrating",
    });

    await t.run(async ctx => {
      await ctx.db.insert("ingestArtifacts", {
        ingestJobId: created.ingestJobId,
        stepName: "prepareRetainedMedia",
        kind: "retainedMedia",
        isCanonical: true,
        fileName: "retained.wav",
        path: "late-show/retained.wav",
      });
    });
    await expect(asOwner.action(api.calibration.confirm, {
      uploadSessionId, sampleStart: 120, intervals: [{ start: 119, end: 121 }],
    })).rejects.toThrow("inside the calibration sample");
    await expect(asOwner.action(api.calibration.confirm, {
      uploadSessionId, sampleStart: 120, intervals: [{ start: 121, end: 123 }],
    })).resolves.toEqual({ setId: created.setId });


    const sets = await asOwner.query(api.sets.listForViewer);

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      _id: created.setId,
      currentBreakdownId: created.breakdownId,
      setStatus: "playable",
      title: "Late Show Tape",
      trimRangeEndSeconds: 185,
      trimRangeStartSeconds: 5,
      thumbnailUrl:
        "https://image.mux.com/playback_123/thumbnail.jpg?time=6.00&width=640&fit_mode=preserve",
      activePlaybackSource: {
        _id: created.playbackSourceId,
        kind: "temporary",
        playbackId: "playback_123",
        provider: "mux",
      },
      breakdown: {
        _id: created.breakdownId,
        editability: "locked",
        laughSeedingState: "pending",
        lineSeedingState: "pending",
      },
    });
  });

  it("exposes a failed ingest job to the set viewer", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });
    const { uploadSessionId } = await registerUploadFixture(t, "upl_failed_ingest", "failed-ingest.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_failed_ingest",
      muxUploadId: "upl_failed_ingest",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 90,
      muxAssetId: "asset_failed_ingest",
      muxPlaybackId: "playback_failed_ingest",
      muxUploadId: "upl_failed_ingest",
    });

    const created = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Failed Ingest",
      trimRangeEndSeconds: 90,
      trimRangeStartSeconds: 0,
      durationSeconds: 90,
      muxAssetId: "asset_failed_ingest",
      muxPlaybackId: "playback_failed_ingest",
    });

    await markCalibrationSaved(t, uploadSessionId, created.setId);

    await t.run(async (ctx) => {
      await ctx.db.patch("ingestJobs", created.ingestJobId, {
        failedAt: Date.now(),
        status: "failed",
      });
    });

    const page = await asOwner.query(api.sets.getSetPageForViewer, {
      setId: created.setId,
    });

    expect(page).toMatchObject({
      breakdown: {
        laughSeedingState: "pending",
        lineSeedingState: "pending",
      },
      ingestJobStatus: "failed",
    });
  });

  it("hides confirmed sets from other viewers and trims renamed titles", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });
    const asOtherViewer = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_999",
      tokenIdentifier: "clerk:user_999",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_999", "tight-five.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_999",
      muxUploadId: "upl_999",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 120,
      muxAssetId: "asset_999",
      muxPlaybackId: "playback_999",
      muxUploadId: "upl_999",
    });

    const created = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Working Title",
      trimRangeEndSeconds: 90,
      trimRangeStartSeconds: 15,
      durationSeconds: 120,
      muxAssetId: "asset_999",
      muxPlaybackId: "playback_999",
    });

    await markCalibrationSaved(t, uploadSessionId, created.setId);

    await asOwner.mutation(api.sets.rename, {
      setId: created.setId,
      title: "  Tight Five  ",
    });

    const visibleToOwner = await asOwner.query(api.sets.getForViewer, {
      setId: created.setId,
    });
    const visibleToOtherViewer = await asOtherViewer.query(api.sets.getForViewer, {
      setId: created.setId,
    });

    expect(visibleToOwner?.title).toBe("Tight Five");
    expect(visibleToOtherViewer).toBeNull();
    expect(await asOwner.query(api.sets.getSetPageForViewer, { setId: created.setId })).toMatchObject({ isOwner: true });
    expect(await asOtherViewer.query(api.sets.getSetPageForViewer, { setId: created.setId })).toBeNull();
    expect(await asOwner.query(api.sets.getSetPageForViewer, { setId: "invalid" })).toBeNull();
    await expectMutationToFailWithCode(
      asOtherViewer.mutation(api.sets.rename, {
        setId: created.setId,
        title: "Should Fail",
      }),
      "not_found",
    );
  });

  it("updates the library performance date and validates date edits atomically", async () => {
    const t = createConvexTest();
    const ownerTokenIdentifier = "clerk:set_owner";
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "set_owner",
      tokenIdentifier: ownerTokenIdentifier,
    });
    const asOtherViewer = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "other_viewer",
      tokenIdentifier: "clerk:other_viewer",
    });
    const setId = await t.run((ctx) => ctx.db.insert("sets", {
      ownerTokenIdentifier,
      title: "Late Show",
      trimRangeStartSeconds: 0,
      trimRangeEndSeconds: 60,
      setStatus: "playable",
    }));

    const [original] = await asOwner.query(api.sets.listForViewer);
    expect(original.performanceDate).toBeNull();

    await asOwner.mutation(api.sets.updateDetails, {
      setId,
      performanceDate: "2024-02-29",
    });

    await expectMutationToFailWithCode(
      asOwner.mutation(api.sets.updateDetails, {
        setId,
        title: "Should stay unchanged",
        performanceDate: "2025-02-29",
      }),
      "validation",
    );
    await expectMutationToFailWithCode(
      asOtherViewer.mutation(api.sets.updateDetails, {
        setId,
        performanceDate: "2025-03-01",
      }),
      "not_found",
    );

    expect(await asOwner.query(api.sets.listForViewer)).toEqual([
      { ...original, performanceDate: "2024-02-29" },
    ]);
  });

  it("rejects invalid trim ranges without creating partial set state and leaves the upload session reusable", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_bad_trim", "bad-trim.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_bad_trim",
      muxUploadId: "upl_bad_trim",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 240,
      muxAssetId: "asset_bad_trim",
      muxPlaybackId: "playback_bad_trim",
      muxUploadId: "upl_bad_trim",
    });

    await expectMutationToFailWithCode(
      asOwner.mutation(api.sets.confirmUploadSession, {
        uploadSessionId,
        title: "Late Show Tape",
        trimRangeEndSeconds: 180,
        trimRangeStartSeconds: 180,
        durationSeconds: 240,
        muxAssetId: "asset_bad_trim",
        muxPlaybackId: "playback_bad_trim",
      }),
      "validation",
    );

    expect(await asOwner.query(api.sets.listForViewer)).toHaveLength(0);

    const created = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Late Show Tape",
      trimRangeEndSeconds: 180,
      trimRangeStartSeconds: 12,
      durationSeconds: 240,
      muxAssetId: "asset_bad_trim",
      muxPlaybackId: "playback_bad_trim",
    });

    expect(created.needsCalibration).toBe(true);
    expect(await asOwner.query(api.sets.listForViewer)).toHaveLength(0);
  });

  it("prevents duplicate sets from the same upload session", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_single_use", "single-use.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_single_use",
      muxUploadId: "upl_single_use",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 75,
      muxAssetId: "asset_single_use",
      muxPlaybackId: "playback_single_use",
      muxUploadId: "upl_single_use",
    });

    await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Single Use",
      trimRangeEndSeconds: 60,
      trimRangeStartSeconds: 0,
      durationSeconds: 75,
      muxAssetId: "asset_single_use",
      muxPlaybackId: "playback_single_use",
    });

    const retried = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId, title: "Duplicate", trimRangeEndSeconds: 60,
      trimRangeStartSeconds: 0, durationSeconds: 75,
      muxAssetId: "asset_single_use", muxPlaybackId: "playback_single_use",
    });
    expect(await asOwner.query(api.sets.listForViewer)).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.query("sets").collect())).toHaveLength(1);
    expect(retried.setId).toBeDefined();
  });

  it("does not allow confirmation before the upload session is ready for trim", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_not_ready", "not-ready.mp4");

    await expectMutationToFailWithCode(
      asOwner.mutation(api.sets.confirmUploadSession, {
        uploadSessionId,
        title: "Too Early",
        trimRangeEndSeconds: 60,
        trimRangeStartSeconds: 5,
        durationSeconds: 75,
        muxAssetId: "asset_not_ready",
        muxPlaybackId: "playback_not_ready",
      }),
      "processing_unavailable",
    );

    expect(await asOwner.query(api.sets.listForViewer)).toHaveLength(0);
  });

  it("rejects confirmation when the client payload does not match the ready upload session metadata", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_mismatch", "mismatch.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_mismatch",
      muxUploadId: "upl_mismatch",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 180,
      muxAssetId: "asset_mismatch",
      muxPlaybackId: "playback_mismatch",
      muxUploadId: "upl_mismatch",
    });

    await expectMutationToFailWithCode(
      asOwner.mutation(api.sets.confirmUploadSession, {
        uploadSessionId,
        title: "Mismatch",
        trimRangeEndSeconds: 60,
        trimRangeStartSeconds: 5,
        durationSeconds: 181,
        muxAssetId: "asset_mismatch",
        muxPlaybackId: "playback_mismatch",
      }),
      "processing_unavailable",
    );

    await expectMutationToFailWithCode(
      asOwner.mutation(api.sets.confirmUploadSession, {
        uploadSessionId,
        title: "Mismatch",
        trimRangeEndSeconds: 60,
        trimRangeStartSeconds: 5,
        durationSeconds: 180,
        muxAssetId: "asset_mismatch_other",
        muxPlaybackId: "playback_mismatch",
      }),
      "processing_unavailable",
    );

    expect(await asOwner.query(api.sets.listForViewer)).toHaveLength(0);
  });

  it("exposes upload session readiness for the authenticated viewer only", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });
    const asOtherViewer = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_999",
      tokenIdentifier: "clerk:user_999",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_webhook", "webhook.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_webhook",
      muxUploadId: "upl_webhook",
    });
    const webhookBody = JSON.stringify({
      type: "video.asset.ready",
      data: {
        duration: 101,
        id: "asset_webhook",
        playback_ids: [{ id: "playback_webhook", policy: "public" }],
        tracks: [{ type: "video" }],
        upload_id: "upl_webhook",
      },
    });
    const encoder = new TextEncoder();
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = "webhook-test-secret";
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sign = async (time: number) => {
      const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${time}.${webhookBody}`));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const deliver = (time: number, signature: string, body = webhookBody) => t.fetch("/mux/webhooks", {
      method: "POST",
      headers: { "Mux-Signature": `t=${time},v1=${signature}` },
      body,
    });
    vi.stubEnv("MUX_WEBHOOK_SECRET", secret);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const valid = await sign(timestamp);
      expect((await deliver(timestamp, valid, webhookBody + " ")).status).toBe(401);
      expect((await deliver(timestamp, "invalid")).status).toBe(401);
      const old = timestamp - 301;
      expect((await deliver(old, await sign(old))).status).toBe(401);
      expect((await deliver(timestamp, valid)).status).toBe(200);
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }

    const session = await asOwner.query(api.sets.getUploadSessionForViewer, {
      uploadSessionId,
    });
    const hiddenFromOtherViewer = await asOtherViewer.query(
      api.sets.getUploadSessionForViewer,
      {
        uploadSessionId,
      },
    );

    expect(session).toMatchObject({
      _id: uploadSessionId,
      durationSeconds: 101,
      muxAssetId: "asset_webhook",
      muxPlaybackId: "playback_webhook",
      status: "readyForTrim",
    });
    expect(hiddenFromOtherViewer).toBeNull();
  });

  it("looks up an upload session by mux upload id for the owning viewer only", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });
    const asOtherViewer = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_999",
      tokenIdentifier: "clerk:user_999",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_owner_lookup", "lookup.mp4");

    const visibleToOwner = await asOwner.query(
      api.sets.getUploadSessionByMuxUploadIdForViewer,
      {
        muxUploadId: "upl_owner_lookup",
      },
    );
    const hiddenFromOtherViewer = await asOtherViewer.query(
      api.sets.getUploadSessionByMuxUploadIdForViewer,
      {
        muxUploadId: "upl_owner_lookup",
      },
    );

    expect(visibleToOwner).toMatchObject({
      _id: uploadSessionId,
      muxUploadId: "upl_owner_lookup",
      status: "waitingForUpload",
    });
    expect(hiddenFromOtherViewer).toBeNull();
  });

  it("persists a failure code for upload sessions when playback preparation fails", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_failed", "failed.mp4");

    await t.mutation(internal.sets.markUploadSessionFailed, {
      failureCode: "processing_unavailable",
      muxUploadId: "upl_failed",
    });

    const session = await asOwner.query(api.sets.getUploadSessionForViewer, {
      uploadSessionId,
    });

    expect(session).toMatchObject({
      _id: uploadSessionId,
      failureCode: "processing_unavailable",
      status: "failed",
    });
  });

  it("builds set-page analysis data from persisted lines and laugh regions", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_analysis", "analysis.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_analysis",
      muxUploadId: "upl_analysis",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 180,
      muxAssetId: "asset_analysis",
      muxPlaybackId: "playback_analysis",
      muxUploadId: "upl_analysis",
    });

    const created = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Analysis View",
      trimRangeEndSeconds: 120,
      trimRangeStartSeconds: 0,
      durationSeconds: 180,
      muxAssetId: "asset_analysis",
      muxPlaybackId: "playback_analysis",
    });

    await markCalibrationSaved(t, uploadSessionId, created.setId);

    await t.mutation(internal.setIngest.replaceNormalizedLines, {
      breakdownId: created.breakdownId,
      lines: [
        {
          ordinal: 1,
          startSeconds: 0,
          endSeconds: 5,
          text: "First line lands.",
          wordCount: 3,
          laughCount: 0,
          laughIntensityScore: 0,
        },
        {
          ordinal: 2,
          startSeconds: 5,
          endSeconds: 11,
          text: "Second line gets the laugh.",
          wordCount: 5,
          laughCount: 0,
          laughIntensityScore: 0,
        },
      ],
    });

    await t.mutation(internal.setIngest.replaceNormalizedLaughRegions, {
      breakdownId: created.breakdownId,
      laughRegions: [
        {
          lineOrdinal: 2,
          ordinal: 1,
          startSeconds: 6.2,
          endSeconds: 7.4,
          intensityScore: 0.82,
        },
      ],
    });

    const page = await asOwner.query(api.sets.getSetPageForViewer, {
      setId: created.setId,
    });

    expect(page).toMatchObject({
      _id: created.setId,
      title: "Analysis View",
      activePlaybackSource: {
        playbackMode: "hls",
        playbackUrl: "https://stream.mux.com/playback_analysis.m3u8",
        provider: "mux",
      },
      analysisData: {
        segmentCount: 1,
        transcriptText: "First line lands. Second line gets the laugh.",
        sentences: [
          {
            index: 1,
            text: "First line lands.",
            laugh_count: 0,
          },
          {
            index: 2,
            text: "Second line gets the laugh.",
            laugh_count: 1,
            laugh_intensity_score: 0.82,
          },
        ],
        segments: [
          {
            index: 1,
            start_time: 6.2,
            end_time: 7.4,
            intensity_score: 0.82,
          },
        ],
      },
    });
  });

  it("keeps Mux active until the canonical Bunny artifact is ready to view", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });
    let resolveBunnyReadiness!: (response: Response) => void;
    const bunnyReadiness = new Promise<Response>((resolve) => {
      resolveBunnyReadiness = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(bunnyReadiness);

    try {
      const { uploadSessionId } = await registerUploadFixture(t, "upl_bunny_swap", "bunny-swap.mp4");

      await t.mutation(internal.sets.markUploadSessionProcessing, {
        muxAssetId: "asset_bunny_swap",
        muxUploadId: "upl_bunny_swap",
      });
      await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
        durationSeconds: 150,
        muxAssetId: "asset_bunny_swap",
        muxPlaybackId: "playback_bunny_swap",
        muxUploadId: "upl_bunny_swap",
      });

      const created = await asOwner.mutation(api.sets.confirmUploadSession, {
        uploadSessionId,
        title: "Bunny Swap",
        trimRangeEndSeconds: 120,
        trimRangeStartSeconds: 0,
        durationSeconds: 150,
        muxAssetId: "asset_bunny_swap",
        muxPlaybackId: "playback_bunny_swap",
      });

      await markCalibrationSaved(t, uploadSessionId, created.setId);

      await t.mutation(internal.setIngest.registerArtifactMetadata, {
        contentType: "video/mp4",
        fileName: "playback.mp4",
        ingestJobId: created.ingestJobId,
        isCanonical: true,
        key: "set-ingest/set_123/breakdown_123/prepareRetainedMedia/attempt-1/playback.mp4",
        kind: "playbackMedia",
        stepName: "prepareRetainedMedia",
      });

      const activationPromise = t.action(
        internal.setIngest.activatePlaybackFromCanonicalArtifact,
        {
          ingestJobId: created.ingestJobId,
          setId: created.setId,
        },
      );

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "https://test.b-cdn.net/set-ingest/set_123/breakdown_123/prepareRetainedMedia/attempt-1/playback.mp4",
          expect.objectContaining({
            headers: expect.objectContaining({ Range: "bytes=0-0" }),
          }),
        );
      });

      const setBeforeBunnyIsReady = await asOwner.query(
        api.sets.getSetPageForViewer,
        { setId: created.setId },
      );
      expect(setBeforeBunnyIsReady?.activePlaybackSource).toMatchObject({
        playbackUrl: "https://stream.mux.com/playback_bunny_swap.m3u8",
        provider: "mux",
      });

      resolveBunnyReadiness(
        new Response(new Uint8Array([0]), {
          headers: {
            "Content-Range": "bytes 0-0/1024",
            "Content-Type": "video/mp4",
          },
          status: 206,
        }),
      );
      const activation = await activationPromise;

      expect(activation).toMatchObject({
        playbackUrl:
          "https://test.b-cdn.net/set-ingest/set_123/breakdown_123/prepareRetainedMedia/attempt-1/playback.mp4",
        status: "completed",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const set = await asOwner.query(api.sets.getSetPageForViewer, {
        setId: created.setId,
      });
      const playbackSources = await t.query(
        internal.sets.getPlaybackSourcesForSetInternal,
        {
          setId: created.setId,
        },
      );

      expect(set?.activePlaybackSource).toMatchObject({
        kind: "persistent",
        playbackMode: "direct",
        playbackUrl:
          "https://test.b-cdn.net/set-ingest/set_123/breakdown_123/prepareRetainedMedia/attempt-1/playback.mp4",
        provider: "bunny",
      });
      expect(playbackSources).toHaveLength(2);
      expect(
        playbackSources.find((playbackSource) => playbackSource.provider === "mux"),
      ).toMatchObject({
        isActive: false,
        kind: "temporary",
        providerAssetId: "asset_bunny_swap",
      });
      expect(
        playbackSources.find((playbackSource) => playbackSource.provider === "bunny"),
      ).toMatchObject({
        isActive: true,
        playbackId:
          "https://test.b-cdn.net/set-ingest/set_123/breakdown_123/prepareRetainedMedia/attempt-1/playback.mp4",
        playbackMode: "direct",
        providerAssetId:
          "set-ingest/set_123/breakdown_123/prepareRetainedMedia/attempt-1/playback.mp4",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("deletes stale playback source records after Bunny takeover", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_cleanup_records", "cleanup-records.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_cleanup_records",
      muxUploadId: "upl_cleanup_records",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 95,
      muxAssetId: "asset_cleanup_records",
      muxPlaybackId: "playback_cleanup_records",
      muxUploadId: "upl_cleanup_records",
    });

    const created = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Cleanup Records",
      trimRangeEndSeconds: 60,
      trimRangeStartSeconds: 0,
      durationSeconds: 95,
      muxAssetId: "asset_cleanup_records",
      muxPlaybackId: "playback_cleanup_records",
    });

    await t.mutation(internal.sets.activateBunnyPlaybackSourceInternal, {
      playbackMode: "direct",
      playbackUrl: "https://test.b-cdn.net/retained/playback.mp4",
      providerAssetId: "retained/playback.mp4",
      setId: created.setId,
    });

    const beforeCleanup = await t.query(internal.sets.getPlaybackSourcesForSetInternal, {
      setId: created.setId,
    });

    await t.mutation(internal.sets.deletePlaybackSourcesInternal, {
      playbackSourceIds: beforeCleanup
        .filter((playbackSource) => playbackSource.provider === "mux")
        .map((playbackSource) => playbackSource._id),
    });

    const afterCleanup = await t.query(internal.sets.getPlaybackSourcesForSetInternal, {
      setId: created.setId,
    });

    expect(beforeCleanup).toHaveLength(2);
    expect(afterCleanup).toHaveLength(1);
    expect(afterCleanup[0]).toMatchObject({
      isActive: true,
      kind: "persistent",
      provider: "bunny",
    });
  });

  it("unlocks breakdown editing when lines are ready and laughs fail", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_unlock", "unlock.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_unlock",
      muxUploadId: "upl_unlock",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 90,
      muxAssetId: "asset_unlock",
      muxPlaybackId: "playback_unlock",
      muxUploadId: "upl_unlock",
    });

    const created = await asOwner.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Unlock Me",
      trimRangeEndSeconds: 90,
      trimRangeStartSeconds: 0,
      durationSeconds: 90,
      muxAssetId: "asset_unlock",
      muxPlaybackId: "playback_unlock",
    });

    await markCalibrationSaved(t, uploadSessionId, created.setId);

    await t.mutation(internal.setIngest.setBreakdownPathState, {
      breakdownId: created.breakdownId,
      path: "line",
      state: "ready",
    });
    await t.mutation(internal.setIngest.setBreakdownPathState, {
      breakdownId: created.breakdownId,
      path: "laugh",
      state: "failed",
      failureCode: "laugh_normalization_failed",
      failureDetail: "candidate cleanup failed",
    });

    const set = await asOwner.query(api.sets.getForViewer, {
      setId: created.setId,
    });

    expect(set?.breakdown).toMatchObject({
      editability: "editable",
      lineSeedingState: "ready",
      laughSeedingState: "failed",
      laughFailureCode: "laugh_normalization_failed",
    });
  });

  it("lists current and historical DEV artifacts only for the verified set owner", async () => {
    const t = createConvexTest();
    const identity = {
      email: "laurenparkernz@gmail.com",
      emailVerified: true,
      subject: "lauren",
      tokenIdentifier: "clerk:lauren",
    };
    const owner = t.withIdentity(identity);
    const setId = await t.run(async (ctx) => {
      const setId = await ctx.db.insert("sets", {
        ownerTokenIdentifier: identity.tokenIdentifier,
        title: "DEV Set",
        setStatus: "playable",
        trimRangeStartSeconds: 10,
        trimRangeEndSeconds: 100,
      });
      const breakdownId = await ctx.db.insert("breakdowns", {
        setId, lineSeedingState: "ready", laughSeedingState: "ready", editability: "editable",
      });
      await ctx.db.patch(setId, { currentBreakdownId: breakdownId });
      const ingestJobId = await ctx.db.insert("ingestJobs", { setId, breakdownId, status: "completed" });
      for (const isCanonical of [false, true]) {
        await ctx.db.insert("ingestArtifacts", {
          ingestJobId, kind: "cleanedAudio", stepName: "preprocessLaughAudio",
          path: `sets/${isCanonical ? "current" : "superseded"}/cleaned-audio.wav`,
          fileName: "cleaned-audio.wav", contentType: "audio/wav", isCanonical,
        });
      }
      await ctx.db.insert("ingestArtifacts", {
        ingestJobId, kind: "residualAudio", stepName: "preprocessLaughAudio",
        path: "sets/current/laughter-residual.wav", fileName: "laughter-residual.wav",
        contentType: "audio/wav", isCanonical: true,
      });
      return setId;
    });
    const args = { setId };

    expect(await owner.query(api.sets.listDevArtifacts, args)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "cleanedAudio", isCanonical: true, isCurrentBreakdown: true,
        url: expect.stringContaining("/current/cleaned-audio.wav") }),
      expect.objectContaining({ kind: "cleanedAudio", isCanonical: false,
        url: expect.stringContaining("/superseded/cleaned-audio.wav") }),
      expect.objectContaining({ kind: "residualAudio", isCanonical: true, isCurrentBreakdown: true,
        url: expect.stringContaining("/current/laughter-residual.wav") }),
    ]));
    expect(await t.query(api.sets.listDevArtifacts, args)).toBeNull();
    for (const otherIdentity of [
      { ...identity, email: "other@example.com" },
      { ...identity, emailVerified: false },
      { ...identity, subject: "other", tokenIdentifier: "clerk:other" },
    ]) {
      expect(await t.withIdentity(otherIdentity).query(api.sets.listDevArtifacts, args)).toBeNull();
    }
  });

  it("exposes the dev pipeline dashboard only to the allowed Clerk email", async () => {
    const t = createConvexTest();
    const asAllowedViewer = t.withIdentity({
      email: "devwithlex@gmail.com",
      emailVerified: true,
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await registerUploadFixture(t, "upl_dev_dashboard", "dev-dashboard.mp4");

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_dev_dashboard",
      muxUploadId: "upl_dev_dashboard",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 180,
      muxAssetId: "asset_dev_dashboard",
      muxPlaybackId: "playback_dev_dashboard",
      muxUploadId: "upl_dev_dashboard",
    });

    const created = await asAllowedViewer.mutation(api.sets.confirmUploadSession, {
      uploadSessionId,
      title: "Dev Dashboard",
      trimRangeEndSeconds: 120,
      trimRangeStartSeconds: 10,
      durationSeconds: 180,
      muxAssetId: "asset_dev_dashboard",
      muxPlaybackId: "playback_dev_dashboard",
    });

    await t.mutation(internal.setIngest.setBreakdownPathState, {
      breakdownId: created.breakdownId,
      path: "line",
      state: "ready",
    });

    for (const email of ["other@example.com", "devwithlex@gmail.com"]) {
      const denied = t.withIdentity({
        email,
        emailVerified: email === "other@example.com",
        tokenIdentifier: "clerk:user_123",
      });
      expect(await denied.query(api.sets.getDevPipelineDashboard)).toBeNull();
    }

    const visible = await asAllowedViewer.query(api.sets.getDevPipelineDashboard);

    expect(visible).toMatchObject({
      viewerEmail: "devwithlex@gmail.com",
      summary: {
        activeMuxSourceCount: 1,
        playableSetCount: 1,
        setCount: 1,
        uploadSessionCount: 1,
      },
      recentUploadSessions: [
        {
          _id: uploadSessionId,
          confirmedSetId: created.setId,
          status: "calibrating",
        },
      ],
      sets: [
        {
          _id: created.setId,
          activePlaybackSource: {
            kind: "temporary",
            provider: "mux",
          },
          breakdown: {
            editability: "locked",
            lineSeedingState: "ready",
            laughSeedingState: "pending",
          },
          ingestJob: {
            status: "pending",
          },
          lineCount: 0,
          laughRegionCount: 0,
          setStatus: "playable",
          title: "Dev Dashboard",
          uploadSession: {
            _id: uploadSessionId,
            status: "calibrating",
          },
        },
      ],
    });
  });
});
