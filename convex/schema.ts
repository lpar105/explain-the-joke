import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const setStatusValidator = v.union(
  v.literal("playbackPending"),
  v.literal("playable"),
  v.literal("unavailable"),
);

const lineSeedingStateValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("retrying"),
  v.literal("ready"),
  v.literal("failed"),
);

const laughSeedingStateValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("retrying"),
  v.literal("ready"),
  v.literal("failed"),
);

const breakdownEditabilityValidator = v.union(
  v.literal("locked"),
  v.literal("editable"),
);

const mediaKindValidator = v.union(v.literal("audio"), v.literal("video"));
const appErrorCodeValidator = v.union(
  v.literal("validation"),
  v.literal("auth"),
  v.literal("not_found"),
  v.literal("processing_unavailable"),
  v.literal("internal"),
);

const uploadSessionStatusValidator = v.union(
  v.literal("waitingForUpload"),
  v.literal("processing"),
  v.literal("readyForTrim"),
  v.literal("failed"),
  v.literal("discarded"),
  v.literal("confirmed"),
);

const playbackSourceProviderValidator = v.union(
  v.literal("mux"),
  v.literal("bunny"),
);

const playbackSourceKindValidator = v.union(
  v.literal("temporary"),
  v.literal("persistent"),
);

export default defineSchema({
  sets: defineTable({
    ownerTokenIdentifier: v.string(),
    title: v.string(),
    trimRangeStartSeconds: v.number(),
    trimRangeEndSeconds: v.number(),
    setStatus: setStatusValidator,
    currentBreakdownId: v.optional(v.id("breakdowns")),
  }).index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"]),
  breakdowns: defineTable({
    setId: v.id("sets"),
    lineSeedingState: lineSeedingStateValidator,
    laughSeedingState: laughSeedingStateValidator,
    editability: breakdownEditabilityValidator,
    lineFailureReason: v.optional(v.string()),
    laughFailureReason: v.optional(v.string()),
  }).index("by_setId", ["setId"]),
  uploadSessions: defineTable({
    ownerTokenIdentifier: v.string(),
    muxUploadId: v.string(),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    mediaKind: mediaKindValidator,
    originalFileName: v.string(),
    status: uploadSessionStatusValidator,
    failureCode: v.optional(appErrorCodeValidator),
    confirmedSetId: v.optional(v.id("sets")),
  })
    .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"])
    .index("by_muxUploadId", ["muxUploadId"])
    .index("by_muxAssetId", ["muxAssetId"]),
  playbackSources: defineTable({
    setId: v.id("sets"),
    provider: playbackSourceProviderValidator,
    kind: playbackSourceKindValidator,
    isActive: v.boolean(),
    playbackId: v.string(),
    providerAssetId: v.string(),
    providerUploadId: v.optional(v.string()),
    mediaKind: mediaKindValidator,
  }).index("by_setId_and_isActive", ["setId", "isActive"]),
});
