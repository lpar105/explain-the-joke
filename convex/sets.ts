import { v } from "convex/values";

import { isAllowedDevEmail } from "../lib/dev-access";
import { toConvexError } from "../lib/errors";
import { composeTranscriptText } from "../lib/setAnalysis";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";

function normalizeTitle(title: string) {
  return title.trim();
}

function assertTrimRange(args: {
  trimRangeStartSeconds: number;
  trimRangeEndSeconds: number;
  durationSeconds: number;
}) {
  const { durationSeconds, trimRangeEndSeconds, trimRangeStartSeconds } = args;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw toConvexError("validation");
  }

  if (
    !Number.isFinite(trimRangeStartSeconds) ||
    !Number.isFinite(trimRangeEndSeconds)
  ) {
    throw toConvexError("validation");
  }

  if (trimRangeStartSeconds < 0) {
    throw toConvexError("validation");
  }

  if (trimRangeEndSeconds <= trimRangeStartSeconds) {
    throw toConvexError("validation");
  }

  if (trimRangeEndSeconds > durationSeconds) {
    throw toConvexError("validation");
  }
}

async function requireViewerTokenIdentifier(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();

  if (identity === null) {
    throw toConvexError("auth");
  }

  return identity.tokenIdentifier;
}

async function getActivePlaybackSource(
  ctx: QueryCtx,
  setId: Id<"sets">,
) {
  return ctx.db
    .query("playbackSources")
    .withIndex("by_setId_and_isActive", (q) => q.eq("setId", setId).eq("isActive", true))
    .unique();
}

export const getActivePlaybackSourceInternal = internalQuery({
  args: {
    setId: v.id("sets"),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("playbackSources")
      .withIndex("by_setId_and_isActive", (q) =>
        q.eq("setId", args.setId).eq("isActive", true),
      )
      .unique();
  },
});

export const getPlaybackSourcesForSetInternal = internalQuery({
  args: {
    setId: v.id("sets"),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("playbackSources")
      .withIndex("by_setId_and_isActive", (q) => q.eq("setId", args.setId))
      .take(20);
  },
});

export const activateBunnyPlaybackSourceInternal = internalMutation({
  args: {
    playbackUrl: v.string(),
    playbackMode: v.union(v.literal("direct"), v.literal("hls")),
    providerAssetId: v.string(),
    providerUploadId: v.optional(v.string()),
    setId: v.id("sets"),
  },
  handler: async (ctx, args) => {
    const activeSources = await ctx.db
      .query("playbackSources")
      .withIndex("by_setId_and_isActive", (q) =>
        q.eq("setId", args.setId).eq("isActive", true),
      )
      .take(10);

    const existingBunnySource = activeSources.find(
      (source) =>
        source.provider === "bunny" &&
        source.playbackId === args.playbackUrl &&
        source.playbackMode === args.playbackMode &&
        source.providerAssetId === args.providerAssetId,
    );

    for (const source of activeSources) {
      if (source.isActive) {
        await ctx.db.patch(source._id, { isActive: false });
      }
    }

    if (existingBunnySource) {
      await ctx.db.patch(existingBunnySource._id, { isActive: true });
      return existingBunnySource._id;
    }

    return ctx.db.insert("playbackSources", {
      isActive: true,
      kind: "persistent",
      playbackId: args.playbackUrl,
      playbackMode: args.playbackMode,
      provider: "bunny",
      providerAssetId: args.providerAssetId,
      ...(args.providerUploadId === undefined
        ? {}
        : { providerUploadId: args.providerUploadId }),
      setId: args.setId,
    });
  },
});

export const deletePlaybackSourcesInternal = internalMutation({
  args: {
    playbackSourceIds: v.array(v.id("playbackSources")),
  },
  handler: async (ctx, args) => {
    for (const playbackSourceId of args.playbackSourceIds) {
      const playbackSource = await ctx.db.get(playbackSourceId);
      if (playbackSource !== null) {
        await ctx.db.delete(playbackSourceId);
      }
    }

    return null;
  },
});

