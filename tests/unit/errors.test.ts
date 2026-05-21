import { describe, expect, it, vi } from "vitest";

import { AppError, logServerError } from "../../lib/errors";

describe("server error logging", () => {
  it("logs route context and provider diagnostics for AppError failures", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const error = new AppError("processing_unavailable", {
        debugMessage: "Mux request failed for /uploads (503 Service Unavailable).",
        details: {
          errorBody: "{\"error\":\"provider down\"}",
          path: "/uploads",
          status: 503,
          statusText: "Service Unavailable",
        },
      });

      logServerError("Could not create a Mux direct upload.", error, {
        mediaKind: "video",
        route: "app/api/mux/direct-uploads#POST",
        userId: "user_123",
      });

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Could not create a Mux direct upload.",
        expect.objectContaining({
          code: "processing_unavailable",
          context: {
            mediaKind: "video",
            route: "app/api/mux/direct-uploads#POST",
            userId: "user_123",
          },
          debugMessage:
            "Mux request failed for /uploads (503 Service Unavailable).",
          details: {
            errorBody: "{\"error\":\"provider down\"}",
            path: "/uploads",
            status: 503,
            statusText: "Service Unavailable",
          },
          error: expect.any(Error),
        }),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("emits explicit error fields instead of only a nested Error object", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const error = new Error("mux temporarily unavailable");
      error.name = "MuxUploadError";

      logServerError("Could not create a Mux direct upload.", error, {
        route: "app/api/mux/direct-uploads#POST",
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Could not create a Mux direct upload.",
        expect.objectContaining({
          code: "internal",
          context: {
            route: "app/api/mux/direct-uploads#POST",
          },
          debugMessage: "mux temporarily unavailable",
          details: undefined,
          error: expect.objectContaining({
            message: "mux temporarily unavailable",
            name: "MuxUploadError",
          }),
        }),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
