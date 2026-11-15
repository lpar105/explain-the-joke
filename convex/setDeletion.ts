import type { WorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";

import { toConvexError } from "../lib/errors";
import { bunnyStorage, getBunnyStorageApiKey, getBunnyStorageHostname, getBunnyStorageZone } from "./bunny";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { workflow } from "./workflow";

const DATA_BATCH_SIZE = 64;
const FINAL_SWEEP_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getMuxAuthorizationHeader() {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new Error("Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET in the Convex environment.");
  }

  return `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`;
}

async function deleteMuxAsset(assetId: string) {
  const response = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, {
    method: "DELETE",
    headers: { Authorization: getMuxAuthorizationHeader() },
  });

  if (response.ok || response.status === 404) {
    return;
  }

  throw new Error(`Mux asset cleanup failed with status ${response.status}.`);
}

async function cancelMuxUpload(uploadId: string) {
  const headers = { Authorization: getMuxAuthorizationHeader() };
  const lookup = await fetch(`https://api.mux.com/video/v1/uploads/${uploadId}`, {
    headers,
  });

  if (lookup.status === 404) {
    return;
  }
  if (!lookup.ok) {
    throw new Error(`Mux upload lookup failed with status ${lookup.status}.`);
  }

  const payload = (await lookup.json()) as {
    data?: { asset_id?: string; status?: string };
  };
  if (payload.data?.asset_id) {
    await deleteMuxAsset(payload.data.asset_id);
    return;
  }
  if (payload.data?.status !== "waiting") {
    return;
  }

  const cancel = await fetch(
    `https://api.mux.com/video/v1/uploads/${uploadId}/cancel`,
    { method: "PUT", headers },
  );
  if (!cancel.ok && cancel.status !== 404 && cancel.status !== 409) {
    throw new Error(`Mux upload cancellation failed with status ${cancel.status}.`);
  }
}

function encodeBunnyPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function deleteBunnyPrefix(setId: string) {
  const prefix = `set-ingest/${setId}`;
  const storageUrl = `https://${getBunnyStorageHostname()}/${getBunnyStorageZone()}/${encodeBunnyPath(prefix)}/`;
  const response = await fetch(storageUrl, {
    method: "DELETE",
    headers: { AccessKey: getBunnyStorageApiKey() },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Bunny Storage cleanup failed with status ${response.status}.`);
  }

  const cdnApiKey = process.env.BUNNY_CDN_API_KEY ?? process.env.BUNNY_ACCOUNT_API_KEY;
  const cdnHostname = process.env.BUNNY_CDN_HOSTNAME;
  if (!cdnApiKey || !cdnHostname) {
    throw new Error(
      "Missing BUNNY_CDN_API_KEY/BUNNY_ACCOUNT_API_KEY or BUNNY_CDN_HOSTNAME in the Convex environment.",
    );
  }

  const purgeUrl = `https://${cdnHostname}/${prefix}/*`;
  const purgeResponse = await fetch(
    `https://api.bunny.net/purge?url=${encodeURIComponent(purgeUrl)}&async=false`,
    {
      method: "POST",
      headers: { AccessKey: cdnApiKey },
    },
  );
  if (!purgeResponse.ok && purgeResponse.status !== 404) {
    throw new Error(`Bunny CDN purge failed with status ${purgeResponse.status}.`);
  }
}

function isMissingWorkflowError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Workflow not found") || message.includes("Invalid workflow ID");
}

export const requestDeletion = mutation({
  args: { setId: v.id("sets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw toConvexError("auth");
    }

    const set = await ctx.db.get(args.setId);
    if (set === null || set.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw toConvexError("not_found");
    }

    const existingJob = await ctx.db
      .query("setDeletionJobs")
      .withIndex("by_setId", (q) => q.eq("setId", args.setId))
      .unique();
    if (existingJob !== null) {
      await ctx.db.delete(args.setId);
      return null;
    }

    const now = Date.now();
    const deletionJobId = await ctx.db.insert("setDeletionJobs", {
      setId: args.setId,
      status: "cancelingWork",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Removing the root atomically revokes product access while the private
    // cleanup ledger retains responsibility for the remaining resources.
    await ctx.db.delete(args.setId);
    await ctx.scheduler.runAfter(0, internal.setDeletion.runCleanup, {
      deletionJobId,
    });
    return null;
  },
});

export const isSetDeleting = internalQuery({
  args: { setId: v.id("sets") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("setDeletionJobs")
      .withIndex("by_setId", (q) => q.eq("setId", args.setId))
      .unique();
    return job !== null;
  },
});

export const getCleanupSnapshot = internalQuery({
  args: { deletionJobId: v.id("setDeletionJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.deletionJobId);
    if (job === null) {
      return null;
    }

    const setId = job.setId;

    const muxAssetIds: string[] = [];
    const muxUploadIds: string[] = [];
    const workflowIds: string[] = [];
    const modalFunctionCallIds: string[] = [];
    const bunnyArtifactKeys: string[] = [];

    for await (const source of ctx.db
      .query("playbackSources")
      .withIndex("by_setId_and_isActive", (q) => q.eq("setId", setId))) {
      if (source.provider === "mux") {
        muxAssetIds.push(source.providerAssetId);
        muxUploadIds.push(source.providerUploadId ?? "");
      }
    }

    for await (const session of ctx.db
      .query("uploadSessions")
      .withIndex("by_confirmedSetId", (q) => q.eq("confirmedSetId", setId))) {
      muxAssetIds.push(session.muxAssetId ?? "");
      muxUploadIds.push(session.muxUploadId);
    }

    for await (const ingestJob of ctx.db
      .query("ingestJobs")
      .withIndex("by_setId", (q) => q.eq("setId", setId))) {
      workflowIds.push(ingestJob.workflowId ?? "", ingestJob.playbackWorkflowId ?? "");
      for await (const attempt of ctx.db
        .query("ingestStepAttempts")
        .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ingestJob._id))) {
        if (attempt.status === "running") {
          modalFunctionCallIds.push(attempt.modalFunctionCallId ?? "");
        }
        const attemptPrefix = `set-ingest/${setId}/${ingestJob.breakdownId}/${attempt.stepName}/attempt-${attempt.attemptNumber}`;
        const possibleFileNames = {
          prepareRetainedMedia: ["retained-media.wav", "playback.mp4", "thumbnail.jpg"],
          startBunnyPlaybackMigration: [],
          awaitBunnyPlaybackReady: [],
          cleanupMuxPlayback: [],
          transcribeWords: ["transcript-raw.json"],
          normalizeLines: ["lines-normalized.json"],
          preprocessLaughAudio: ["cleaned-audio.wav", "speech-reconstruction.wav", "laughter-residual.wav", "score-track.json"],
          detectLaughCandidates: ["laugh-candidates-raw.json"],
          normalizeLaughRegions: ["laugh-regions-normalized.json"],
        }[attempt.stepName];
        bunnyArtifactKeys.push(
          ...possibleFileNames.map((fileName) => `${attemptPrefix}/${fileName}`),
        );
      }
      for await (const artifact of ctx.db
        .query("ingestArtifacts")
        .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ingestJob._id))) {
        bunnyArtifactKeys.push(artifact.path);
      }
    }

    return {
      setId,
      status: job.status,
      muxAssetIds: unique(muxAssetIds),
      muxUploadIds: unique(muxUploadIds),
      workflowIds: unique(workflowIds),
      modalFunctionCallIds: unique(modalFunctionCallIds),
      bunnyArtifactKeys: unique(bunnyArtifactKeys),
    };
  },
});

export const cancelWorkflow = internalMutation({
  args: { workflowId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await workflow.cancel(ctx, args.workflowId as WorkflowId);
    return null;
  },
});

export const cleanupWorkflow = internalMutation({
  args: { workflowId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    return workflow.cleanup(ctx, args.workflowId as WorkflowId);
  },
});