export const listForViewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      return [];
    }

    const sets = await ctx.db
      .query("sets")
      .withIndex("by_ownerTokenIdentifier", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .take(50);

    return Promise.all(
      sets.map(async (set) => {
        const breakdown = set.currentBreakdownId
          ? await ctx.db.get(set.currentBreakdownId)
          : null;
        const activePlaybackSource = await getActivePlaybackSource(ctx, set._id);
        const currentBreakdown =
          breakdown !== null && breakdown.setId === set._id ? breakdown : null;

        return {
          _id: set._id,
          _creationTime: set._creationTime,
          currentBreakdownId: set.currentBreakdownId ?? null,
          setStatus: set.setStatus,
          title: set.title,
          trimRangeEndSeconds: set.trimRangeEndSeconds,
          trimRangeStartSeconds: set.trimRangeStartSeconds,
          activePlaybackSource: activePlaybackSource
            ? {
                _id: activePlaybackSource._id,
                kind: activePlaybackSource.kind,
                playbackId: activePlaybackSource.playbackId,
                provider: activePlaybackSource.provider,
              }
            : null,
          breakdown: currentBreakdown
            ? {
                _id: currentBreakdown._id,
                editability: currentBreakdown.editability,
                laughSeedingState: currentBreakdown.laughSeedingState,
                lineSeedingState: currentBreakdown.lineSeedingState,
              }
            : null,
        };
      }),
    );
  },
});

export const getForViewer = query({
  args: {
    setId: v.id("sets"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      return null;
    }

    const set = await ctx.db.get(args.setId);
    if (set === null || set.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }

    const breakdown = set.currentBreakdownId
      ? await ctx.db.get(set.currentBreakdownId)
      : null;
    const activePlaybackSource = await getActivePlaybackSource(ctx, set._id);
    const currentBreakdown =
      breakdown !== null && breakdown.setId === set._id ? breakdown : null;

    return {
      _id: set._id,
      _creationTime: set._creationTime,
      currentBreakdownId: set.currentBreakdownId ?? null,
      setStatus: set.setStatus,
      title: set.title,
      trimRangeEndSeconds: set.trimRangeEndSeconds,
      trimRangeStartSeconds: set.trimRangeStartSeconds,
      activePlaybackSource: activePlaybackSource
        ? {
            _id: activePlaybackSource._id,
            kind: activePlaybackSource.kind,
            playbackId: activePlaybackSource.playbackId,
            provider: activePlaybackSource.provider,
          }
        : null,
      breakdown: currentBreakdown
        ? {
            _id: currentBreakdown._id,
            editability: currentBreakdown.editability,
            laughFailureCode: currentBreakdown.laughFailureCode ?? null,
            laughSeedingState: currentBreakdown.laughSeedingState,
            lineFailureCode: currentBreakdown.lineFailureCode ?? null,
            lineSeedingState: currentBreakdown.lineSeedingState,
          }
        : null,
    };
  },
});

