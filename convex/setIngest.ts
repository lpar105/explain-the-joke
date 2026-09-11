import type { WorkflowCtx, WorkflowId } from "@convex-dev/workflow";
import { sendEvent, start } from "@convex-dev/workflow";
import { v } from "convex/values";

import { normalizeLaughRegionsAfterLines } from "../lib/set-ingest-orchestration";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import {
  bunnyStorage,
  getBunnyArtifactCdnUrl,
  getBunnyArtifactStorageUrl,
  getBunnyStorageApiKey,
} from "./bunny";
import { workflow } from "./workflow";

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

const ingestArtifactKindValidator = v.union(
  v.literal("retainedMedia"),
  v.literal("playbackMedia"),
  v.literal("cleanedAudio"),
  v.literal("transcriptRaw"),
  v.literal("laughCandidatesRaw"),
  v.literal("linesNormalized"),
  v.literal("laughRegionsNormalized"),
);

const modalStepResultValidator = v.object({
  attemptNumber: v.number(),
  outcome: v.union(v.literal("succeeded"), v.literal("failed")),
});

const artifactInputValidator = v.object({
  kind: ingestArtifactKindValidator,
  key: v.string(),
  fileName: v.string(),
  contentType: v.optional(v.string()),
  isCanonical: v.boolean(),
  size: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
});

type IngestStepName =
  | "prepareRetainedMedia"
  | "startBunnyPlaybackMigration"
  | "awaitBunnyPlaybackReady"
  | "cleanupMuxPlayback"
  | "transcribeWords"
  | "normalizeLines"
  | "preprocessLaughAudio"
  | "detectLaughCandidates"
  | "normalizeLaughRegions";

type ModalExternalStepName =
  | "prepareRetainedMedia"
  | "transcribeWords"
  | "preprocessLaughAudio"
  | "detectLaughCandidates";

type BreakdownPath = "line" | "laugh";

const normalizedLineValidator = v.object({
  ordinal: v.number(),
  startSeconds: v.number(),
  endSeconds: v.number(),
  text: v.string(),
  wordCount: v.number(),
  laughCount: v.number(),
  laughIntensityScore: v.number(),
});

const normalizedLaughRegionValidator = v.object({
  lineOrdinal: v.number(),
  ordinal: v.number(),
  startSeconds: v.number(),
  endSeconds: v.number(),
  intensityScore: v.number(),
});

type TranscriptWord = {
  word: string;
  start: number;
  end: number;
  sentence_idx?: number;
};

type TranscriptArtifactPayload = {
  text?: string;
  words?: TranscriptWord[];
  sentences?: Array<{
    index?: number;
    start?: number;
    end?: number;
    text?: string;
  }>;
};

type LaughCandidatesPayload = {
  sample_rate?: number;
  total_duration?: number;
  segments?: Array<{
    start_time?: number;
    end_time?: number;
    duration?: number;
    intensity_score?: number;
  }>;
};

function buildExpectedArtifactKey(args: {
  setId: Id<"sets">;
  breakdownId: Id<"breakdowns">;
  stepName: IngestStepName;
  attemptNumber?: number;
  fileName: string;
}) {
  const stepSegment =
    args.attemptNumber === undefined
      ? args.stepName
      : `${args.stepName}/attempt-${args.attemptNumber}`;

  return [
    "set-ingest",
    args.setId,
    args.breakdownId,
    stepSegment,
    args.fileName,
  ].join("/");
}

function roundToMillis(value: number) {
  return Number(value.toFixed(3));
}

function base64FromText(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in the Convex environment.`);
  }

  return value;
}

async function deleteMuxAssetFromTemporaryPlayback(assetId: string) {
  const tokenId = requireEnv("MUX_TOKEN_ID");
  const tokenSecret = requireEnv("MUX_TOKEN_SECRET");
  const authorization = `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`;
  const response = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, {
    method: "DELETE",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Mux cleanup failed for asset ${assetId}: ${response.status} ${response.statusText} ${errorBody}`,
    );
  }
}

function joinWords(words: string[]) {
  let result = "";

  for (const word of words) {
    if (!word) {
      continue;
    }

    if (/^[,.;!?)]/.test(word)) {
      result += word;
    } else if (result.endsWith("(") || result.length === 0) {
      result += word;
    } else {
      result += ` ${word}`;
    }
  }

  return result.trim();
}

function mergeIntensityScores(intensities: number[]) {
  if (intensities.length === 0) {
    return 0;
  }

  let merged = 1;
  for (const intensity of intensities) {
    const clamped = Math.max(0, Math.min(1, intensity));
    merged *= 1 - clamped;
  }

  return Number((1 - merged).toFixed(4));
}

async function fetchArtifactJson<T>(key: string): Promise<T> {
  const response = await fetch(getBunnyArtifactStorageUrl(key), {
    headers: {
      AccessKey: getBunnyStorageApiKey(),
    },
  });
  if (!response.ok) {
    throw new Error(`Artifact fetch failed for ${key}: ${response.status}`);
  }

  return (await response.json()) as T;
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForBunnyArtifactPlayback(args: {
  playbackUrl: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}) {
  const pollIntervalMs = args.pollIntervalMs ?? 60_000;
  const timeoutMs = args.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  let lastFailure = "Bunny CDN has not returned playable media yet.";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(args.playbackUrl, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          Range: "bytes=0-0",
        },
      });
      const isReady = response.status === 200 || response.status === 206;
      await response.body?.cancel();

      if (isReady) {
        return;
      }

      lastFailure = `Bunny CDN returned ${response.status}.`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await wait(pollIntervalMs);
  }

  throw new Error(
    `Bunny playback did not become ready to view before timeout. ${lastFailure}`,
  );
}

