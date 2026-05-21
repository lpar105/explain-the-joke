import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { convexModules } from "./test.setup";

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
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      name: "Taylor",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        mediaKind: "video",
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
      mediaKind: "video",
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
        mediaKind: "video",
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
    const t = convexTest(schema, convexModules);
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
        mediaKind: "audio",
        muxUploadId: "upl_999",
        originalFileName: "tight-five.mp3",
      },
    );

    await t.mutation(internal.sets.markUploadSessionProcessing, {
      muxAssetId: "asset_999",
      muxUploadId: "upl_999",
    });
    await t.mutation(internal.sets.markUploadSessionReadyForTrim, {
      durationSeconds: 120,
      mediaKind: "audio",
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
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        mediaKind: "video",
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
      mediaKind: "video",
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
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        mediaKind: "video",
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
      mediaKind: "video",
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
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        mediaKind: "video",
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
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        mediaKind: "video",
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
      mediaKind: "video",
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
    const t = convexTest(schema, convexModules);
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
        mediaKind: "video",
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
      mediaKind: "video",
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
      mediaKind: "video",
      muxAssetId: "asset_webhook",
      muxPlaybackId: "playback_webhook",
      status: "readyForTrim",
    });
    expect(hiddenFromOtherViewer).toBeNull();
  });

  it("looks up an upload session by mux upload id for the owning viewer only", async () => {
    const t = convexTest(schema, convexModules);
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
        mediaKind: "video",
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
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const { uploadSessionId } = await asOwner.mutation(
      api.sets.startUploadSession,
      {
        mediaKind: "video",
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
});