export const getDevPipelineDashboard = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      return null;
    }

    const uploadSessions = await ctx.db
      .query("uploadSessions")
      .withIndex("by_ownerTokenIdentifier", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .take(100);
    const sets = await ctx.db
      .query("sets")
      .withIndex("by_ownerTokenIdentifier", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .take(50);

    const dashboardSets = await Promise.all(
      sets.map(async (set) => {
        const breakdown =
          set.currentBreakdownId === undefined
            ? null
            : await ctx.db.get(set.currentBreakdownId);
        const currentBreakdown =
          breakdown !== null && breakdown?.setId === set._id ? breakdown : null;
        const playbackSources = await ctx.db
          .query("playbackSources")
          .withIndex("by_setId_and_isActive", (q) => q.eq("setId", set._id))
          .take(20);
        const ingestJob = (
          await ctx.db
            .query("ingestJobs")
            .withIndex("by_setId", (q) => q.eq("setId", set._id))
            .order("desc")
            .take(5)
        )[0] ?? null;
        const stepAttempts =
          ingestJob === null
            ? []
            : await ctx.db
                .query("ingestStepAttempts")
                .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ingestJob._id))
                .take(100);
        const artifacts =
          ingestJob === null
            ? []
            : await ctx.db
                .query("ingestArtifacts")
                .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ingestJob._id))
                .take(100);
        const lines =
          currentBreakdown === null
            ? []
            : await ctx.db
                .query("lines")
                .withIndex("by_breakdownId_and_ordinal", (q) =>
                  q.eq("breakdownId", currentBreakdown._id),
                )
                .take(2_000);
        const laughRegions =
          currentBreakdown === null
            ? []
            : await ctx.db
                .query("laughRegions")
                .withIndex("by_breakdownId_and_ordinal", (q) =>
                  q.eq("breakdownId", currentBreakdown._id),
                )
                .take(4_000);
        const uploadSession =
          uploadSessions.find((session) => session.confirmedSetId === set._id) ?? null;
        const activePlaybackSource =
          playbackSources.find((playbackSource) => playbackSource.isActive) ?? null;

        return {
          _id: set._id,
          _creationTime: set._creationTime,
          activePlaybackSource: activePlaybackSource
            ? {
                _id: activePlaybackSource._id,
                isActive: activePlaybackSource.isActive,
                kind: activePlaybackSource.kind,
                playbackId: activePlaybackSource.playbackId,
                provider: activePlaybackSource.provider,
                providerAssetId: activePlaybackSource.providerAssetId,
                providerUploadId: activePlaybackSource.providerUploadId ?? null,
              }
            : null,
          breakdown:
            currentBreakdown === null
              ? null
              : {
                  _id: currentBreakdown._id,
                  editability: currentBreakdown.editability,
                  laughFailureCode: currentBreakdown.laughFailureCode ?? null,
                  laughFailureDetail: currentBreakdown.laughFailureDetail ?? null,
                  laughSeedingState: currentBreakdown.laughSeedingState,
                  lineFailureCode: currentBreakdown.lineFailureCode ?? null,
                  lineFailureDetail: currentBreakdown.lineFailureDetail ?? null,
                  lineSeedingState: currentBreakdown.lineSeedingState,
                },
          ingestJob:
            ingestJob === null
              ? null
              : {
                  _id: ingestJob._id,
                  activePlaybackMigrationStep:
                    ingestJob.activePlaybackMigrationStep ?? null,
                  artifacts: artifacts.map((artifact) => ({
                    _id: artifact._id,
                    contentType: artifact.contentType ?? null,
                    createdByAttemptId: artifact.createdByAttemptId ?? null,
                    expiresAt: artifact.expiresAt ?? null,
                    fileName: artifact.fileName,
                    isCanonical: artifact.isCanonical,
                    kind: artifact.kind,
                    path: artifact.path,
                    size: artifact.size ?? null,
                    stepName: artifact.stepName,
                  })),
                  completedAt: ingestJob.completedAt ?? null,
                  failedAt: ingestJob.failedAt ?? null,
                  status: ingestJob.status,
                  stepAttempts: stepAttempts.map((attempt) => ({
                    _id: attempt._id,
                    attemptNumber: attempt.attemptNumber,
                    failureCode: attempt.failureCode ?? null,
                    failureDetail: attempt.failureDetail ?? null,
                    finishedAt: attempt.finishedAt ?? null,
                    modalFunctionCallId: attempt.modalFunctionCallId ?? null,
                    runner: attempt.runner,
                    startedAt: attempt.startedAt,
                    status: attempt.status,
                    stepName: attempt.stepName,
                    workflowEventName: attempt.workflowEventName ?? null,
                  })),
                  workflowId: ingestJob.workflowId ?? null,
                },
          lineCount: lines.length,
          laughRegionCount: laughRegions.length,
          playbackSources: playbackSources.map((playbackSource) => ({
            _id: playbackSource._id,
            isActive: playbackSource.isActive,
            kind: playbackSource.kind,
            playbackId: playbackSource.playbackId,
            provider: playbackSource.provider,
            providerAssetId: playbackSource.providerAssetId,
            providerUploadId: playbackSource.providerUploadId ?? null,
          })),
          setStatus: set.setStatus,
          title: set.title,
          trimRangeEndSeconds: set.trimRangeEndSeconds,
          trimRangeStartSeconds: set.trimRangeStartSeconds,
          uploadSession:
            uploadSession === null
              ? null
              : {
                  _id: uploadSession._id,
                  durationSeconds: uploadSession.durationSeconds ?? null,
                  failureCode: uploadSession.failureCode ?? null,
                  muxAssetId: uploadSession.muxAssetId ?? null,
                  muxPlaybackId: uploadSession.muxPlaybackId ?? null,
                  muxUploadId: uploadSession.muxUploadId,
                  originalFileName: uploadSession.originalFileName,
                  status: uploadSession.status,
                },
        };
      }),
    );

    const activePlaybackSources = dashboardSets.flatMap((set) =>
      set.playbackSources.filter((playbackSource) => playbackSource.isActive),
    );

    return {
      recentUploadSessions: uploadSessions.map((uploadSession) => ({
        _id: uploadSession._id,
        confirmedSetId: uploadSession.confirmedSetId ?? null,
        durationSeconds: uploadSession.durationSeconds ?? null,
        failureCode: uploadSession.failureCode ?? null,
        muxAssetId: uploadSession.muxAssetId ?? null,
        muxPlaybackId: uploadSession.muxPlaybackId ?? null,
        muxUploadId: uploadSession.muxUploadId,
        originalFileName: uploadSession.originalFileName,
        status: uploadSession.status,
      })),
      sets: dashboardSets,
      summary: {
        activeBunnySourceCount: activePlaybackSources.filter(
          (playbackSource) => playbackSource.provider === "bunny",
        ).length,
        activeMuxSourceCount: activePlaybackSources.filter(
          (playbackSource) => playbackSource.provider === "mux",
        ).length,
        activePlaybackSourceCount: activePlaybackSources.length,
        editableBreakdownCount: dashboardSets.filter(
          (set) => set.breakdown?.editability === "editable",
        ).length,
        failedBreakdownCount: dashboardSets.filter(
          (set) =>
            set.breakdown?.lineSeedingState === "failed" ||
            set.breakdown?.laughSeedingState === "failed",
        ).length,
        pendingUploadSessionCount: uploadSessions.filter(
          (uploadSession) => uploadSession.status !== "confirmed",
        ).length,
        playableSetCount: dashboardSets.filter((set) => set.setStatus === "playable")
          .length,
        setCount: dashboardSets.length,
        unavailableSetCount: dashboardSets.filter(
          (set) => set.setStatus === "unavailable",
        ).length,
        uploadSessionCount: uploadSessions.length,
      },
      viewerEmail: identity.email ?? null,
    };
  },
});

