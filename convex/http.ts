import { httpRouter } from "convex/server";

import {
  AppError,
  logServerError,
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

function getWebhookSecret() {
  const secret = process.env.MUX_WEBHOOK_SECRET;

  if (!secret) {
    throw new AppError("internal", {
      debugMessage: "Missing MUX_WEBHOOK_SECRET in the Convex environment.",
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

function getMediaKind(
  tracks: MuxWebhookEvent["data"]["tracks"],
): "audio" | "video" {
  return tracks?.some((track) => track.type === "video") ? "video" : "audio";
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
        if (!playbackId || !event.data.duration) {
          return new Response("Missing playback_id or duration in ready webhook.", {
            status: 400,
          });
        }

        await ctx.runMutation(internal.sets.markUploadSessionReadyForTrim, {
          durationSeconds: event.data.duration,
          mediaKind: getMediaKind(event.data.tracks),
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

export default http;
