import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { createConvexTest } from "./test.setup";

async function fixture(laughSeedingState: "ready" | "failed" = "ready") {
  const t = createConvexTest();
  const ownerTokenIdentifier = "clerk:owner";
  const owner = t.withIdentity({ subject: "owner", tokenIdentifier: ownerTokenIdentifier });
  const guest = t.withIdentity({ subject: "guest", tokenIdentifier: "clerk:guest" });
  const ids = await t.run(async ctx => {
    const setId = await ctx.db.insert("sets", {
      ownerTokenIdentifier, title: "Thursday Set", trimRangeStartSeconds: 10, trimRangeEndSeconds: 40, setStatus: "playable",
    });
    const breakdownId = await ctx.db.insert("breakdowns", {
      setId, editability: "editable", lineSeedingState: "ready", laughSeedingState,
    });
    await ctx.db.patch(setId, { currentBreakdownId: breakdownId });
    const firstLine = await ctx.db.insert("lines", {
      breakdownId, ordinal: 1, startSeconds: 0, endSeconds: 10,
      text: "I made thyme.", wordCount: 3, laughCount: 1, laughIntensityScore: 0.8,
    });
    const secondLine = await ctx.db.insert("lines", {
      breakdownId, ordinal: 2, startSeconds: 10, endSeconds: 30,
      text: "Then I missed the alarm.", wordCount: 5, laughCount: 0, laughIntensityScore: 0,
    });
    const laugh = await ctx.db.insert("laughRegions", {
      breakdownId, lineId: firstLine, ordinal: 1, startSeconds: 4, endSeconds: 6, intensityScore: 0.8,
    });
    return { setId, breakdownId, firstLine, secondLine, laugh };
  });
  return { t, owner, guest, ...ids, base: { setId: ids.setId, breakdownId: ids.breakdownId, editRevision: 0 } };
}

describe("Set review editor", () => {
  it("saves corrected text, moves the existing laugh to its new owner, and adds a laugh", async () => {
    const { owner, t, base, laugh, secondLine, firstLine } = await fixture("failed");
    expect(await owner.mutation(api.sets.saveBreakdownEdits, {
      ...base, textEdits: [{ index: 1, text: " I finally made time. " }],
      laughs: [{ index: null, start: 2, end: 3 }, { index: 1, start: 11, end: 14 }],
    })).toBe("saved");
    expect(await t.run(ctx => ctx.db.get(laugh))).toMatchObject({ lineId: secondLine, intensityScore: 0.8 });
    expect(await t.run(ctx => ctx.db.get(firstLine))).toMatchObject({ wordCount: 4, laughCount: 1, laughIntensityScore: 0.5 });
    expect(await owner.query(api.sets.getSetPageForViewer, { setId: base.setId })).toMatchObject({
      breakdown: { _id: base.breakdownId, editRevision: 1, laughsEdited: true, laughSeedingState: "failed" },
      analysisData: {
        transcriptText: "I finally made time. Then I missed the alarm.",
        sentences: [
          { laughs: [{ start_time: 2, end_time: 3, intensity_score: 0.5 }] },
          { laughs: [{ start_time: 11, end_time: 14, intensity_score: 0.8 }] },
        ],
      },
    });
  });

  it("combines laughs on one Line, then removes the region and clears its metrics", async () => {
    const { owner, t, base, laugh, firstLine } = await fixture();
    await owner.mutation(api.sets.saveBreakdownEdits, {
      ...base, textEdits: [], laughs: [{ index: 1, start: 4, end: 6 }, { index: null, start: 7, end: 8 }],
    });
    expect(await t.run(ctx => ctx.db.get(laugh))).toMatchObject({ startSeconds: 4, endSeconds: 8, intensityScore: 0.8 });
    await owner.mutation(api.sets.saveBreakdownEdits, { ...base, editRevision: 1, textEdits: [], laughs: [] });
    expect(await t.run(ctx => ctx.db.get(laugh))).toBeNull();
    expect(await t.run(ctx => ctx.db.get(firstLine))).toMatchObject({ laughCount: 0, laughIntensityScore: 0 });
  });

  it("blocks guest edits and stale drafts, and text-only saves preserve laughs", async () => {
    const { owner, guest, t, base, laugh, firstLine } = await fixture();
    const textEdits = [{ index: 1, text: "I made time." }];
    await expect(guest.mutation(api.sets.saveBreakdownEdits, { ...base, textEdits })).rejects.toMatchObject({
      data: { code: "not_found" },
    });
    await owner.mutation(api.sets.saveBreakdownEdits, { ...base, textEdits });
    expect(await owner.mutation(api.sets.saveBreakdownEdits, { ...base, textEdits: [], laughs: [] })).toBe("stale");
    expect(await t.run(ctx => ctx.db.get(laugh))).toMatchObject({ startSeconds: 4, endSeconds: 6 });
    expect(await t.run(ctx => ctx.db.get(firstLine))).toMatchObject({ text: "I made time." });
  });

  it("rejects edits while locked and does not partially save invalid timings", async () => {
    const { owner, t, base, firstLine, laugh } = await fixture();
    await t.run(ctx => ctx.db.patch(base.breakdownId, { editability: "locked" }));
    const edits = { ...base, textEdits: [{ index: 1, text: "I made time." }] };
    await expect(owner.mutation(api.sets.saveBreakdownEdits, edits)).rejects.toMatchObject({
      data: { code: "processing_unavailable" },
    });
    await t.run(ctx => ctx.db.patch(base.breakdownId, { editability: "editable" }));
    await expect(owner.mutation(api.sets.saveBreakdownEdits, {
      ...edits, laughs: [{ index: 1, start: 4, end: 6 }, { index: null, start: 5, end: 7 }],
    })).rejects.toMatchObject({ data: { code: "validation" } });
    expect(await t.run(ctx => ctx.db.get(firstLine))).toMatchObject({ text: "I made thyme." });
    expect(await t.run(ctx => ctx.db.get(laugh))).toMatchObject({ startSeconds: 4, endSeconds: 6 });
  });
});
