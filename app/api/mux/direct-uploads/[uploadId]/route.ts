import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";

import { api } from "../../../../../convex/_generated/api";
import {
  logServerError,
  toApiErrorResponseBody,
} from "../../../../../lib/errors";
import {
  cancelMuxDirectUpload,
  deleteMuxAsset,
  getMuxAsset,
  getMuxDirectUpload,
  getMuxMediaKind,
  getMuxPlaybackId,
} from "../../../../../lib/mux";

async function requireOwnedUploadSession(uploadId: string) {
  const { getToken, userId } = await auth();

  if (!userId) {
    return {
      errorResponse: Response.json({ code: "auth" }, { status: 401 }),
      userId: null,
    };
  }

  const token = await getToken({ template: "convex" });
  if (!token) {
    return {
      errorResponse: Response.json({ code: "auth" }, { status: 401 }),
      userId,
    };
  }

  const uploadSession = await fetchQuery(
    api.sets.getUploadSessionByMuxUploadIdForViewer,
    { muxUploadId: uploadId },
    { token },
  );

  if (uploadSession === null) {
    return {
      errorResponse: Response.json({ code: "not_found" }, { status: 404 }),
      userId,
    };
  }

  return {
    errorResponse: null,
    userId,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ uploadId: string }> },
) {
  const { uploadId } = await context.params;
  const access = await requireOwnedUploadSession(uploadId);

  if (access.errorResponse) {
    return access.errorResponse;
  }

  try {
    const upload = await getMuxDirectUpload(uploadId);
    const assetId = upload.asset_id ?? null;

    if (!assetId) {
      return Response.json({
        assetId: null,
        assetStatus: null,
        durationSeconds: null,
        hlsUrl: null,
        mediaKind: null,
        playbackId: null,
        uploadStatus: upload.status,
      });
    }

    const asset = await getMuxAsset(assetId);
    const playbackId = getMuxPlaybackId(asset);
    const mediaKind = getMuxMediaKind(asset);

    return Response.json({
      assetId,
      assetStatus: asset.status,
      durationSeconds: asset.duration ?? null,
      hlsUrl: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : null,
      mediaKind,
      playbackId,
      uploadStatus: upload.status,
    });
  } catch (error) {
    const apiError = toApiErrorResponseBody(error, "internal");
    logServerError("Could not load direct upload status from Mux.", error, {
      route: "app/api/mux/direct-uploads/[uploadId]#GET",
      uploadId,
      userId: access.userId,
    });
    return Response.json(apiError.body, { status: apiError.status });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ uploadId: string }> },
) {
  const { uploadId } = await context.params;
  const access = await requireOwnedUploadSession(uploadId);

  if (access.errorResponse) {
    return access.errorResponse;
  }

  try {
    const upload = await getMuxDirectUpload(uploadId);

    if (upload.asset_id) {
      await deleteMuxAsset(upload.asset_id);
      return Response.json({ deletedAssetId: upload.asset_id, uploadId });
    }

    if (
      upload.status !== "cancelled" &&
      upload.status !== "errored" &&
      upload.status !== "timed_out"
    ) {
      await cancelMuxDirectUpload(uploadId);
    }

    return Response.json({ deletedAssetId: null, uploadId });
  } catch (error) {
    const apiError = toApiErrorResponseBody(error, "internal");
    logServerError("Could not clean up direct upload media from Mux.", error, {
      route: "app/api/mux/direct-uploads/[uploadId]#DELETE",
      uploadId,
      userId: access.userId,
    });
    return Response.json(apiError.body, { status: apiError.status });
  }
}
