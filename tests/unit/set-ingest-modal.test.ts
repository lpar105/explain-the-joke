import { afterEach, describe, expect, it, vi } from "vitest";

const { modalClientMock } = vi.hoisted(() => ({
  modalClientMock: vi.fn(),
}));

vi.mock("modal", () => ({
  ModalClient: modalClientMock,
}));

import {
  createModalClientFromEnv,
  resolveModalFunctionTarget,
} from "../../convex/setIngestModal";

const ORIGINAL_ENV = { ...process.env };

describe("createModalClientFromEnv", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    modalClientMock.mockReset();
  });

  it("throws a clear error when MODAL_TOKEN_ID is missing", () => {
    delete process.env.MODAL_TOKEN_ID;
    process.env.MODAL_TOKEN_SECRET = "secret";

    expect(() => createModalClientFromEnv()).toThrow(
      "Missing MODAL_TOKEN_ID in the Convex environment.",
    );
    expect(modalClientMock).not.toHaveBeenCalled();
  });

  it("throws a clear error when MODAL_TOKEN_SECRET is missing", () => {
    process.env.MODAL_TOKEN_ID = "token-id";
    delete process.env.MODAL_TOKEN_SECRET;

    expect(() => createModalClientFromEnv()).toThrow(
      "Missing MODAL_TOKEN_SECRET in the Convex environment.",
    );
    expect(modalClientMock).not.toHaveBeenCalled();
  });

  it("constructs the Modal client with explicit env credentials", () => {
    process.env.MODAL_TOKEN_ID = "token-id";
    process.env.MODAL_TOKEN_SECRET = "token-secret";

    createModalClientFromEnv();

    expect(modalClientMock).toHaveBeenCalledWith({
      tokenId: "token-id",
      tokenSecret: "token-secret",
    });
  });
});

describe("resolveModalFunctionTarget", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses the default app when given a bare function name", () => {
    delete process.env.MODAL_APP_NAME;
    process.env.MODAL_PREPARE_RETAINED_MEDIA_FUNCTION_NAME =
      "prepare_retained_media";

    expect(resolveModalFunctionTarget("prepareRetainedMedia")).toEqual({
      appName: "tight-five-ingest",
      functionName: "prepare_retained_media",
    });
  });

  it("uses MODAL_APP_NAME when given a bare function name", () => {
    process.env.MODAL_APP_NAME = "custom-app";
    process.env.MODAL_PREPARE_RETAINED_MEDIA_FUNCTION_NAME =
      "prepare_retained_media";

    expect(resolveModalFunctionTarget("prepareRetainedMedia")).toEqual({
      appName: "custom-app",
      functionName: "prepare_retained_media",
    });
  });

  it("accepts an explicit app/function override", () => {
    process.env.MODAL_PREPARE_RETAINED_MEDIA_FUNCTION_NAME =
      "custom-app/prepare_retained_media";

    expect(resolveModalFunctionTarget("prepareRetainedMedia")).toEqual({
      appName: "custom-app",
      functionName: "prepare_retained_media",
    });
  });
});
