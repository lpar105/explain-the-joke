import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cancelMuxDirectUpload: vi.fn(),
  createMuxDirectUpload: vi.fn(),
  deleteMuxAsset: vi.fn(),
  fetchMutation: vi.fn(),
  fetchQuery: vi.fn(),
  getMuxAsset: vi.fn(),
  getMuxDirectUpload: vi.fn(),
  getMuxPlaybackId: vi.fn(),
  getToken: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

vi.mock("convex/nextjs", () => ({
  fetchMutation: mocks.fetchMutation,
  fetchQuery: mocks.fetchQuery,
}));

vi.mock("../../lib/mux", () => ({
  cancelMuxDirectUpload: mocks.cancelMuxDirectUpload,
  createMuxDirectUpload: mocks.createMuxDirectUpload,
  deleteMuxAsset: mocks.deleteMuxAsset,
  getMuxAsset: mocks.getMuxAsset,
  getMuxDirectUpload: mocks.getMuxDirectUpload,
  getMuxPlaybackId: mocks.getMuxPlaybackId,
}));

import { DELETE } from "../../app/api/mux/direct-uploads/[uploadId]/route";
import { POST } from "../../app/api/mux/direct-uploads/route";

const uploadId = "upload_123";
const uploadSessionId = "uploadSession_123";

function deleteRequest() {
  return DELETE(new Request(`http://localhost/api/mux/direct-uploads/${uploadId}`), {
    params: Promise.resolve({ uploadId }),
  });
}

function createRequest(contentType: string) {
  return POST(
    new Request("http://localhost/api/mux/direct-uploads", {
      body: JSON.stringify({ contentType }),
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
      },
      method: "POST",
    }),
  );
}

describe("Mux direct-upload cleanup route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getToken.mockResolvedValue("clerk-session-token");
    mocks.auth.mockResolvedValue({
      getToken: mocks.getToken,
      userId: "user_123",
    });
    mocks.fetchQuery.mockResolvedValue({
      _id: uploadSessionId,
      muxAssetId: null,
      muxUploadId: uploadId,
      ownerTokenIdentifier: "issuer|user_123",
      status: "waitingForUpload",
    });
    mocks.fetchMutation.mockResolvedValue(null);
    mocks.getMuxDirectUpload.mockResolvedValue({
      id: uploadId,
      status: "waiting",
    });
    mocks.cancelMuxDirectUpload.mockResolvedValue(undefined);
    mocks.createMuxDirectUpload.mockResolvedValue({
      id: uploadId,
      url: "https://storage.mux.com/direct-upload",
    });
  });

  it("rejects non-video files before creating a provider upload", async () => {
    const response = await createRequest("application/octet-stream");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "validation" });
    expect(mocks.createMuxDirectUpload).not.toHaveBeenCalled();
  });

  it("creates direct uploads for video files", async () => {
    const response = await createRequest("video/mp4");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      uploadId,
      uploadUrl: "https://storage.mux.com/direct-upload",
    });
    expect(mocks.createMuxDirectUpload).toHaveBeenCalledWith({
      corsOrigin: "http://localhost",
    });
  });

  it("uses Clerk's native session token and discards the Convex upload session", async () => {
    const response = await deleteRequest();

    expect(response.status).toBe(200);
    expect(mocks.getToken).toHaveBeenCalledOnce();
    expect(mocks.getToken).toHaveBeenCalledWith();
    expect(mocks.fetchMutation).toHaveBeenCalledWith(
      expect.anything(),
      { uploadSessionId },
      { token: "clerk-session-token" },
    );
    expect(mocks.cancelMuxDirectUpload).toHaveBeenCalledWith(uploadId);
  });

  it("returns a controlled internal error when Clerk token retrieval fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getToken.mockRejectedValue(new Error("Clerk unavailable"));

    try {
      const response = await deleteRequest();

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ code: "internal" });
      expect(mocks.getMuxDirectUpload).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("discards the Convex upload session before attempting provider cleanup", async () => {
    const callOrder: string[] = [];
    mocks.fetchMutation.mockImplementation(async () => {
      callOrder.push("discard-session");
    });
    mocks.getMuxDirectUpload.mockImplementation(async () => {
      callOrder.push("load-mux-upload");
      throw new Error("Mux unavailable");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await deleteRequest();

      expect(response.status).toBe(500);
      expect(callOrder).toEqual(["discard-session", "load-mux-upload"]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
