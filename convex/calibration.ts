import { sendEvent, type WorkflowId } from '@convex-dev/workflow';
import { v } from 'convex/values';
import { CALIBRATION_PROCESSING, manualRegions, validateManualSample, type ManualInterval, type ScoreTrack } from '../lib/calibration';
import { toConvexError } from '../lib/errors';
import { api, components, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { getBunnyArtifactCdnUrl } from './bunny';
import { CONTACT_TIMEOUT_MS } from './uploadLifecycle';

const intervalValidator = v.object({ start: v.number(), end: v.number() });
type Snapshot = {
  retainedMedia: { key: string; artifactId: string };
  duration: number;
  sample: { start: number; end: number };
  intervals: ManualInterval[];
  labelRevision: number;
  labelHash: string;
  processing: typeof CALIBRATION_PROCESSING;
};
async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export const contextForViewer = query({
  args: { uploadSessionId: v.id('uploadSessions') },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const session = await ctx.db.get(args.uploadSessionId);
    if (!identity || session?.ownerTokenIdentifier !== identity.tokenIdentifier || !session.confirmedSetId || session.status === 'discarded') throw toConvexError('not_found');
    const set = await ctx.db.get(session.confirmedSetId);
    const job = await ctx.db.query('ingestJobs').withIndex('by_setId', q => q.eq('setId', session.confirmedSetId!)).unique();
    if (!set || !job?.calibrationRequired) throw toConvexError('not_found');
    const media = await ctx.db.query('ingestArtifacts').withIndex('by_ingestJobId_and_kind', q => q.eq('ingestJobId', job._id).eq('kind', 'retainedMedia')).take(20);
    return { session, set, job, media: media.find(a => a.isCanonical) ?? null };
  },
});

export const confirm = action({
  args: { uploadSessionId: v.id('uploadSessions'), intervals: v.array(intervalValidator) },
  returns: v.object({ setId: v.id('sets') }),
  handler: async (ctx, args): Promise<{ setId: Id<"sets"> }> => {
    const context = await ctx.runQuery(api.calibration.contextForViewer, { uploadSessionId: args.uploadSessionId });
    if (context.session.status === 'confirmed') return { setId: context.set._id };
    const duration = context.set.trimRangeEndSeconds - context.set.trimRangeStartSeconds;
    validateManualSample(duration, args.intervals);
    if (!context.media) throw new Error('Upload not saved. Media is still preparing; retry shortly.');
    const snapshot: Snapshot = {
      retainedMedia: { key: context.media.path, artifactId: context.media._id },
      duration, sample: { start: 0, end: duration }, intervals: args.intervals,
      labelRevision: 1, labelHash: await hash(JSON.stringify(args.intervals)),
      processing: CALIBRATION_PROCESSING,
    };
    const json = JSON.stringify(snapshot);
    const inputId = await ctx.storage.store(new Blob([json], { type: 'application/json' }));
    try {
      const result = await ctx.runMutation(internal.calibration.commit, {
        uploadSessionId: args.uploadSessionId, inputId, inputHash: await hash(json),
        mediaId: context.media._id, intervals: args.intervals,
      });
      if (!result.usedInput) await ctx.storage.delete(inputId);
      return { setId: result.setId };
    } catch (error) {
      await ctx.storage.delete(inputId);
      throw error;
    }
  },
});

export const commit = internalMutation({
  args: {
    uploadSessionId: v.id('uploadSessions'), inputId: v.id('_storage'), inputHash: v.string(),
    mediaId: v.id('ingestArtifacts'), intervals: v.array(intervalValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const session = await ctx.db.get(args.uploadSessionId);
    if (!identity || session?.ownerTokenIdentifier !== identity.tokenIdentifier || !session.confirmedSetId) throw toConvexError('not_found');
    const set = await ctx.db.get(session.confirmedSetId);
    if (!set) throw toConvexError('not_found');
    if (session.status === 'confirmed') return { setId: set._id, usedInput: false };
    if (session.status !== 'calibrating' || Date.now() - (session.lastContactAt ?? session._creationTime) >= CONTACT_TIMEOUT_MS) throw toConvexError('not_found');
    validateManualSample(set.trimRangeEndSeconds - set.trimRangeStartSeconds, args.intervals);
    const job = await ctx.db.query('ingestJobs').withIndex('by_setId', q => q.eq('setId', set._id)).unique();
    const media = await ctx.db.get(args.mediaId);
    if (!job?.calibrationRequired || job.calibrationInputId || !media?.isCanonical || media.ingestJobId !== job._id || media.kind !== 'retainedMedia') throw toConvexError('validation');
    await ctx.db.patch(job._id, { calibrationInputId: args.inputId, calibrationInputHash: args.inputHash });
    await ctx.db.patch(set._id, { provisional: false });
    await ctx.db.patch(session._id, { status: 'confirmed' });
    if (job.workflowId) await sendEvent(ctx, components.workflow, {
      workflowId: job.workflowId as WorkflowId, name: 'calibration-confirmed', validator: v.null(), value: null,
    });
    return { setId: set._id, usedInput: true };
  },
});

export const getInput = internalQuery({
  args: { ingestJobId: v.id('ingestJobs') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestJobId);
    const set = job ? await ctx.db.get(job.setId) : null;
    if (!job || !set) return null;
    return { inputId: job.calibrationInputId, inputHash: job.calibrationInputHash, job, set };
  },
});

