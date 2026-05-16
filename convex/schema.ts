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
});
