import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";
import { convexModules } from "./test.setup";

describe("sets", () => {
  it("creates and lists a set for the authenticated viewer", async () => {
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      name: "Taylor",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    const created = await asOwner.mutation(api.sets.create, {
      title: "Late Show Tape",
      trimRangeEndSeconds: 185,
      trimRangeStartSeconds: 5,
    });

    const sets = await asOwner.query(api.sets.listForViewer);

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      _id: created.setId,
      currentBreakdownId: created.breakdownId,
      setStatus: "playbackPending",
      title: "Late Show Tape",
      trimRangeEndSeconds: 185,
      trimRangeStartSeconds: 5,
      breakdown: {
        _id: created.breakdownId,
        editability: "locked",
        laughSeedingState: "pending",
        lineSeedingState: "pending",
      },
    });
  });

  it("hides sets from other viewers and trims renamed titles", async () => {
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });
    const asOtherViewer = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_999",
      tokenIdentifier: "clerk:user_999",
    });

    const created = await asOwner.mutation(api.sets.create, {
      title: "Working Title",
      trimRangeEndSeconds: 90,
      trimRangeStartSeconds: 15,
    });

    await asOwner.mutation(api.sets.rename, {
      setId: created.setId,
      title: "  Tight Five  ",
    });

    const visibleToOwner = await asOwner.query(api.sets.getForViewer, {
      setId: created.setId,
    });
    const visibleToOtherViewer = await asOtherViewer.query(api.sets.getForViewer, {
      setId: created.setId,
    });

    expect(visibleToOwner?.title).toBe("Tight Five");
    expect(visibleToOtherViewer).toBeNull();
    await expect(
      asOtherViewer.mutation(api.sets.rename, {
        setId: created.setId,
        title: "Should Fail",
      }),
    ).rejects.toThrow("Set not found.");
  });

  it("rejects trim ranges whose end is not after the start", async () => {
    const t = convexTest(schema, convexModules);
    const asOwner = t.withIdentity({
      issuer: "https://clerk.dev",
      subject: "user_123",
      tokenIdentifier: "clerk:user_123",
    });

    await expect(
      asOwner.mutation(api.sets.create, {
        title: "Late Show Tape",
        trimRangeEndSeconds: 180,
        trimRangeStartSeconds: 180,
      }),
    ).rejects.toThrow(/end trim must be greater than start trim/i);
  });
});