export const getSetPageForViewer = query({
  args: {
    setId: v.id("sets"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }

    const tokenIdentifier = identity.tokenIdentifier;
    const set = await ctx.db.get(args.setId);

    if (set === null || set.ownerTokenIdentifier !== tokenIdentifier) {
      return null;
    }

    const breakdown =
      set.currentBreakdownId === undefined
        ? null
        : await ctx.db.get(set.currentBreakdownId);
    const activePlaybackSource = await getActivePlaybackSource(ctx, set._id);
    const currentBreakdown =
      breakdown !== null && breakdown?.setId === set._id ? breakdown : null;

    let analysisData = null;
    if (currentBreakdown !== null) {
      const lines = await ctx.db
        .query("lines")
        .withIndex("by_breakdownId_and_ordinal", (q) =>
          q.eq("breakdownId", currentBreakdown._id),
        )
        .take(2_000);
      const laughRegions = await ctx.db
        .query("laughRegions")
        .withIndex("by_breakdownId_and_ordinal", (q) =>
          q.eq("breakdownId", currentBreakdown._id),
        )
        .take(4_000);

      if (lines.length > 0) {
        const laughsByLineId = new Map<
          Id<"lines">,
          Array<{
            index: number;
            start_time: number;
            end_time: number;
            duration: number;
            intensity_score: number;
          }>
        >();

        for (const laughRegion of laughRegions) {
          const existing = laughsByLineId.get(laughRegion.lineId) ?? [];
          existing.push({
            index: existing.length + 1,
            start_time: laughRegion.startSeconds,
            end_time: laughRegion.endSeconds,
            duration: Math.max(
              0,
              laughRegion.endSeconds - laughRegion.startSeconds,
            ),
            intensity_score: laughRegion.intensityScore,
          });
          laughsByLineId.set(laughRegion.lineId, existing);
        }

        const sentences = lines.map((line) => ({
          index: line.ordinal,
          start: line.startSeconds,
          end: line.endSeconds,
          text: line.text,
          laugh_count: line.laughCount,
          laugh_intensity_score: line.laughIntensityScore,
          laughs: laughsByLineId.get(line._id) ?? [],
        }));
        const segments = laughRegions.map((laughRegion) => ({
          index: laughRegion.ordinal,
          start_time: laughRegion.startSeconds,
          end_time: laughRegion.endSeconds,
          duration: Math.max(
            0,
            laughRegion.endSeconds - laughRegion.startSeconds,
          ),
          intensity_score: laughRegion.intensityScore,
        }));

        analysisData = {
          version: "1.1.0",
          generatedAt:
            Math.max(
              currentBreakdown.lineSeededAt ?? 0,
              currentBreakdown.laughSeededAt ?? 0,
            ) || currentBreakdown._creationTime,
          sampleRate: 0,
          totalDuration: Math.max(
            set.trimRangeEndSeconds - set.trimRangeStartSeconds,
            lines[lines.length - 1]?.endSeconds ?? 0,
            laughRegions[laughRegions.length - 1]?.endSeconds ?? 0,
          ),
          segmentCount: segments.length,
          transcriptText: composeTranscriptText(sentences),
          sentences,
          segments,
          chapters: [],
          comments: [],
        };
      }
    }

    return {
      _id: set._id,
      title: set.title,
      trimRangeStartSeconds: set.trimRangeStartSeconds,
      trimRangeEndSeconds: set.trimRangeEndSeconds,
      activePlaybackSource: activePlaybackSource
        ? {
            _id: activePlaybackSource._id,
            provider: activePlaybackSource.provider,
            kind: activePlaybackSource.kind,
            playbackId: activePlaybackSource.playbackId,
            playbackMode: activePlaybackSource.playbackMode ?? ("hls" as const),
            playbackUrl:
              activePlaybackSource.provider === "mux"
                ? `https://stream.mux.com/${activePlaybackSource.playbackId}.m3u8`
                : activePlaybackSource.playbackId,
          }
        : null,
      breakdown:
        currentBreakdown === null
          ? null
          : {
              _id: currentBreakdown._id,
              editability: currentBreakdown.editability,
              lineSeedingState: currentBreakdown.lineSeedingState,
              laughSeedingState: currentBreakdown.laughSeedingState,
              lineFailureCode: currentBreakdown.lineFailureCode ?? null,
              laughFailureCode: currentBreakdown.laughFailureCode ?? null,
            },
      analysisData,
    };
  },
});

