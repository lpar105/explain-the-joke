import { httpRouter } from "convex/server";

import {
  AppError,
  logServerError,
  toApiErrorResponseBody,
} from "../lib/errors";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

type MuxWebhookEvent = {
  data: {
    asset_id?: string;
    duration?: number;
    id: string;
    playback_ids?: Array<{
      id: string;
      policy: string;
    }>;
    status?: string;
    tracks?: Array<{
      type?: string;
    }>;
    upload_id?: string;
    warning?: {
      message?: string;
    };
  };
  type: string;
};

type ModalCallbackPayload = {
  artifacts?: Array<{
    contentType?: string;
    expiresAt?: number;
    fileName: string;
    isCanonical: boolean;
    key: string;
    kind:
      | "retainedMedia"
      | "playbackMedia"
      | "cleanedAudio"
      | "transcriptRaw"
      | "laughCandidatesRaw"
      | "linesNormalized"
      | "laughRegionsNormalized";
    size?: number;
  }> | null;
  attemptNumber: number;
  failureCode?:
    | "artifact_missing"
    | "artifact_invalid"
    | "external_worker_unavailable"
    | "external_worker_failed"
    | "modal_spawn_failed"
    | "mux_migration_failed"
    | "bunny_upload_failed"
    | "line_normalization_failed"
    | "laugh_detection_failed"
    | "laugh_normalization_failed"
    | "internal";
  failureDetail?: string;
  ingestJobId: string;
  modalFunctionCallId?: string;
  outcome: "succeeded" | "failed";
  stepName:
    | "prepareRetainedMedia"
    | "transcribeWords"
    | "preprocessLaughAudio"
    | "detectLaughCandidates";
};

export function normalizeModalCallbackPayload(
  payload: ModalCallbackPayload,
): ModalCallbackPayload & {
  artifacts?: NonNullable<ModalCallbackPayload["artifacts"]>;
} {
  const artifacts =
    payload.artifacts === null
      ? undefined
      : payload.artifacts?.map((artifact) => ({
          fileName: artifact.fileName,
          isCanonical: artifact.isCanonical,
          key: artifact.key,
          kind: artifact.kind,
          ...(artifact.contentType === undefined || artifact.contentType === null
            ? {}
            : { contentType: artifact.contentType }),
          ...(artifact.expiresAt === undefined || artifact.expiresAt === null
            ? {}
            : { expiresAt: artifact.expiresAt }),
          ...(artifact.size === undefined || artifact.size === null
            ? {}
            : { size: artifact.size }),
        }));

  return {
    attemptNumber: payload.attemptNumber,
    ingestJobId: payload.ingestJobId,
    outcome: payload.outcome,
    stepName: payload.stepName,
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(payload.failureCode === undefined || payload.failureCode === null
      ? {}
      : { failureCode: payload.failureCode }),
    ...(payload.failureDetail === undefined || payload.failureDetail === null
      ? {}
      : { failureDetail: payload.failureDetail }),
    ...(payload.modalFunctionCallId === undefined ||
    payload.modalFunctionCallId === null
      ? {}
      : { modalFunctionCallId: payload.modalFunctionCallId }),
  };
}

function getWebhookSecret() {
  const secret = process.env.MUX_WEBHOOK_SECRET;

  if (!secret) {
    throw new AppError("internal", {
      debugMessage: "Missing MUX_WEBHOOK_SECRET in the Convex environment.",
    });
  }

  return secret;
}

function getModalCallbackSecret() {
  const secret = process.env.SET_INGEST_CALLBACK_SECRET;

  if (!secret) {
    throw new AppError("internal", {
      debugMessage:
        "Missing SET_INGEST_CALLBACK_SECRET in the Convex environment.",
    });
  }

  return secret;
}

function parseMuxSignature(signatureHeader: string) {
  const pieces = signatureHeader.split(",");
  const timestamp = pieces
    .find((piece) => piece.startsWith("t="))
    ?.slice(2);
  const signature = pieces
    .find((piece) => piece.startsWith("v1="))
    ?.slice(3);

  if (!timestamp || !signature) {
    throw new AppError("auth", {
      debugMessage: "Mux-Signature header is malformed.",
    });
  }

  return { signature, timestamp };
}

