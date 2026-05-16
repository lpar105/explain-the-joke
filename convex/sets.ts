import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

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

        return {
          _id: set._id,
          _creationTime: set._creationTime,
          currentBreakdownId: set.currentBreakdownId ?? null,
          setStatus: set.setStatus,
          title: set.title,
          trimRangeEndSeconds: set.trimRangeEndSeconds,
          trimRangeStartSeconds: set.trimRangeStartSeconds,
          breakdown: breakdown
            ? {
              _id: breakdown._id,
              editability: breakdown.editability,
              laughSeedingState: breakdown.laughSeedingState,
              lineSeedingState: breakdown.lineSeedingState,
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

    return {
      _id: set._id,
      _creationTime: set._creationTime,
      currentBreakdownId: set.currentBreakdownId ?? null,
      setStatus: set.setStatus,
      title: set.title,
      trimRangeEndSeconds: set.trimRangeEndSeconds,
      trimRangeStartSeconds: set.trimRangeStartSeconds,
      breakdown: breakdown
        ? {
          _id: breakdown._id,
          editability: breakdown.editability,
          laughFailureReason: breakdown.laughFailureReason ?? null,
          laughSeedingState: breakdown.laughSeedingState,
          lineFailureReason: breakdown.lineFailureReason ?? null,
          lineSeedingState: breakdown.lineSeedingState,
        }
        : null,
    };
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
      throw new Error("You must be signed in to rename a set.");
    }

    const set = await ctx.db.get(args.setId);
    if (set === null || set.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Set not found.");
    }

    const nextTitle = args.title.trim();
    if (!nextTitle) {
      throw new Error("Give the Set a title before saving.");
    }

    await ctx.db.patch("sets", args.setId, {
      title: nextTitle,
    });

    return null;
  },
});