export const startUploadSession = mutation({
  args: {
    muxUploadId: v.string(),
    originalFileName: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireViewerTokenIdentifier(ctx);

    const uploadSessionId = await ctx.db.insert("uploadSessions", {
      ownerTokenIdentifier: tokenIdentifier,
      muxUploadId: args.muxUploadId,
      originalFileName: args.originalFileName.trim(),
      status: "waitingForUpload",
    });

    return { uploadSessionId };
  },
});

export const discardUploadSession = mutation({
  args: {
    uploadSessionId: v.id("uploadSessions"),
  },
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireViewerTokenIdentifier(ctx);
    const uploadSession = await ctx.db.get(args.uploadSessionId);

    if (
      uploadSession === null ||
      uploadSession.ownerTokenIdentifier !== tokenIdentifier
    ) {
      throw toConvexError("not_found");
    }

    if (uploadSession.status === "confirmed") {
      return null;
    }

    if (uploadSession.status !== "discarded") {
      await ctx.db.patch("uploadSessions", args.uploadSessionId, {
        status: "discarded",
      });
    }

    return null;
  },
});

export const confirmUploadSession = mutation({
  args: {
    uploadSessionId: v.id("uploadSessions"),
    title: v.string(),
    trimRangeStartSeconds: v.number(),
    trimRangeEndSeconds: v.number(),
    durationSeconds: v.number(),
    muxAssetId: v.string(),
    muxPlaybackId: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireViewerTokenIdentifier(ctx);
    const uploadSession = await ctx.db.get(args.uploadSessionId);

    if (
      uploadSession === null ||
      uploadSession.ownerTokenIdentifier !== tokenIdentifier
    ) {
      throw toConvexError("not_found");
    }

    if (uploadSession.status === "discarded") {
      throw toConvexError("not_found");
    }

    if (uploadSession.status === "confirmed") {
      throw toConvexError("validation");
    }

    if (uploadSession.status !== "readyForTrim") {
      throw toConvexError("processing_unavailable");
    }

    const nextTitle = normalizeTitle(args.title);
    if (!nextTitle) {
      throw toConvexError("validation");
    }

    if (!args.muxAssetId.trim() || !args.muxPlaybackId.trim()) {
      throw toConvexError("processing_unavailable");
    }

    assertTrimRange({
      durationSeconds: args.durationSeconds,
      trimRangeEndSeconds: args.trimRangeEndSeconds,
      trimRangeStartSeconds: args.trimRangeStartSeconds,
    });

    if (
      uploadSession.muxAssetId !== args.muxAssetId.trim() ||
      uploadSession.muxPlaybackId !== args.muxPlaybackId.trim() ||
      uploadSession.durationSeconds !== args.durationSeconds
    ) {
      throw toConvexError("processing_unavailable");
    }

    const setId = await ctx.db.insert("sets", {
      ownerTokenIdentifier: tokenIdentifier,
      title: nextTitle,
      trimRangeStartSeconds: args.trimRangeStartSeconds,
      trimRangeEndSeconds: args.trimRangeEndSeconds,
      setStatus: "playable",
    });

    const breakdownId = await ctx.db.insert("breakdowns", {
      setId,
      editability: "locked",
      laughSeedingState: "pending",
      lineSeedingState: "pending",
    });

    await ctx.db.patch("sets", setId, {
      currentBreakdownId: breakdownId,
    });

    const ingestJobId = await ctx.db.insert("ingestJobs", {
      breakdownId,
      setId,
      status: "pending",
    });

    const playbackSourceId = await ctx.db.insert("playbackSources", {
      setId,
      provider: "mux",
      kind: "temporary",
      isActive: true,
      playbackId: args.muxPlaybackId.trim(),
      providerAssetId: args.muxAssetId.trim(),
      providerUploadId: uploadSession.muxUploadId,
    });

    await ctx.db.patch("uploadSessions", args.uploadSessionId, {
      muxAssetId: args.muxAssetId.trim(),
      muxPlaybackId: args.muxPlaybackId.trim(),
      durationSeconds: args.durationSeconds,
      status: "confirmed",
      failureCode: undefined,
      confirmedSetId: setId,
    });

    await ctx.runMutation(internal.setIngest.startSetIngest, {
      ingestJobId,
    });

    return { breakdownId, ingestJobId, playbackSourceId, setId };
  },
});