export const publishManual = internalAction({
  args: { ingestJobId: v.id('ingestJobs') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const context = await ctx.runQuery(internal.calibration.getInput, args);
    if (!context?.inputId || !context.inputHash || context.set.provisional) throw new Error('Calibration input unavailable.');
    if (context.job.calibrationStatus === 'succeeded') return null;
    await ctx.runMutation(internal.calibration.markRunning, args);
    const input = await ctx.storage.get(context.inputId);
    if (!input) throw new Error('Missing immutable calibration input.');
    const json = await input.text();
    if (await hash(json) !== context.inputHash) throw new Error('Calibration input hash mismatch.');
    const snapshot = JSON.parse(json) as Snapshot;
    if (JSON.stringify(snapshot.processing) !== JSON.stringify(CALIBRATION_PROCESSING)) throw new Error('Calibration processing version mismatch.');
    const artifact = await ctx.runQuery(internal.setIngest.getCanonicalArtifact, { ...args, kind: 'scoreTrack' });
    const retained = await ctx.runQuery(internal.setIngest.getCanonicalArtifact, { ...args, kind: 'retainedMedia' });
    if (!artifact || retained?.key !== snapshot.retainedMedia.key) throw new Error('Calibration media mismatch.');
    const response = await fetch(getBunnyArtifactCdnUrl(artifact.key));
    if (!response.ok) throw new Error('Calibration score track unavailable.');
    const track = await response.json() as ScoreTrack;
    if (track.retainedMediaKey !== snapshot.retainedMedia.key || !/^[a-f0-9]{64}$/.test(track.retainedMediaSha256)) throw new Error('Score track media mismatch.');
    const lines = await ctx.runQuery(internal.sets.getBreakdownLinesInternal, { breakdownId: context.job.breakdownId });
    const regions = manualRegions({ duration: snapshot.duration, intervals: snapshot.intervals, track, lines });
    const resultId = await ctx.storage.store(new Blob([JSON.stringify({
      inputHash: context.inputHash, input: snapshot, retainedMediaSha256: track.retainedMediaSha256,
      status: 'succeeded', mode: 'manual-only', reason: 'no-remainder',
      intensityReference: track.intensityReference, candidateCount: 0,
      diagnostics: { all_zero: track.scores.every(s => s === 0), constant_scores: track.scores.every(s => s === track.scores[0]) },
      regions,
    })], { type: 'application/json' }));
    try {
      const accepted = await ctx.runMutation(internal.calibration.finish, { ...args, inputHash: context.inputHash, resultId, regions });
      if (!accepted) await ctx.storage.delete(resultId);
    } catch (error) { await ctx.storage.delete(resultId); throw error; }
    return null;
  },
});

export const finish = internalMutation({
  args: {
    ingestJobId: v.id('ingestJobs'), inputHash: v.string(), resultId: v.id('_storage'),
    regions: v.array(v.object({ ordinal: v.number(), lineOrdinal: v.number(), startSeconds: v.number(), endSeconds: v.number(), intensityScore: v.number() })),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestJobId);
    const set = job ? await ctx.db.get(job.setId) : null;
    if (!job || !set || set.provisional || job.calibrationInputHash !== args.inputHash || job.calibrationStatus === 'succeeded') return false;
    const breakdown = await ctx.db.get(job.breakdownId);
    if (!breakdown || breakdown.lineSeedingState !== 'ready' || breakdown.editability === 'editable') return false;
    await ctx.runMutation(internal.setIngest.replaceNormalizedLaughRegions, { breakdownId: job.breakdownId, laughRegions: args.regions });
    await ctx.db.patch(job._id, { calibrationStatus: 'succeeded', calibrationResultId: args.resultId, calibrationErrorCode: undefined, calibrationRetryable: undefined });
    await ctx.runMutation(internal.setIngest.setBreakdownPathState, { breakdownId: job.breakdownId, path: 'laugh', state: 'ready' });
    return true;
  },
});

export const recordFailure = internalMutation({
  args: { ingestJobId: v.id('ingestJobs') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestJobId);
    if (job && await ctx.db.get(job.setId) && job.calibrationStatus !== 'succeeded') await ctx.db.patch(job._id, {
      calibrationStatus: 'failed', calibrationErrorCode: 'calibration_processing_failed', calibrationRetryable: true,
    });
  },
});

export const retainedDuration = internalQuery({
  args: { ingestJobId: v.id("ingestJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestJobId);
    const set = job ? await ctx.db.get(job.setId) : null;
    return set ? set.trimRangeEndSeconds - set.trimRangeStartSeconds : undefined;
  },
});

export const markRunning = internalMutation({
  args: { ingestJobId: v.id("ingestJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestJobId);
    if (job && await ctx.db.get(job.setId) && job.calibrationStatus !== "succeeded") await ctx.db.patch(job._id, { calibrationStatus: "running" });
  },
});

export const retry = mutation({
  args: { setId: v.id("sets") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    const set = await ctx.db.get(args.setId);
    if (!identity || !set || set.provisional || set.ownerTokenIdentifier !== identity.tokenIdentifier) throw toConvexError("not_found");
    const job = await ctx.db.query("ingestJobs").withIndex("by_setId", q => q.eq("setId", set._id)).unique();
    if (!job?.calibrationRequired || !job.calibrationInputId || job.status !== "failed") throw toConvexError("validation");
    const breakdown = await ctx.db.get(job.breakdownId);
    const existingLaugh = await ctx.db.query("laughRegions").withIndex("by_breakdownId_and_ordinal", q => q.eq("breakdownId", job.breakdownId)).first();
    if (!breakdown || breakdown.laughSeededAt || existingLaugh) throw toConvexError("validation");
    await ctx.db.patch(breakdown._id, { editability: "locked", laughSeedingState: "pending", laughFailureCode: undefined, laughFailureDetail: undefined });
    await ctx.db.patch(job._id, { status: "pending", calibrationStatus: "pending", calibrationErrorCode: undefined, calibrationRetryable: undefined });
    await ctx.runMutation(internal.setIngest.startSetIngest, { ingestJobId: job._id });
    return null;
  },
});