function normalizeTranscriptWords(payload: TranscriptArtifactPayload) {
  const words = (payload.words ?? [])
    .map((word) => ({
      word: String(word.word ?? "").trim(),
      start: Number(word.start ?? 0),
      end: Number(word.end ?? word.start ?? 0),
    }))
    .filter(
      (word) =>
        word.word.length > 0 &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end),
    )
    .sort((left, right) => left.start - right.start);

  return words;
}

function normalizeTranscriptSentences(args: {
  payload: TranscriptArtifactPayload;
  totalDurationHint?: number;
}) {
  const { payload, totalDurationHint } = args;
  const words = normalizeTranscriptWords(payload);

  if (words.length === 0) {
    const fallbackText = String(payload.text ?? "").trim();
    if (!fallbackText) {
      return [];
    }

    return [
      {
        ordinal: 1,
        startSeconds: 0,
        endSeconds: roundToMillis(Math.max(totalDurationHint ?? 0, 0)),
        text: fallbackText,
        wordCount: fallbackText.split(/\s+/).filter(Boolean).length,
        laughCount: 0,
        laughIntensityScore: 0,
      },
    ];
  }

  const maxChars = 72;
  const minChars = 24;
  const maxDurationSeconds = 8;
  const pauseSplitSeconds = 0.65;
  const punctuationSplit = /[.!?]$/;

  const rawLines: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
    wordCount: number;
  }> = [];
  let chunk: TranscriptWord[] = [];

  const flushChunk = () => {
    if (chunk.length === 0) {
      return;
    }

    rawLines.push({
      startSeconds: chunk[0].start,
      endSeconds: chunk[chunk.length - 1].end,
      text: joinWords(chunk.map((word) => word.word)),
      wordCount: chunk.length,
    });
    chunk = [];
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const prospectiveChunk = [...chunk, word];
    const nextWord = words[index + 1] ?? null;
    const prospectiveText = joinWords(
      prospectiveChunk.map((item) => item.word),
    );
    const duration =
      prospectiveChunk[prospectiveChunk.length - 1].end -
      prospectiveChunk[0].start;
    const pauseAfter =
      nextWord === null ? 0 : Math.max(0, nextWord.start - word.end);
    const endsSentence = punctuationSplit.test(word.word);

    chunk = prospectiveChunk;

    const shouldSplit =
      prospectiveText.length >= maxChars ||
      ((endsSentence || pauseAfter >= pauseSplitSeconds) &&
        prospectiveText.length >= minChars) ||
      (duration >= maxDurationSeconds && prospectiveText.length >= minChars);

    if (shouldSplit) {
      flushChunk();
    }
  }

  flushChunk();

  const normalizedTotalDuration = roundToMillis(
    Math.max(
      totalDurationHint ?? 0,
      rawLines[rawLines.length - 1]?.endSeconds ?? 0,
    ),
  );

  return rawLines.map((line, index) => {
    const nextLine = rawLines[index + 1] ?? null;
    const startSeconds =
      index === 0 ? 0 : roundToMillis(rawLines[index - 1].endSeconds);
    const endSeconds = roundToMillis(
      nextLine?.startSeconds ?? Math.max(normalizedTotalDuration, line.endSeconds),
    );

    return {
      ordinal: index + 1,
      startSeconds,
      endSeconds: Math.max(endSeconds, startSeconds),
      text: line.text,
      wordCount: line.wordCount,
      laughCount: 0,
      laughIntensityScore: 0,
    };
  });
}

function buildNormalizedLaughRegions(args: {
  lines: Array<{
    ordinal: number;
    startSeconds: number;
    endSeconds: number;
  }>;
  payload: LaughCandidatesPayload;
}) {
  const candidateSegments = (args.payload.segments ?? [])
    .map((segment) => ({
      startSeconds: Number(segment.start_time ?? 0),
      endSeconds: Number(segment.end_time ?? segment.start_time ?? 0),
      intensityScore: Number(segment.intensity_score ?? 0),
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.startSeconds) &&
        Number.isFinite(segment.endSeconds) &&
        segment.endSeconds > segment.startSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);

  const mergedSegments: typeof candidateSegments = [];
  for (const segment of candidateSegments) {
    const previous = mergedSegments[mergedSegments.length - 1];
    if (
      previous &&
      segment.startSeconds <= previous.endSeconds + 0.2
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, segment.endSeconds);
      previous.intensityScore = Math.max(
        previous.intensityScore,
        segment.intensityScore,
      );
      continue;
    }

    mergedSegments.push({ ...segment });
  }

  const normalizedSegments: Array<{
    lineOrdinal: number;
    ordinal: number;
    startSeconds: number;
    endSeconds: number;
    intensityScore: number;
  }> = [];

  for (const segment of mergedSegments) {
    const owningLine =
      args.lines.find(
        (line) =>
          segment.startSeconds >= line.startSeconds &&
          segment.startSeconds <= line.endSeconds,
      ) ??
      [...args.lines]
        .reverse()
        .find((line) => line.startSeconds <= segment.startSeconds) ??
      args.lines[0];

    if (!owningLine) {
      continue;
    }

    normalizedSegments.push({
      lineOrdinal: owningLine.ordinal,
      ordinal: normalizedSegments.length + 1,
      startSeconds: roundToMillis(
        Math.max(segment.startSeconds, owningLine.startSeconds),
      ),
      endSeconds: roundToMillis(
        Math.max(segment.endSeconds, segment.startSeconds),
      ),
      intensityScore: Number(
        Math.max(0, Math.min(1, segment.intensityScore)).toFixed(4),
      ),
    });
  }

  return normalizedSegments;
}

