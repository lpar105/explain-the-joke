import "server-only";

import { AppError } from "./errors";

const MUX_API_BASE_URL = "https://api.mux.com/video/v1";

type MuxPlaybackId = {
  id: string;
  policy: string;
};

type MuxTrack = {
  type?: string;
};

type MuxUpload = {
  asset_id?: string;
  id: string;
  status: string;
  timeout?: number;
  url?: string;
};

type MuxAsset = {
  duration?: number;
  id: string;
  playback_ids?: MuxPlaybackId[];
  status: string;
  tracks?: MuxTrack[];
};

function getMuxCredentials() {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;

  if (!tokenId || !tokenSecret) {
    throw new AppError("internal", {
      debugMessage: "Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET.",
    });
  }

  return { tokenId, tokenSecret };
}

function getMuxAuthorizationHeader() {
  const { tokenId, tokenSecret } = getMuxCredentials();
  const encodedCredentials = Buffer.from(`${tokenId}:${tokenSecret}`).toString(
    "base64",
  );

  return `Basic ${encodedCredentials}`;
}

async function muxRequest<TResponse>(
  path: string,
  init?: RequestInit,
): Promise<TResponse> {
  const response = await fetch(`${MUX_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: getMuxAuthorizationHeader(),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new AppError(response.status === 404 ? "not_found" : "processing_unavailable", {
      debugMessage: `Mux request failed for ${path} (${response.status} ${response.statusText}).`,
      details: {
        errorBody,
        path,
        status: response.status,
        statusText: response.statusText,
      },
    });
  }

  if (response.status === 204) {
    return null as TResponse;
  }

  const payload = (await response.json()) as { data: TResponse };
  return payload.data;
}

export async function createMuxDirectUpload(args: {
  corsOrigin: string;
  mediaKind: "audio" | "video";
}) {
  return muxRequest<MuxUpload>("/uploads", {
    method: "POST",
    body: JSON.stringify({
      cors_origin: args.corsOrigin,
      new_asset_settings: {
        playback_policy: ["public"],
        passthrough: JSON.stringify({
          mediaKind: args.mediaKind,
        }),
      },
    }),
  });
}

export async function getMuxDirectUpload(uploadId: string) {
  return muxRequest<MuxUpload>(`/uploads/${uploadId}`, {
    method: "GET",
  });
}

export async function cancelMuxDirectUpload(uploadId: string) {
  await muxRequest<null>(`/uploads/${uploadId}`, {
    method: "DELETE",
  });
}

export async function getMuxAsset(assetId: string) {
  return muxRequest<MuxAsset>(`/assets/${assetId}`, {
    method: "GET",
  });
}

export async function deleteMuxAsset(assetId: string) {
  await muxRequest<null>(`/assets/${assetId}`, {
    method: "DELETE",
  });
}

export function getMuxPlaybackId(asset: MuxAsset) {
  return (
    asset.playback_ids?.find((playbackId) => playbackId.policy === "public")?.id ??
    null
  );
}

export function getMuxMediaKind(asset: MuxAsset): "audio" | "video" {
  const hasVideoTrack = asset.tracks?.some((track) => track.type === "video");
  return hasVideoTrack ? "video" : "audio";
}
