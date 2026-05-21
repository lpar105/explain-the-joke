import { auth } from "@clerk/nextjs/server";

import {
  logServerError,
  toApiErrorResponseBody,
} from "../../../../lib/errors";
import { createMuxDirectUpload } from "../../../../lib/mux";

type CreateDirectUploadRequestBody = {
  contentType?: string;
};

function getMediaKindFromContentType(
  contentType: string | undefined,
): "audio" | "video" | null {
  if (!contentType) {
    return null;
  }

  if (contentType.startsWith("audio/")) {
    return "audio";
  }

  if (contentType.startsWith("video/")) {
    return "video";
  }

  return null;
}

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ code: "auth" }, { status: 401 });
  }

  const body = (await request.json()) as CreateDirectUploadRequestBody;
  const mediaKind = getMediaKindFromContentType(body.contentType);

  if (mediaKind === null) {
    return Response.json(
      { code: "validation" },
      { status: 400 },
    );
  }

  try {
    const upload = await createMuxDirectUpload({
      corsOrigin: request.headers.get("origin") ?? new URL(request.url).origin,
      mediaKind,
    });

    return Response.json({
      mediaKind,
      uploadId: upload.id,
      uploadUrl: upload.url ?? null,
    });
  } catch (error) {
    const apiError = toApiErrorResponseBody(error, "internal");
    logServerError("Could not create a Mux direct upload.", error, {
      mediaKind,
      route: "app/api/mux/direct-uploads#POST",
      userId,
    });
    return Response.json(apiError.body, { status: apiError.status });
  }
}