async function refreshBreakdownEditability(
  ctx: MutationCtx,
  breakdownId: Id<"breakdowns">,
) {
  const breakdown = await ctx.db.get(breakdownId);
  if (breakdown === null) {
    return;
  }

  const shouldBeEditable =
    breakdown.lineSeedingState === "ready" &&
    (breakdown.laughSeedingState === "ready" ||
      breakdown.laughSeedingState === "failed");

  if (!shouldBeEditable || breakdown.editability === "editable") {
    return;
  }

  await ctx.db.patch(breakdownId, {
    editability: "editable",
    editableAt: Date.now(),
  });
}

export const attachWorkflow = internalMutation({
  args: {
    ingestJobId: v.id("ingestJobs"),
    workflowId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ingestJobId, {
      workflowId: args.workflowId,
    });
  },
});

export const markJobRunning = internalMutation({
  args: {
    ingestJobId: v.id("ingestJobs"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ingestJobId, {
      status: "running",
    });
  },
});

export const completeJob = internalMutation({
  args: {
    ingestJobId: v.id("ingestJobs"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ingestJobId, {
      completedAt: Date.now(),
      status: "completed",
    });
  },
});

export const failJob = internalMutation({
  args: {
    ingestJobId: v.id("ingestJobs"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ingestJobId, {
      failedAt: Date.now(),
      status: "failed",
    });
  },
});

export const setBreakdownPathState = internalMutation({
  args: {
    breakdownId: v.id("breakdowns"),
    failureCode: v.optional(ingestFailureCodeValidator),
    failureDetail: v.optional(v.string()),
    path: v.union(v.literal("line"), v.literal("laugh")),
    state: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("retrying"),
      v.literal("ready"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, args) => {
    const breakdown = await ctx.db.get(args.breakdownId);
    if (breakdown === null) {
      return;
    }

    const patch =
      args.path === "line"
        ? {
            lineFailureCode: args.failureCode,
            lineFailureDetail: args.failureDetail,
            lineSeededAt: args.state === "ready" ? Date.now() : breakdown.lineSeededAt,
            lineSeedingState: args.state,
          }
        : {
            laughFailureCode: args.failureCode,
            laughFailureDetail: args.failureDetail,
            laughSeededAt:
              args.state === "ready" ? Date.now() : breakdown.laughSeededAt,
            laughSeedingState: args.state,
          };

    await ctx.db.patch(args.breakdownId, patch);
    await refreshBreakdownEditability(ctx, args.breakdownId);
  },
});

export const beginStepAttempt = internalMutation({
  args: {
    ingestJobId: v.id("ingestJobs"),
    runner: v.union(v.literal("convex"), v.literal("modal")),
    stepName: ingestStepNameValidator,
    workflowEventName: v.optional(v.string()),
  },
  returns: v.object({
    attemptId: v.id("ingestStepAttempts"),
    attemptNumber: v.number(),
  }),
  handler: async (ctx, args) => {
    const previousAttempts = await ctx.db
      .query("ingestStepAttempts")
      .withIndex("by_ingestJobId_and_stepName", (q) =>
        q.eq("ingestJobId", args.ingestJobId).eq("stepName", args.stepName),
      )
      .order("desc")
      .take(10);

    const attemptNumber =
      previousAttempts.length === 0
        ? 1
        : Math.max(...previousAttempts.map((attempt) => attempt.attemptNumber)) + 1;

    const attemptId = await ctx.db.insert("ingestStepAttempts", {
      attemptNumber,
      ingestJobId: args.ingestJobId,
      runner: args.runner,
      startedAt: Date.now(),
      status: "running",
      stepName: args.stepName,
      workflowEventName: args.workflowEventName,
    });

    return { attemptId, attemptNumber };
  },
});

export const attachModalCallToAttempt = internalMutation({
  args: {
    attemptId: v.id("ingestStepAttempts"),
    modalFunctionCallId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attemptId, {
      modalFunctionCallId: args.modalFunctionCallId,
    });
  },
});

export const failStepAttempt = internalMutation({
  args: {
    attemptId: v.id("ingestStepAttempts"),
    failureCode: ingestFailureCodeValidator,
    failureDetail: v.optional(v.string()),
    modalFunctionCallId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attemptId, {
      failureCode: args.failureCode,
      failureDetail: args.failureDetail,
      finishedAt: Date.now(),
      modalFunctionCallId: args.modalFunctionCallId,
      status: "failed",
    });
  },
});

