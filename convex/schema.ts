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

const ingestJobStatusValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

const ingestStepNameValidator = v.union(
  v.literal("prepareRetainedMedia"),
  v.literal("startBunnyPlaybackMigration"),
  v.literal("awaitBunnyPlaybackReady"),
  v.literal("cleanupMuxPlayback"),
  v.literal("transcribeWords"),
  v.literal("normalizeLines"),
  v.literal("preprocessLaughAudio"),
  v.literal("detectLaughCandidates"),
  v.literal("normalizeLaughRegions"),
);

const ingestStepStatusValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
);

const ingestStepRunnerValidator = v.union(
  v.literal("convex"),
  v.literal("modal"),
);

const ingestArtifactKindValidator = v.union(
  v.literal("retainedMedia"),
  v.literal("playbackMedia"),
  v.literal("cleanedAudio"),
  v.literal("transcriptRaw"),
  v.literal("laughCandidatesRaw"),
  v.literal("linesNormalized"),
  v.literal("laughRegionsNormalized"),
);

const ingestFailureCodeValidator = v.union(
  v.literal("artifact_missing"),
  v.literal("artifact_invalid"),
  v.literal("external_worker_unavailable"),
  v.literal("external_worker_failed"),
  v.literal("modal_spawn_failed"),
  v.literal("mux_migration_failed"),
  v.literal("bunny_upload_failed"),
  v.literal("line_normalization_failed"),
  v.literal("laugh_detection_failed"),
  v.literal("laugh_normalization_failed"),
  v.literal("internal"),
);

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

const playbackModeValidator = v.union(v.literal("direct"), v.literal("hls"));

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
    lineFailureCode: v.optional(ingestFailureCodeValidator),
    laughFailureCode: v.optional(ingestFailureCodeValidator),
    lineFailureDetail: v.optional(v.string()),
    laughFailureDetail: v.optional(v.string()),
    lineSeededAt: v.optional(v.number()),
    laughSeededAt: v.optional(v.number()),
    editableAt: v.optional(v.number()),
  }).index("by_setId", ["setId"]),
  lines: defineTable({
    breakdownId: v.id("breakdowns"),
    ordinal: v.number(),
    startSeconds: v.number(),
    endSeconds: v.number(),
    text: v.string(),
    wordCount: v.number(),
    laughCount: v.number(),
    laughIntensityScore: v.number(),
  })
    .index("by_breakdownId_and_ordinal", ["breakdownId", "ordinal"])
    .index("by_breakdownId_and_startSeconds", ["breakdownId", "startSeconds"]),
  laughRegions: defineTable({
    breakdownId: v.id("breakdowns"),
    lineId: v.id("lines"),
    ordinal: v.number(),
    startSeconds: v.number(),
    endSeconds: v.number(),
    intensityScore: v.number(),
  })
    .index("by_breakdownId_and_ordinal", ["breakdownId", "ordinal"])
    .index("by_breakdownId_and_startSeconds", ["breakdownId", "startSeconds"])
    .index("by_lineId_and_ordinal", ["lineId", "ordinal"]),
  ingestJobs: defineTable({
    setId: v.id("sets"),
    breakdownId: v.id("breakdowns"),
    workflowId: v.optional(v.string()),
    status: ingestJobStatusValidator,
    activePlaybackMigrationStep: v.optional(ingestStepNameValidator),
    completedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
  })
    .index("by_setId", ["setId"])
    .index("by_breakdownId", ["breakdownId"])
    .index("by_workflowId", ["workflowId"]),
  ingestStepAttempts: defineTable({
    ingestJobId: v.id("ingestJobs"),
    stepName: ingestStepNameValidator,
    attemptNumber: v.number(),
    runner: ingestStepRunnerValidator,
    status: ingestStepStatusValidator,
    workflowEventName: v.optional(v.string()),
    modalFunctionCallId: v.optional(v.string()),
    failureCode: v.optional(ingestFailureCodeValidator),
    failureDetail: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_ingestJobId", ["ingestJobId"])
    .index("by_ingestJobId_and_stepName", ["ingestJobId", "stepName"])
    .index("by_ingestJobId_and_stepName_and_attemptNumber", [
      "ingestJobId",
      "stepName",
      "attemptNumber",
    ]),
  ingestArtifacts: defineTable({
    ingestJobId: v.id("ingestJobs"),
    stepName: ingestStepNameValidator,
    kind: ingestArtifactKindValidator,
    path: v.string(),
    fileName: v.string(),
    contentType: v.optional(v.string()),
    size: v.optional(v.number()),
    isCanonical: v.boolean(),
    expiresAt: v.optional(v.number()),
    createdByAttemptId: v.optional(v.id("ingestStepAttempts")),
  })
    .index("by_ingestJobId", ["ingestJobId"])
    .index("by_ingestJobId_and_kind", ["ingestJobId", "kind"]),
  uploadSessions: defineTable({
    ownerTokenIdentifier: v.string(),
    muxUploadId: v.string(),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
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
    playbackMode: v.optional(playbackModeValidator),
    providerAssetId: v.string(),
    providerUploadId: v.optional(v.string()),
  }).index("by_setId_and_isActive", ["setId", "isActive"]),
});
