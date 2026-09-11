import { describe, expect, it } from "vitest";

import { normalizeModalCallbackPayload } from "../../convex/http";

describe("normalizeModalCallbackPayload", () => {
  it("drops null artifacts so the callback payload matches Convex validators", () => {
    expect(
      normalizeModalCallbackPayload({
        artifacts: null,
        attemptNumber: 1,
        ingestJobId: "ingestJobId" as never,
        outcome: "failed",
        stepName: "prepareRetainedMedia",
      }),
    ).toEqual({
      artifacts: undefined,
      attemptNumber: 1,
      ingestJobId: "ingestJobId",
      outcome: "failed",
      stepName: "prepareRetainedMedia",
    });
  });

  it("preserves artifact arrays unchanged", () => {
    expect(
      normalizeModalCallbackPayload({
        artifacts: [
          {
            fileName: "retained.mp4",
            isCanonical: true,
            key: "sets/example/retained.mp4",
            kind: "retainedMedia",
          },
        ],
        attemptNumber: 1,
        ingestJobId: "ingestJobId" as never,
        outcome: "succeeded",
        stepName: "prepareRetainedMedia",
      }),
    ).toEqual({
      artifacts: [
        {
          fileName: "retained.mp4",
          isCanonical: true,
          key: "sets/example/retained.mp4",
          kind: "retainedMedia",
        },
      ],
      attemptNumber: 1,
      ingestJobId: "ingestJobId",
      outcome: "succeeded",
      stepName: "prepareRetainedMedia",
    });
  });

  it("drops null optional fields throughout the callback payload", () => {
    expect(
      normalizeModalCallbackPayload({
        artifacts: [
          {
            contentType: null as never,
            expiresAt: null as never,
            fileName: "retained.mp4",
            isCanonical: true,
            key: "sets/example/retained.mp4",
            kind: "retainedMedia",
            size: null as never,
          },
        ],
        attemptNumber: 1,
        failureCode: null as never,
        failureDetail: null as never,
        ingestJobId: "ingestJobId" as never,
        modalFunctionCallId: null as never,
        outcome: "succeeded",
        stepName: "prepareRetainedMedia",
      }),
    ).toEqual({
      artifacts: [
        {
          fileName: "retained.mp4",
          isCanonical: true,
          key: "sets/example/retained.mp4",
          kind: "retainedMedia",
        },
      ],
      attemptNumber: 1,
      ingestJobId: "ingestJobId",
      outcome: "succeeded",
      stepName: "prepareRetainedMedia",
    });
  });
});
