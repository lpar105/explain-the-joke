import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSetDevAccess } from "../../app/sets/[setId]/dev/access";

const { auth, currentUser, getToken } = vi.hoisted(() => ({
  auth: vi.fn(), currentUser: vi.fn(), getToken: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth, currentUser }));

describe("DEV artifact access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.mockResolvedValue({ userId: "user_lauren", sessionClaims: { aud: "convex" }, getToken });
    currentUser.mockResolvedValue({ primaryEmailAddress: {
      emailAddress: "laurenparkernz@gmail.com", verification: { status: "verified" },
    } });
  });

  it("uses the dedicated token when the standard Convex session omits email claims", async () => {
    getToken.mockResolvedValue("scoped-token");
    await expect(getSetDevAccess()).resolves.toEqual({ token: "scoped-token" });
    expect(getToken).toHaveBeenCalledWith({ template: "set-dev" });
  });

  it("accepts a verified email claim in the standard Convex session", async () => {
    auth.mockResolvedValue({ userId: "user_lauren", sessionClaims: {
      aud: "convex", email: "laurenparkernz@gmail.com", email_verified: true,
    }, getToken });
    getToken.mockResolvedValue("native-token");
    await expect(getSetDevAccess()).resolves.toEqual({ token: "native-token" });
    expect(getToken).toHaveBeenCalledWith();
  });

  it("reports the missing template separately from denied access", async () => {
    getToken.mockRejectedValue({ status: 404 });
    await expect(getSetDevAccess()).resolves.toEqual({ token: null });

    currentUser.mockResolvedValue({ primaryEmailAddress: {
      emailAddress: "laurenparkernz@gmail.com", verification: { status: "unverified" },
    } });
    getToken.mockClear();
    await expect(getSetDevAccess()).resolves.toBeNull();
    expect(getToken).not.toHaveBeenCalled();
  });
});