export const scheduleNext = internalMutation({
  args: {
    deletionJobId: v.id("setDeletionJobs"),
    delayMs: v.number(),
    status: v.optional(
      v.union(
        v.literal("cancelingWork"),
        v.literal("deletingData"),
        v.literal("verifyingCleanup"),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.deletionJobId);
    if (job === null) {
      return null;
    }
    await ctx.db.patch(args.deletionJobId, {
      ...(args.status === undefined ? {} : { status: args.status }),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(args.delayMs, internal.setDeletion.runCleanup, {
      deletionJobId: args.deletionJobId,
    });
    return null;
  },
});

export const recordFailureAndRetry = internalMutation({
  args: { deletionJobId: v.id("setDeletionJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.deletionJobId);
    if (job === null) {
      return null;
    }

    const retryCount = job.retryCount + 1;
    const delayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      1_000 * 2 ** Math.min(retryCount - 1, 12),
    );
    await ctx.db.patch(args.deletionJobId, {
      retryCount,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(delayMs, internal.setDeletion.runCleanup, {
      deletionJobId: args.deletionJobId,
    });
    return null;
  },
});

export const deleteDataBatch = internalMutation({
  args: { deletionJobId: v.id("setDeletionJobs") },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.deletionJobId);
    if (job === null) {
      return { done: true };
    }
    const setId = job.setId;

    const uploadSessions = await ctx.db
      .query("uploadSessions")
      .withIndex("by_confirmedSetId", (q) => q.eq("confirmedSetId", setId))
      .take(DATA_BATCH_SIZE);
    if (uploadSessions.length > 0) {
      for (const session of uploadSessions) {
        await ctx.db.delete(session._id);
      }
      return { done: false };
    }

    const playbackSources = await ctx.db
      .query("playbackSources")
      .withIndex("by_setId_and_isActive", (q) => q.eq("setId", setId))
      .take(DATA_BATCH_SIZE);
    if (playbackSources.length > 0) {
      for (const source of playbackSources) {
        await ctx.db.delete(source._id);
      }
      return { done: false };
    }

    const ingestJob = await ctx.db
      .query("ingestJobs")
      .withIndex("by_setId", (q) => q.eq("setId", setId))
      .first();
    if (ingestJob !== null) {
      const attempts = await ctx.db
        .query("ingestStepAttempts")
        .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ingestJob._id))
        .take(DATA_BATCH_SIZE);
      if (attempts.length > 0) {
        for (const attempt of attempts) {
          await ctx.db.delete(attempt._id);
        }
        return { done: false };
      }

      const artifacts = await ctx.db
        .query("ingestArtifacts")
        .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ingestJob._id))
        .take(DATA_BATCH_SIZE);
      if (artifacts.length > 0) {
        for (const artifact of artifacts) {
          await ctx.db.delete(artifact._id);
        }
        return { done: false };
      }

      if (ingestJob.calibrationInputId) await ctx.storage.delete(ingestJob.calibrationInputId);
      if (ingestJob.calibrationResultId) await ctx.storage.delete(ingestJob.calibrationResultId);
      await ctx.db.delete(ingestJob._id);
      return { done: false };
    }

    const breakdown = await ctx.db
      .query("breakdowns")
      .withIndex("by_setId", (q) => q.eq("setId", setId))
      .first();
    if (breakdown !== null) {
      const laughRegions = await ctx.db
        .query("laughRegions")
        .withIndex("by_breakdownId_and_ordinal", (q) =>
          q.eq("breakdownId", breakdown._id),
        )
        .take(DATA_BATCH_SIZE);
      if (laughRegions.length > 0) {
        for (const laughRegion of laughRegions) {
          await ctx.db.delete(laughRegion._id);
        }
        return { done: false };
      }

      const lines = await ctx.db
        .query("lines")
        .withIndex("by_breakdownId_and_ordinal", (q) =>
          q.eq("breakdownId", breakdown._id),
        )
        .take(DATA_BATCH_SIZE);
      if (lines.length > 0) {
        for (const line of lines) {
          await ctx.db.delete(line._id);
        }
        return { done: false };
      }

      await ctx.db.delete(breakdown._id);
      return { done: false };
    }

    return { done: true };
  },
});