export const getBreakdownInternal = internalQuery({
  args: {
    breakdownId: v.id("breakdowns"),
  },
  handler: async (ctx, args) => {
    return ctx.db.get(args.breakdownId);
  },
});

export const getBreakdownLinesInternal = internalQuery({
  args: {
    breakdownId: v.id("breakdowns"),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("lines")
      .withIndex("by_breakdownId_and_ordinal", (q) =>
        q.eq("breakdownId", args.breakdownId),
      )
      .take(2_000);
  },
});

export const getUploadSessionForViewer = query({
  args: {
    uploadSessionId: v.id("uploadSessions"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      return null;
    }

    const uploadSession = await ctx.db.get(args.uploadSessionId);
    if (
      uploadSession === null ||
      uploadSession.ownerTokenIdentifier !== identity.tokenIdentifier
    ) {
      return null;
    }

    return {
      _id: uploadSession._id,
      durationSeconds: uploadSession.durationSeconds ?? null,
      failureCode: uploadSession.failureCode ?? null,
      muxAssetId: uploadSession.muxAssetId ?? null,
      muxPlaybackId: uploadSession.muxPlaybackId ?? null,
      muxUploadId: uploadSession.muxUploadId,
      originalFileName: uploadSession.originalFileName,
      status: uploadSession.status,
    };
  },
});