export const getIngestJobContext = internalQuery({
  args: {
    ingestJobId: v.id("ingestJobs"),
  },
  returns: v.object({
    breakdownId: v.id("breakdowns"),
    setId: v.id("sets"),
    workflowId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const ingestJob = await ctx.db.get(args.ingestJobId);
    if (ingestJob === null) {
      throw new Error("Missing ingest job.");
    }

    return {
      breakdownId: ingestJob.breakdownId,
      setId: ingestJob.setId,
      workflowId: ingestJob.workflowId,
    };
  },
});

export const getRetainedMediaSourceContext = internalQuery({
  args: {
    ingestJobId: v.id("ingestJobs"),
  },
  returns: v.object({
    breakdownId: v.id("breakdowns"),
    ingestJobId: v.id("ingestJobs"),
    muxAssetId: v.string(),
    muxPlaybackId: v.string(),
    setId: v.id("sets"),
    trimRangeEndSeconds: v.number(),
    trimRangeStartSeconds: v.number(),
  }),
  handler: async (ctx, args) => {
    const ingestJob = await ctx.db.get(args.ingestJobId);
    if (ingestJob === null) {
      throw new Error("Missing ingest job.");
    }

    const set = await ctx.db.get(ingestJob.setId);
    if (set === null) {
      throw new Error("Missing Set for ingest job.");
    }

    const playbackSource = await ctx.db
      .query("playbackSources")
      .withIndex("by_setId_and_isActive", (q) =>
        q.eq("setId", ingestJob.setId).eq("isActive", true),
      )
      .unique();

    if (playbackSource === null || playbackSource.provider !== "mux") {
      throw new Error(
        "Missing active temporary Mux playback source for retained media.",
      );
    }

    return {
      breakdownId: ingestJob.breakdownId,
      ingestJobId: ingestJob._id,
      muxAssetId: playbackSource.providerAssetId,
      muxPlaybackId: playbackSource.playbackId,
      setId: ingestJob.setId,
      trimRangeEndSeconds: set.trimRangeEndSeconds,
      trimRangeStartSeconds: set.trimRangeStartSeconds,
    };
  },
});

export const activatePlaybackFromCanonicalArtifact = internalAction({
  args: {
    ingestJobId: v.id("ingestJobs"),
    setId: v.id("sets"),
  },
  returns: v.union(
    v.object({
      status: v.literal("skipped"),
      reason: v.string(),
    }),
    v.object({
      playbackUrl: v.string(),
      status: v.literal("completed"),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        status: "skipped";
        reason: string;
      }
    | {
        playbackUrl: string;
        status: "completed";
      }
  > => {
    const playbackSource = await ctx.runQuery(
      internal.sets.getActivePlaybackSourceInternal,
      { setId: args.setId },
    );

    if (playbackSource === null || playbackSource.provider !== "mux") {
      return {
        status: "skipped",
        reason: "No active temporary Mux playback source needs migration.",
      };
    }

    const playbackArtifact = await ctx.runQuery(
      internal.setIngest.getCanonicalArtifact,
      {
        ingestJobId: args.ingestJobId,
        kind: "playbackMedia",
      },
    );

    if (playbackArtifact === null) {
      return {
        status: "skipped",
        reason: "No canonical playback artifact is available yet.",
      };
    }

    const playbackUrl = getBunnyArtifactCdnUrl(playbackArtifact.key);
    await waitForBunnyArtifactPlayback({ playbackUrl });

    await ctx.runMutation(internal.sets.activateBunnyPlaybackSourceInternal, {
      playbackMode: "direct",
      playbackUrl,
      providerAssetId: playbackArtifact.key,
      setId: args.setId,
    });

    return {
      playbackUrl,
      status: "completed",
    };
  },
});

export const cleanupTemporaryMuxPlayback = internalAction({
  args: {
    setId: v.id("sets"),
  },
  returns: v.union(
    v.object({
      reason: v.string(),
      status: v.literal("skipped"),
    }),
    v.object({
      cleanedPlaybackSourceCount: v.number(),
      deletedAssetCount: v.number(),
      status: v.literal("completed"),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        reason: string;
        status: "skipped";
      }
    | {
        cleanedPlaybackSourceCount: number;
        deletedAssetCount: number;
        status: "completed";
      }
  > => {
    const activePlaybackSource = await ctx.runQuery(
      internal.sets.getActivePlaybackSourceInternal,
      { setId: args.setId },
    );

    if (activePlaybackSource === null || activePlaybackSource.provider !== "bunny") {
      return {
        reason: "Bunny playback is not active yet, so temporary Mux playback stays in place.",
        status: "skipped",
      };
    }

    const playbackSources = await ctx.runQuery(
      internal.sets.getPlaybackSourcesForSetInternal,
      { setId: args.setId },
    );
    const temporaryMuxSources = playbackSources.filter(
      (playbackSource) =>
        playbackSource.provider === "mux" && playbackSource.kind === "temporary",
    );

    if (temporaryMuxSources.length === 0) {
      return {
        reason: "No temporary Mux playback source remains to clean up.",
        status: "skipped",
      };
    }

    const deletedAssetIds = new Set<string>();
    for (const playbackSource of temporaryMuxSources) {
      if (deletedAssetIds.has(playbackSource.providerAssetId)) {
        continue;
      }

      await deleteMuxAssetFromTemporaryPlayback(playbackSource.providerAssetId);
      deletedAssetIds.add(playbackSource.providerAssetId);
    }

    await ctx.runMutation(internal.sets.deletePlaybackSourcesInternal, {
      playbackSourceIds: temporaryMuxSources.map((playbackSource) => playbackSource._id),
    });

    return {
      cleanedPlaybackSourceCount: temporaryMuxSources.length,
      deletedAssetCount: deletedAssetIds.size,
      status: "completed",
    };
  },
});

export const getCanonicalArtifact = internalQuery({
  args: {
    ingestJobId: v.id("ingestJobs"),
    kind: ingestArtifactKindValidator,
  },
  returns: v.union(
    v.object({
      contentType: v.optional(v.string()),
      fileName: v.string(),
      isCanonical: v.boolean(),
      key: v.string(),
      kind: ingestArtifactKindValidator,
      size: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("ingestArtifacts")
      .withIndex("by_ingestJobId_and_kind", (q) =>
        q.eq("ingestJobId", args.ingestJobId).eq("kind", args.kind),
      )
      .order("desc")
      .take(20);

    const canonical = artifact.find((item) => item.isCanonical);
    if (!canonical) {
      return null;
    }

    return {
      contentType: canonical.contentType,
      fileName: canonical.fileName,
      isCanonical: canonical.isCanonical,
      key: canonical.path,
      kind: canonical.kind,
      size: canonical.size,
    };
  },
});

export const registerArtifactMetadata = internalMutation({
  args: {
    createdByAttemptId: v.optional(v.id("ingestStepAttempts")),
    expiresAt: v.optional(v.number()),
    fileName: v.string(),
    ingestJobId: v.id("ingestJobs"),
    isCanonical: v.boolean(),
    key: v.string(),
    kind: ingestArtifactKindValidator,
    size: v.optional(v.number()),
    stepName: ingestStepNameValidator,
    contentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.isCanonical) {
      const priorCanonical = await ctx.db
        .query("ingestArtifacts")
        .withIndex("by_ingestJobId_and_kind", (q) =>
          q.eq("ingestJobId", args.ingestJobId).eq("kind", args.kind),
        )
        .take(20);

      for (const artifact of priorCanonical) {
        if (artifact.isCanonical) {
          await ctx.db.patch(artifact._id, {
            isCanonical: false,
          });
        }
      }
    }

    await ctx.db.insert("ingestArtifacts", {
      contentType: args.contentType,
      createdByAttemptId: args.createdByAttemptId,
      expiresAt: args.expiresAt,
      fileName: args.fileName,
      ingestJobId: args.ingestJobId,
      isCanonical: args.isCanonical,
      kind: args.kind,
      path: args.key,
      size: args.size,
      stepName: args.stepName,
    });
  },
});

export const replaceNormalizedLines = internalMutation({
  args: {
    breakdownId: v.id("breakdowns"),
    lines: v.array(normalizedLineValidator),
  },
  returns: v.array(v.id("lines")),
  handler: async (ctx, args) => {
    while (true) {
      const existing = await ctx.db
        .query("lines")
        .withIndex("by_breakdownId_and_ordinal", (q) =>
          q.eq("breakdownId", args.breakdownId),
        )
        .take(128);

      if (existing.length === 0) {
        break;
      }

      for (const line of existing) {
        await ctx.db.delete(line._id);
      }
    }

    const lineIds: Array<Id<"lines">> = [];
    for (const line of args.lines) {
      lineIds.push(
        await ctx.db.insert("lines", {
          breakdownId: args.breakdownId,
          ordinal: line.ordinal,
          startSeconds: line.startSeconds,
          endSeconds: line.endSeconds,
          text: line.text,
          wordCount: line.wordCount,
          laughCount: line.laughCount,
          laughIntensityScore: line.laughIntensityScore,
        }),
      );
    }

    return lineIds;
  },
});

export const replaceNormalizedLaughRegions = internalMutation({
  args: {
    breakdownId: v.id("breakdowns"),
    laughRegions: v.array(normalizedLaughRegionValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    while (true) {
      const existingLaughs = await ctx.db
        .query("laughRegions")
        .withIndex("by_breakdownId_and_ordinal", (q) =>
          q.eq("breakdownId", args.breakdownId),
        )
        .take(128);

      if (existingLaughs.length === 0) {
        break;
      }

      for (const laughRegion of existingLaughs) {
        await ctx.db.delete(laughRegion._id);
      }
    }

    const lines = await ctx.db
      .query("lines")
      .withIndex("by_breakdownId_and_ordinal", (q) =>
        q.eq("breakdownId", args.breakdownId),
      )
      .take(2_000);

    const linesByOrdinal = new Map(lines.map((line) => [line.ordinal, line] as const));
    const laughsByLineOrdinal = new Map<number, typeof args.laughRegions>();

    for (const laughRegion of args.laughRegions) {
      const existing = laughsByLineOrdinal.get(laughRegion.lineOrdinal) ?? [];
      existing.push(laughRegion);
      laughsByLineOrdinal.set(laughRegion.lineOrdinal, existing);
    }

    for (const line of lines) {
      const assignedLaughs = laughsByLineOrdinal.get(line.ordinal) ?? [];
      await ctx.db.patch(line._id, {
        laughCount: assignedLaughs.length,
        laughIntensityScore: mergeIntensityScores(
          assignedLaughs.map((laugh) => laugh.intensityScore),
        ),
      });
    }

    for (const laughRegion of args.laughRegions) {
      const line = linesByOrdinal.get(laughRegion.lineOrdinal);
      if (!line) {
        throw new Error(
          `Missing line ${laughRegion.lineOrdinal} while saving laugh regions.`,
        );
      }

      await ctx.db.insert("laughRegions", {
        breakdownId: args.breakdownId,
        lineId: line._id,
        ordinal: laughRegion.ordinal,
        startSeconds: laughRegion.startSeconds,
        endSeconds: laughRegion.endSeconds,
        intensityScore: laughRegion.intensityScore,
      });
    }

    return null;
  },
});

export const reportModalStepResult = internalMutation({
  args: {
    artifacts: v.optional(v.array(artifactInputValidator)),
    attemptNumber: v.number(),
    failureCode: v.optional(ingestFailureCodeValidator),
    failureDetail: v.optional(v.string()),
    ingestJobId: v.id("ingestJobs"),
    modalFunctionCallId: v.optional(v.string()),
    outcome: v.union(v.literal("succeeded"), v.literal("failed")),
    stepName: ingestStepNameValidator,
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("ingestStepAttempts")
      .withIndex("by_ingestJobId_and_stepName_and_attemptNumber", (q) =>
        q
          .eq("ingestJobId", args.ingestJobId)
          .eq("stepName", args.stepName)
          .eq("attemptNumber", args.attemptNumber),
      )
      .unique();

    if (attempt === null) {
      throw new Error("Missing ingest step attempt.");
    }

    await ctx.db.patch(attempt._id, {
      failureCode: args.failureCode,
      failureDetail: args.failureDetail,
      finishedAt: Date.now(),
      modalFunctionCallId: args.modalFunctionCallId ?? attempt.modalFunctionCallId,
      status: args.outcome === "succeeded" ? "succeeded" : "failed",
    });

    for (const artifact of args.artifacts ?? []) {
      await ctx.runMutation(internal.setIngest.registerArtifactMetadata, {
        contentType: artifact.contentType,
        createdByAttemptId: attempt._id,
        expiresAt: artifact.expiresAt,
        fileName: artifact.fileName,
        ingestJobId: args.ingestJobId,
        isCanonical: artifact.isCanonical,
        key: artifact.key,
        kind: artifact.kind,
        size: artifact.size,
        stepName: args.stepName,
      });
    }

    const ingestJob = await ctx.db.get(args.ingestJobId);
    if (ingestJob === null || !ingestJob.workflowId || !attempt.workflowEventName) {
      return;
    }

    await sendEvent(ctx, components.workflow, {
      name: attempt.workflowEventName,
      validator: modalStepResultValidator,
      value: {
        attemptNumber: args.attemptNumber,
        outcome: args.outcome,
      },
      workflowId: ingestJob.workflowId as WorkflowId,
    });
  },
});

export const startSetIngest = internalMutation({
  args: {
    ingestJobId: v.id("ingestJobs"),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const workflowId: WorkflowId = await start(
      ctx,
      internal.setIngest.runSetIngest,
      { ingestJobId: args.ingestJobId },
      { startAsync: true },
    );

    await ctx.runMutation(internal.setIngest.attachWorkflow, {
      ingestJobId: args.ingestJobId,
      workflowId,
    });

    return workflowId;
  },
});

export const normalizeLines = internalAction({
  args: {
    breakdownId: v.id("breakdowns"),
    ingestJobId: v.id("ingestJobs"),
  },
  returns: v.object({
    artifactKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const transcript = await ctx.runQuery(internal.setIngest.getCanonicalArtifact, {
      ingestJobId: args.ingestJobId,
      kind: "transcriptRaw",
    });

    if (transcript === null) {
      throw new Error("Missing transcript artifact for line normalization.");
    }

    const laughCandidates = await ctx.runQuery(
      internal.setIngest.getCanonicalArtifact,
      {
        ingestJobId: args.ingestJobId,
        kind: "laughCandidatesRaw",
      },
    );
    const laughPayload = laughCandidates
      ? await fetchArtifactJson<LaughCandidatesPayload>(laughCandidates.key)
      : null;
    const transcriptPayload =
      await fetchArtifactJson<TranscriptArtifactPayload>(transcript.key);

    const normalizedLines = normalizeTranscriptSentences({
      payload: transcriptPayload,
      totalDurationHint: laughPayload?.total_duration,
    });

    await ctx.runMutation(internal.setIngest.replaceNormalizedLines, {
      breakdownId: args.breakdownId,
      lines: normalizedLines,
    });

    const artifactKey = buildExpectedArtifactKey({
      breakdownId: args.breakdownId,
      attemptNumber: 1,
      fileName: "lines-normalized.json",
      setId: (
        await ctx.runQuery(internal.setIngest.getIngestJobContext, {
          ingestJobId: args.ingestJobId,
        })
      ).setId,
      stepName: "normalizeLines",
    });
    const artifactUpload = await bunnyStorage.upload(ctx, {
      path: artifactKey.split("/").slice(0, -1).join("/"),
      fileName: "lines-normalized.json",
      fileData: base64FromText(JSON.stringify({ lines: normalizedLines })),
      contentType: "application/json",
    });

    await ctx.runMutation(internal.setIngest.registerArtifactMetadata, {
      contentType: "application/json",
      fileName: "lines-normalized.json",
      ingestJobId: args.ingestJobId,
      isCanonical: true,
      key: artifactUpload.key,
      kind: "linesNormalized",
      stepName: "normalizeLines",
    });

    return {
      artifactKey: artifactUpload.key,
    };
  },
});

export const normalizeLaughRegions = internalAction({
  args: {
    breakdownId: v.id("breakdowns"),
    ingestJobId: v.id("ingestJobs"),
  },
  returns: v.object({
    artifactKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const candidates = await ctx.runQuery(internal.setIngest.getCanonicalArtifact, {
      ingestJobId: args.ingestJobId,
      kind: "laughCandidatesRaw",
    });

    if (candidates === null) {
      throw new Error("Missing laugh candidates artifact for normalization.");
    }

    const lines: Array<{
      ordinal: number;
      startSeconds: number;
      endSeconds: number;
    }> = await ctx.runQuery(internal.sets.getBreakdownLinesInternal, {
      breakdownId: args.breakdownId,
    });

    if (lines.length === 0) {
      throw new Error(
        "Missing normalized lines before laugh region normalization.",
      );
    }

    const candidatePayload =
      await fetchArtifactJson<LaughCandidatesPayload>(candidates.key);
    const normalizedLaughs = buildNormalizedLaughRegions({
      lines: lines.map((line) => ({
        ordinal: line.ordinal,
        startSeconds: line.startSeconds,
        endSeconds: line.endSeconds,
      })),
      payload: candidatePayload,
    });

    await ctx.runMutation(internal.setIngest.replaceNormalizedLaughRegions, {
      breakdownId: args.breakdownId,
      laughRegions: normalizedLaughs,
    });

    const artifactKey = buildExpectedArtifactKey({
      breakdownId: args.breakdownId,
      attemptNumber: 1,
      fileName: "laugh-regions-normalized.json",
      setId: (
        await ctx.runQuery(internal.setIngest.getIngestJobContext, {
          ingestJobId: args.ingestJobId,
        })
      ).setId,
      stepName: "normalizeLaughRegions",
    });
    const artifactUpload = await bunnyStorage.upload(ctx, {
      path: artifactKey.split("/").slice(0, -1).join("/"),
      fileName: "laugh-regions-normalized.json",
      fileData: base64FromText(
        JSON.stringify({ laughRegions: normalizedLaughs }),
      ),
      contentType: "application/json",
    });

    await ctx.runMutation(internal.setIngest.registerArtifactMetadata, {
      contentType: "application/json",
      fileName: "laugh-regions-normalized.json",
      ingestJobId: args.ingestJobId,
      isCanonical: true,
      key: artifactUpload.key,
      kind: "laughRegionsNormalized",
      stepName: "normalizeLaughRegions",
    });

    return {
      artifactKey: artifactUpload.key,
    };
  },
});

async function runModalStepWithRetries(args: {
  breakdownId: Id<"breakdowns">;
  ingestJobId: Id<"ingestJobs">;
  inputArtifacts: Array<
    "retainedMedia" | "transcriptRaw" | "cleanedAudio" | "laughCandidatesRaw"
  >;
  maxAttempts: number;
  outputArtifacts?: Array<{
    contentType?: string;
    fileName: string;
    kind:
      | "retainedMedia"
      | "playbackMedia"
      | "cleanedAudio"
      | "transcriptRaw"
      | "laughCandidatesRaw";
  }>;
  path?: BreakdownPath;
  step: WorkflowCtx;
  stepName: ModalExternalStepName;
  trimSource?: {
    muxAssetId: string;
    muxPlaybackId: string;
    sourceHlsUrl: string;
    trimRangeEndSeconds: number;
    trimRangeStartSeconds: number;
  };
}) {
  const {
    breakdownId,
    ingestJobId,
    inputArtifacts,
    maxAttempts,
    outputArtifacts,
    path,
    step,
    stepName,
    trimSource,
  } =
    args;

  for (let index = 0; index < maxAttempts; index += 1) {
    const attemptState = index === 0 ? "running" : "retrying";

    if (path) {
      await step.runMutation(internal.setIngest.setBreakdownPathState, {
        breakdownId,
        path,
        state: attemptState,
      });
    }

    const workflowEventName = `${stepName}:${index + 1}`;
    const started = await step.runMutation(internal.setIngest.beginStepAttempt, {
      ingestJobId,
      runner: "modal",
      stepName,
      workflowEventName,
    });

    const jobContext = await step.runQuery(internal.setIngest.getIngestJobContext, {
      ingestJobId,
    });

    const resolvedInputs: Array<{
      contentType?: string;
      fileName: string;
      isCanonical: boolean;
      key: string;
      kind: "retainedMedia" | "transcriptRaw" | "cleanedAudio" | "laughCandidatesRaw";
      size?: number;
    }> = [];
    for (const kind of inputArtifacts) {
      const artifact = await step.runQuery(internal.setIngest.getCanonicalArtifact, {
        ingestJobId,
        kind,
      });

      if (artifact === null) {
        throw new Error(`Missing required ${kind} artifact before ${stepName}.`);
      }

      resolvedInputs.push({
        contentType: artifact.contentType,
        fileName: artifact.fileName,
        isCanonical: artifact.isCanonical,
        key: artifact.key,
        kind,
        size: artifact.size,
      });
    }

    try {
      const spawned = await step.runAction(
        internal.setIngestModal.spawnModalFunction,
        {
          attemptNumber: started.attemptNumber,
          breakdownId: jobContext.breakdownId,
          ingestJobId,
          inputArtifacts: resolvedInputs,
          outputArtifacts:
            outputArtifacts?.map((artifact) => ({
              contentType: artifact.contentType,
              fileName: artifact.fileName,
              isCanonical: true,
              key: buildExpectedArtifactKey({
                breakdownId: jobContext.breakdownId,
                attemptNumber: started.attemptNumber,
                fileName: artifact.fileName,
                setId: jobContext.setId,
                stepName,
              }),
              kind: artifact.kind,
            })) ?? [],
          setId: jobContext.setId,
          stepName,
          trimSource,
        },
        { retry: { maxAttempts: 2, initialBackoffMs: 1_000, base: 2 } },
      );

      await step.runMutation(internal.setIngest.attachModalCallToAttempt, {
        attemptId: started.attemptId,
        modalFunctionCallId: spawned.modalFunctionCallId,
      });
    } catch (error) {
      await step.runMutation(internal.setIngest.failStepAttempt, {
        attemptId: started.attemptId,
        failureCode: "modal_spawn_failed",
        failureDetail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const result = await step.awaitEvent({
      name: workflowEventName,
      validator: modalStepResultValidator,
    });

    if (result.outcome === "succeeded") {
      return;
    }
  }

  throw new Error(`${stepName} exhausted its retry budget.`);
}

async function runLineBranch(args: {
  breakdownId: Id<"breakdowns">;
  ingestJobId: Id<"ingestJobs">;
  step: WorkflowCtx;
}) {
  await runModalStepWithRetries({
    breakdownId: args.breakdownId,
    ingestJobId: args.ingestJobId,
    inputArtifacts: ["retainedMedia"],
    maxAttempts: 3,
    outputArtifacts: [
      {
        contentType: "application/json",
        fileName: "transcript-raw.json",
        kind: "transcriptRaw",
      },
    ],
    path: "line",
    step: args.step,
    stepName: "transcribeWords",
  });

  await args.step.runAction(
    internal.setIngest.normalizeLines,
    { breakdownId: args.breakdownId, ingestJobId: args.ingestJobId },
    { retry: false },
  );

  await args.step.runMutation(internal.setIngest.setBreakdownPathState, {
    breakdownId: args.breakdownId,
    path: "line",
    state: "ready",
  });
}

async function runLaughBranch(args: {
  breakdownId: Id<"breakdowns">;
  ingestJobId: Id<"ingestJobs">;
  linesReady: Promise<void>;
  step: WorkflowCtx;
}) {
  try {
    await runModalStepWithRetries({
      breakdownId: args.breakdownId,
      ingestJobId: args.ingestJobId,
      inputArtifacts: ["retainedMedia"],
      maxAttempts: 3,
      outputArtifacts: [
        {
          contentType: "audio/wav",
          fileName: "cleaned-audio.wav",
          kind: "cleanedAudio",
        },
      ],
      path: "laugh",
      step: args.step,
      stepName: "preprocessLaughAudio",
    });

    await runModalStepWithRetries({
      breakdownId: args.breakdownId,
      ingestJobId: args.ingestJobId,
      inputArtifacts: ["retainedMedia", "cleanedAudio"],
      maxAttempts: 3,
      outputArtifacts: [
        {
          contentType: "application/json",
          fileName: "laugh-candidates-raw.json",
          kind: "laughCandidatesRaw",
        },
      ],
      path: "laugh",
      step: args.step,
      stepName: "detectLaughCandidates",
    });

    await normalizeLaughRegionsAfterLines({
      linesReady: args.linesReady,
      normalizeLaughRegions: async () => {
        await args.step.runAction(
          internal.setIngest.normalizeLaughRegions,
          { breakdownId: args.breakdownId, ingestJobId: args.ingestJobId },
          { retry: false },
        );
      },
    });

    await args.step.runMutation(internal.setIngest.setBreakdownPathState, {
      breakdownId: args.breakdownId,
      path: "laugh",
      state: "ready",
    });
  } catch (error) {
    await args.step.runMutation(internal.setIngest.setBreakdownPathState, {
      breakdownId: args.breakdownId,
      failureCode: "laugh_normalization_failed",
      failureDetail: error instanceof Error ? error.message : String(error),
      path: "laugh",
      state: "failed",
    });
  }
}

async function runPlaybackBranch(args: {
  ingestJobId: Id<"ingestJobs">;
  setId: Id<"sets">;
  step: WorkflowCtx;
}) {
  try {
    await args.step.runAction(
      internal.setIngest.activatePlaybackFromCanonicalArtifact,
      { ingestJobId: args.ingestJobId, setId: args.setId },
      { retry: { maxAttempts: 2, initialBackoffMs: 1_000, base: 2 } },
    );
    await args.step.runAction(
      internal.setIngest.cleanupTemporaryMuxPlayback,
      { setId: args.setId },
      { retry: { maxAttempts: 2, initialBackoffMs: 1_000, base: 2 } },
    );
  } catch (error) {
    console.error("Playback migration branch failed but Set stays playable.", {
      error,
      setId: args.setId,
    });
  }
}

export const runSetIngest = workflow
  .define({
    args: {
      ingestJobId: v.id("ingestJobs"),
    },
  })
  .handler(async (step, args): Promise<void> => {
    await step.runMutation(internal.setIngest.markJobRunning, {
      ingestJobId: args.ingestJobId,
    });

    const context = await step.runQuery(internal.setIngest.getIngestJobContext, {
      ingestJobId: args.ingestJobId,
    });

    const trimSource = await step.runQuery(
      internal.setIngest.getRetainedMediaSourceContext,
      {
        ingestJobId: args.ingestJobId,
      },
    );

    try {
      await runModalStepWithRetries({
        breakdownId: context.breakdownId,
        ingestJobId: args.ingestJobId,
        inputArtifacts: [],
        maxAttempts: 3,
        outputArtifacts: [
          {
            contentType: "audio/wav",
            fileName: "retained-media.wav",
            kind: "retainedMedia",
          },
          {
            contentType: "video/mp4",
            fileName: "playback.mp4",
            kind: "playbackMedia",
          },
        ],
        step,
        stepName: "prepareRetainedMedia",
        trimSource: {
          muxAssetId: trimSource.muxAssetId,
          muxPlaybackId: trimSource.muxPlaybackId,
          sourceHlsUrl: `https://stream.mux.com/${trimSource.muxPlaybackId}.m3u8`,
          trimRangeEndSeconds: trimSource.trimRangeEndSeconds,
          trimRangeStartSeconds: trimSource.trimRangeStartSeconds,
        },
      });
    } catch (error) {
      console.error("Prepare retained media failed.", {
        error,
        ingestJobId: args.ingestJobId,
      });
      await step.runMutation(internal.setIngest.failJob, {
        ingestJobId: args.ingestJobId,
      });
      return;
    }

    try {
      const linesReady = runLineBranch({
        breakdownId: context.breakdownId,
        ingestJobId: args.ingestJobId,
        step,
      });

      await Promise.all([
        runPlaybackBranch({
          ingestJobId: args.ingestJobId,
          setId: context.setId,
          step,
        }),
        linesReady,
        runLaughBranch({
          breakdownId: context.breakdownId,
          ingestJobId: args.ingestJobId,
          linesReady,
          step,
        }),
      ]);
    } catch (error) {
      await step.runMutation(internal.setIngest.setBreakdownPathState, {
        breakdownId: context.breakdownId,
        failureCode: "line_normalization_failed",
        failureDetail: error instanceof Error ? error.message : String(error),
        path: "line",
        state: "failed",
      });
      await step.runMutation(internal.setIngest.failJob, {
        ingestJobId: args.ingestJobId,
      });
      return;
    }

    const finalBreakdown = await step.runQuery(internal.sets.getBreakdownInternal, {
      breakdownId: context.breakdownId,
    });

    if (finalBreakdown?.lineSeedingState === "failed") {
      await step.runMutation(internal.setIngest.failJob, {
        ingestJobId: args.ingestJobId,
      });
      return;
    }

    await step.runMutation(internal.setIngest.completeJob, {
      ingestJobId: args.ingestJobId,
    });
  });
