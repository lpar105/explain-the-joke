import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import { createConvexTest } from "./test.setup";

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
  it("confirms a ready upload session into one set, one breakdown, and one active temporary playback source", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      name: "Taylor",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_123",
        originalFileName: "late-show.mp4",
      },
    );

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

    const sets = await asOwner.query(api.sets.listForViewer);

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      _id: created.setId,
      currentBreakdownId: created.breakdownId,
      setStatus: "playable",
      title: "Late Show Tape",
      trimRangeEndSeconds: 185,
      trimRangeStartSeconds: 5,
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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_999",
        originalFileName: "tight-five.mp4",
      },
    );

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
    await expectMutationToFailWithCode(
      asOtherViewer.mutation(api.sets.rename, {
        setId: created.setId,
        title: "Should Fail",
      }),
      "not_found",
    );
  });

  it("rejects invalid trim ranges without creating partial set state and leaves the upload session reusable", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_bad_trim",
        originalFileName: "bad-trim.mp4",
      },
    );

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

    expect(created.setId).toBeTruthy();
    expect(await asOwner.query(api.sets.listForViewer)).toHaveLength(1);
  });

  it("prevents duplicate sets from the same upload session", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_single_use",
        originalFileName: "single-use.mp4",
      },
    );

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

    await expectMutationToFailWithCode(
      asOwner.mutation(api.sets.confirmUploadSession, {
        uploadSessionId,
        title: "Duplicate",
        trimRangeEndSeconds: 60,
        trimRangeStartSeconds: 0,
        durationSeconds: 75,
        muxAssetId: "asset_single_use",
        muxPlaybackId: "playback_single_use",
      }),
      "validation",
    );

    expect(await asOwner.query(api.sets.listForViewer)).toHaveLength(1);
  });

  it("does not allow confirmation before the upload session is ready for trim", async () => {
    const t = createConvexTest();
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_not_ready",
        originalFileName: "not-ready.mp4",
      },
    );

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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_mismatch",
        originalFileName: "mismatch.mp4",
      },
    );

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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_webhook",
        originalFileName: "webhook.mp4",
      },
    );

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_webhook",
      muxUploadId: "upl_webhook",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 101,
      muxAssetId: "asset_webhook",
      muxPlaybackId: "playback_webhook",
      muxUploadId: "upl_webhook",
    });

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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_owner_lookup",
        originalFileName: "lookup.mp4",
      },
    );

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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_failed",
        originalFileName: "failed.mp4",
      },
    );

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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_analysis",
        originalFileName: "analysis.mp4",
      },
    );

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
      const { uploadSessionId } = await asOwner.mutation(
        api.sets.startUploadSession,
        {
          muxUploadId: "upl_bunny_swap",
          originalFileName: "bunny-swap.mp4",
        },
      );

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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_cleanup_records",
        originalFileName: "cleanup-records.mp4",
      },
    );

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

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_unlock",
        originalFileName: "unlock.mp4",
      },
    );

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
      trimRangeEndSeconds: 60,
      trimRangeStartSeconds: 0,
      durationSeconds: 90,
      muxAssetId: "asset_unlock",
      muxPlaybackId: "playback_unlock",
    });

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

  it("exposes the dev pipeline dashboard only to the allowed Clerk email", async () => {
    const t = createConvexTest();
    const asAllowedViewer = t.withIdentity({
      email: "devwithlex@gmail.com",
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asAllowedViewer.mutation(
      api.sets.startUploadSession,
      {
        muxUploadId: "upl_dev_dashboard",
        originalFileName: "dev-dashboard.mp4",
      },
    );

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
          status: "confirmed",
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
            status: "confirmed",
          },
        },
      ],
    });
  });
});