export const finishDeletion = internalMutation({
  args: { deletionJobId: v.id("setDeletionJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.deletionJobId);
    if (job !== null) {
      await ctx.db.delete(args.deletionJobId);
    }
    return null;
  },
});

async function deleteKnownBunnyArtifacts(
  ctx: ActionCtx,
  keys: string[],
) {
  for (const key of keys) {
    try {
      await bunnyStorage.deleteFile(ctx, key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("(404)")) {
        throw error;
      }
      const record = await bunnyStorage.getFileByKey(ctx, key);
      if (record !== null) {
        await bunnyStorage.removeFileRecord(ctx, record._id);
      }
    }
  }
}

async function deleteTrackedBunnyFilesUnderPrefix(ctx: ActionCtx, setId: string) {
  const prefix = `set-ingest/${setId}/`;
  const files = await bunnyStorage.listFiles(ctx, { limit: 4_096 });
  await deleteKnownBunnyArtifacts(
    ctx,
    files.filter((file) => file.key.startsWith(prefix)).map((file) => file.key),
  );
}

type CleanupSnapshot = {
  setId: Id<"sets">;
  status: "cancelingWork" | "deletingData" | "verifyingCleanup";
  muxAssetIds: string[];
  muxUploadIds: string[];
  workflowIds: string[];
  modalFunctionCallIds: string[];
  bunnyArtifactKeys: string[];
};

export const runCleanup = internalAction({
  args: { deletionJobId: v.id("setDeletionJobs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const snapshot: CleanupSnapshot | null = await ctx.runQuery(
        internal.setDeletion.getCleanupSnapshot,
        { deletionJobId: args.deletionJobId },
      );
      if (snapshot === null) {
        return null;
      }

      if (snapshot.status === "cancelingWork") {
        for (const workflowId of snapshot.workflowIds) {
          try {
            const status = await workflow.status(ctx, workflowId as WorkflowId);
            if (status.type === "inProgress") {
              await ctx.runMutation(internal.setDeletion.cancelWorkflow, { workflowId });
            }
            await ctx.runMutation(internal.setDeletion.cleanupWorkflow, { workflowId });
          } catch (error) {
            if (!isMissingWorkflowError(error)) {
              throw error;
            }
          }
        }

        if (snapshot.modalFunctionCallIds.length > 0) {
          await ctx.runAction(internal.setDeletionNode.cancelModalCalls, {
            modalFunctionCallIds: snapshot.modalFunctionCallIds,
          });
        }

        for (const assetId of snapshot.muxAssetIds) {
          await deleteMuxAsset(assetId);
        }
        for (const uploadId of snapshot.muxUploadIds) {
          await cancelMuxUpload(uploadId);
        }

        await deleteKnownBunnyArtifacts(ctx, snapshot.bunnyArtifactKeys);
        await deleteTrackedBunnyFilesUnderPrefix(ctx, snapshot.setId);
        await deleteBunnyPrefix(snapshot.setId);
        await ctx.runMutation(internal.setDeletion.scheduleNext, {
          delayMs: 0,
          deletionJobId: args.deletionJobId,
          status: "deletingData",
        });
        return null;
      }

      if (snapshot.status === "deletingData") {
        const result: { done: boolean } = await ctx.runMutation(
          internal.setDeletion.deleteDataBatch,
          { deletionJobId: args.deletionJobId },
        );
        await ctx.runMutation(internal.setDeletion.scheduleNext, {
          delayMs: result.done ? FINAL_SWEEP_DELAY_MS : 0,
          deletionJobId: args.deletionJobId,
          ...(result.done ? { status: "verifyingCleanup" as const } : {}),
        });
        return null;
      }

      // Catch output from a worker that was already committing when
      // cancellation began, then erase the cleanup ledger itself.
      await deleteTrackedBunnyFilesUnderPrefix(ctx, snapshot.setId);
      await deleteBunnyPrefix(snapshot.setId);
      await ctx.runMutation(internal.setDeletion.finishDeletion, {
        deletionJobId: args.deletionJobId,
      });
      return null;
    } catch (error) {
      console.error("Set deletion cleanup failed; retry scheduled.", {
        deletionJobId: args.deletionJobId,
        error,
      });
      await ctx.runMutation(internal.setDeletion.recordFailureAndRetry, {
        deletionJobId: args.deletionJobId,
      });
      return null;
    }
  },
});

// Uploads abandoned before trim have no Set root or ingest ledger yet.
export const cleanupUnfinishedUpload = internalAction({
  args: { uploadSessionId: v.id("uploadSessions") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const session = await ctx.runQuery(internal.setDeletion.getUnfinishedUpload, args);
    if (!session) return null;
    try {
      if (session.muxAssetId) await deleteMuxAsset(session.muxAssetId);
      await cancelMuxUpload(session.muxUploadId);
      await ctx.runMutation(internal.setDeletion.removeUnfinishedUpload, args);
    } catch {
      await ctx.scheduler.runAfter(30_000, internal.setDeletion.cleanupUnfinishedUpload, args);
    }
    return null;
  },
});
export const getUnfinishedUpload = internalQuery({
  args: { uploadSessionId: v.id("uploadSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.uploadSessionId);
    return session?.status === "discarded" && !session.confirmedSetId ? session : null;
  },
});
export const removeUnfinishedUpload = internalMutation({
  args: { uploadSessionId: v.id("uploadSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.uploadSessionId);
    if (session?.status === "discarded" && !session.confirmedSetId) await ctx.db.delete(session._id);
  },
});

export const cleanupLateArtifacts = internalAction({
  args: { keys: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const keys = args.keys.filter(key => key.startsWith("set-ingest/") && !key.split("/").includes(".."));
    try { await deleteKnownBunnyArtifacts(ctx, keys); }
    catch { await ctx.scheduler.runAfter(30_000, internal.setDeletion.cleanupLateArtifacts, { keys }); }
    return null;
  },
});