async function verifyMuxWebhookSignature(rawBody: string, signatureHeader: string) {
  const { signature, timestamp } = parseMuxSignature(signatureHeader);
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));

  if (!Number.isFinite(Number(timestamp)) || ageSeconds > 300) {
    throw new AppError("auth", {
      debugMessage: "Mux webhook timestamp is outside the allowed tolerance.",
    });
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getWebhookSecret()),
    {
      hash: "SHA-256",
      name: "HMAC",
    },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  const expectedSignature = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  if (signature !== expectedSignature) {
    throw new AppError("auth", {
      debugMessage: "Mux webhook signature verification failed.",
    });
  }
}

function getPlaybackId(
  playbackIds: MuxWebhookEvent["data"]["playback_ids"],
) {
  return playbackIds?.find((playbackId) => playbackId.policy === "public")?.id ?? null;
}

function hasVideoTrack(tracks: MuxWebhookEvent["data"]["tracks"]) {
  return tracks?.some((track) => track.type === "video") ?? false;
}

http.route({
  path: "/mux/webhooks",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("mux-signature");

    if (!signatureHeader) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      await verifyMuxWebhookSignature(rawBody, signatureHeader);
    } catch (error) {
      logServerError("Mux webhook verification failed.", error, {
        route: "convex/http.ts#/mux/webhooks",
      });
      return new Response("Unauthorized", { status: 401 });
    }

    const event = JSON.parse(rawBody) as MuxWebhookEvent;

    switch (event.type) {
      case "video.upload.asset_created":
        if (!event.data.asset_id) {
          return new Response("Missing asset_id in upload webhook.", { status: 400 });
        }

        await ctx.runMutation(internal.sets.markUploadSessionProcessing, {
          muxAssetId: event.data.asset_id,
          muxUploadId: event.data.id,
        });
        break;
      case "video.asset.ready": {
        const playbackId = getPlaybackId(event.data.playback_ids);
        if (!playbackId || !event.data.duration || !hasVideoTrack(event.data.tracks)) {
          await ctx.runMutation(internal.sets.markUploadSessionFailed, {
            failureCode: "validation",
            muxAssetId: event.data.id,
            muxUploadId: event.data.upload_id,
          });
          return new Response("Ready asset must include video, playback_id, and duration.", {
            status: 400,
          });
        }

        await ctx.runMutation(internal.sets.markUploadSessionReadyForTrim, {
          durationSeconds: event.data.duration,
          muxAssetId: event.data.id,
          muxPlaybackId: playbackId,
          muxUploadId: event.data.upload_id,
        });
        break;
      }
      case "video.asset.errored":
        await ctx.runMutation(internal.sets.markUploadSessionFailed, {
          failureCode: "processing_unavailable",
          muxAssetId: event.data.id,
          muxUploadId: event.data.upload_id,
        });
        break;
      default:
        break;
    }

    return new Response("ok", { status: 200 });
  }),
});

http.route({
  path: "/modal/workflow-callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-set-ingest-callback-secret");

    if (!providedSecret || providedSecret !== getModalCallbackSecret()) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const payload = normalizeModalCallbackPayload(
        (await request.json()) as ModalCallbackPayload,
      );

      await ctx.runMutation(internal.setIngest.reportModalStepResult, {
        artifacts: payload.artifacts,
        attemptNumber: payload.attemptNumber,
        failureCode: payload.failureCode,
        failureDetail: payload.failureDetail,
        ingestJobId: payload.ingestJobId as never,
        modalFunctionCallId: payload.modalFunctionCallId,
        outcome: payload.outcome,
        stepName: payload.stepName,
      });

      return new Response("ok", { status: 200 });
    } catch (error) {
      logServerError("Modal ingest callback failed.", error, {
        route: "convex/http.ts#/modal/workflow-callback",
      });

      const response = toApiErrorResponseBody(error, "internal");
      return Response.json(response.body, { status: response.status });
    }
  }),
});

export default http;