export const getUploadSessionByMuxUploadIdForViewer = query({
  args: {
    muxUploadId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      return null;
    }

    const uploadSession = await ctx.db
      .query("uploadSessions")
      .withIndex("by_muxUploadId", (q) => q.eq("muxUploadId", args.muxUploadId))
      .unique();

    if (
      uploadSession === null ||
      uploadSession.ownerTokenIdentifier !== identity.tokenIdentifier
    ) {
      return null;
    }

    return {
      _id: uploadSession._id,
      muxAssetId: uploadSession.muxAssetId ?? null,
      muxUploadId: uploadSession.muxUploadId,
      ownerTokenIdentifier: uploadSession.ownerTokenIdentifier,
      status: uploadSession.status,
    };
  },
});

export const markUploadSessionProcessing = internalMutation({
  args: {
    muxAssetId: v.string(),
    muxUploadId: v.string(),
  },
  handler: async (ctx, args) => {
    const uploadSession = await ctx.db
      .query("uploadSessions")
      .withIndex("by_muxUploadId", (q) => q.eq("muxUploadId", args.muxUploadId))
      .unique();

    if (uploadSession === null || uploadSession.status !== "waitingForUpload") {
      return null;
    }

    await ctx.db.patch("uploadSessions", uploadSession._id, {
      muxAssetId: args.muxAssetId,
      status: "processing",
    });

    return { uploadSessionId: uploadSession._id };
  },
});

export const markUploadSessionReadyForTrim = internalMutation({
  args: {
    durationSeconds: v.number(),
    muxAssetId: v.string(),
    muxPlaybackId: v.string(),
    muxUploadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const uploadSession =
      args.muxUploadId
        ? await ctx.db
            .query("uploadSessions")
            .withIndex("by_muxUploadId", (q) => q.eq("muxUploadId", args.muxUploadId!))
            .unique()
        : await ctx.db
            .query("uploadSessions")
            .withIndex("by_muxAssetId", (q) => q.eq("muxAssetId", args.muxAssetId))
            .unique();

    if (
      uploadSession === null ||
      uploadSession.status === "discarded" ||
      uploadSession.status === "confirmed"
    ) {
      return null;
    }

    await ctx.db.patch("uploadSessions", uploadSession._id, {
      durationSeconds: args.durationSeconds,
      failureCode: undefined,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      status: "readyForTrim",
    });

    return { uploadSessionId: uploadSession._id };
  },
});

export const markUploadSessionFailed = internalMutation({
  args: {
    failureCode: v.union(
      v.literal("validation"),
      v.literal("auth"),
      v.literal("not_found"),
      v.literal("processing_unavailable"),
      v.literal("internal"),
    ),
    muxAssetId: v.optional(v.string()),
    muxUploadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const uploadSession =
      args.muxUploadId
        ? await ctx.db
            .query("uploadSessions")
            .withIndex("by_muxUploadId", (q) => q.eq("muxUploadId", args.muxUploadId!))
            .unique()
        : args.muxAssetId
          ? await ctx.db
              .query("uploadSessions")
              .withIndex("by_muxAssetId", (q) => q.eq("muxAssetId", args.muxAssetId!))
              .unique()
          : null;

    if (
      uploadSession === null ||
      uploadSession.status === "discarded" ||
      uploadSession.status === "confirmed"
    ) {
      return null;
    }

    await ctx.db.patch("uploadSessions", uploadSession._id, {
      failureCode: args.failureCode,
      muxAssetId: args.muxAssetId ?? uploadSession.muxAssetId,
      status: "failed",
    });

    return { uploadSessionId: uploadSession._id };
  },
});

export const rename = mutation({
  args: {
    setId: v.id("sets"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (identity === null) {
      throw toConvexError("auth");
    }

    const set = await ctx.db.get(args.setId);
    if (set === null || set.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw toConvexError("not_found");
    }

    const nextTitle = normalizeTitle(args.title);
    if (!nextTitle) {
      throw toConvexError("validation");
    }

    await ctx.db.patch("sets", args.setId, {
      title: nextTitle,
    });

    return null;
  },
});
