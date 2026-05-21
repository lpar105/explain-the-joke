import { v } from "convex/values";

import { toConvexError } from "../lib/errors";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";

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
                mediaKind: activePlaybackSource.mediaKind,
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
            mediaKind: activePlaybackSource.mediaKind,
            playbackId: activePlaybackSource.playbackId,
            provider: activePlaybackSource.provider,
          }
        : null,
      breakdown: currentBreakdown
        ? {
            _id: currentBreakdown._id,
            editability: currentBreakdown.editability,
            laughFailureReason: currentBreakdown.laughFailureReason ?? null,
            laughSeedingState: currentBreakdown.laughSeedingState,
            lineFailureReason: currentBreakdown.lineFailureReason ?? null,
            lineSeedingState: currentBreakdown.lineSeedingState,
          }
        : null,
    };
  },
});

export const startUploadSession = mutation({
  args: {
    mediaKind: v.union(v.literal("audio"), v.literal("video")),
    muxUploadId: v.string(),
    originalFileName: v.string(),
  },
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireViewerTokenIdentifier(ctx);

    const uploadSessionId = await ctx.db.insert("uploadSessions", {
      ownerTokenIdentifier: tokenIdentifier,
      muxUploadId: args.muxUploadId,
      mediaKind: args.mediaKind,
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

    const playbackSourceId = await ctx.db.insert("playbackSources", {
      setId,
      provider: "mux",
      kind: "temporary",
      isActive: true,
      playbackId: args.muxPlaybackId.trim(),
      providerAssetId: args.muxAssetId.trim(),
      providerUploadId: uploadSession.muxUploadId,
      mediaKind: uploadSession.mediaKind,
    });

    await ctx.db.patch("uploadSessions", args.uploadSessionId, {
      muxAssetId: args.muxAssetId.trim(),
      muxPlaybackId: args.muxPlaybackId.trim(),
      durationSeconds: args.durationSeconds,
      status: "confirmed",
      failureCode: undefined,
      confirmedSetId: setId,
    });

    return { breakdownId, playbackSourceId, setId };
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
      mediaKind: uploadSession.mediaKind,
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
    mediaKind: v.union(v.literal("audio"), v.literal("video")),
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
      mediaKind: args.mediaKind,
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
