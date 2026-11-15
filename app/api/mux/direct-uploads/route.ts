import { auth } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";

import { api } from "../../../../convex/_generated/api";
import {
  logServerError,
  toApiErrorResponseBody,
} from "../../../../lib/errors";

function isCreateDirectUploadBody(
  body: unknown,
): body is { contentType: string; originalFileName?: string } {
  return typeof body === "object" && body !== null &&
    "contentType" in body && typeof body.contentType === "string" &&
    body.contentType.startsWith("video/") &&
    (!("originalFileName" in body) || typeof body.originalFileName === "string");
}

export async function POST(request: Request) {
  const { getToken, userId } = await auth();

  if (!userId) {
    return Response.json({ code: "auth" }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isCreateDirectUploadBody(body)) {
    return Response.json(
      { code: "validation" },
      { status: 400 },
    );
  }

  try {
    const token = await getToken();
    if (!token) return Response.json({ code: "auth" }, { status: 401 });

    const upload = await fetchAction(api.sets.createDirectUpload, {
      corsOrigin: request.headers.get("origin") ?? new URL(request.url).origin,
      originalFileName: body.originalFileName ?? "",
    }, { token });

    return Response.json(upload);
  } catch (error) {
    const apiError = toApiErrorResponseBody(error, "internal");
    logServerError("Could not create a Mux direct upload.", error, {
      route: "app/api/mux/direct-uploads#POST",
      userId,
    });
    return Response.json(apiError.body, { status: apiError.status });
  }
}
