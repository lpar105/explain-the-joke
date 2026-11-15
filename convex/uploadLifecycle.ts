import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import { toConvexError } from '../lib/errors';

export const CONTACT_TIMEOUT_MS = 300_000;

export async function abandonUpload(ctx: MutationCtx, session: Doc<'uploadSessions'>) {
  if (session.status === 'confirmed' || session.status === 'discarded') return;
  await ctx.db.patch(session._id, { status: 'discarded' });
  if (session.confirmedSetId) {
    const existing = await ctx.db.query('setDeletionJobs')
      .withIndex('by_setId', q => q.eq('setId', session.confirmedSetId!)).unique();
    const deletionJobId = existing?._id ?? await ctx.db.insert('setDeletionJobs', {
      setId: session.confirmedSetId, status: 'cancelingWork', retryCount: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    if (await ctx.db.get(session.confirmedSetId)) await ctx.db.delete(session.confirmedSetId);
    await ctx.scheduler.runAfter(0, internal.setDeletion.runCleanup, { deletionJobId });
  } else {
    await ctx.scheduler.runAfter(0, internal.setDeletion.cleanupUnfinishedUpload, {
      uploadSessionId: session._id,
    });
  }
}

export const contact = mutation({
  args: { uploadSessionId: v.id('uploadSessions') },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const session = await ctx.db.get(args.uploadSessionId);
    if (!identity || session?.ownerTokenIdentifier !== identity.tokenIdentifier) throw toConvexError('not_found');
    if (session.status === 'discarded') return false;
    if (session.status === 'confirmed') return true;
    if (Date.now() - (session.lastContactAt ?? session._creationTime) >= CONTACT_TIMEOUT_MS) {
      await abandonUpload(ctx, session);
      return false;
    }
    await ctx.db.patch(session._id, { lastContactAt: Date.now() });
    return true;
  },
});

export const expire = internalMutation({
  args: { uploadSessionId: v.id('uploadSessions') },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.uploadSessionId);
    if (!session || session.status === 'confirmed' || session.status === 'discarded') return;
    const remaining = CONTACT_TIMEOUT_MS - (Date.now() - (session.lastContactAt ?? session._creationTime));
    if (remaining <= 0) await abandonUpload(ctx, session);
    else await ctx.scheduler.runAfter(remaining, internal.uploadLifecycle.expire, args);
  },
});
