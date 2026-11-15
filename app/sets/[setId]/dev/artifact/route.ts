import { fetchQuery } from "convex/nextjs";

import { api } from "../../../../../convex/_generated/api";
import { getSetDevAccess } from "../access";

export async function GET(request: Request, { params }: { params: Promise<{ setId: string }> }) {
  const access = await getSetDevAccess();
  if (!access?.token) return new Response(null, { status: 404 });

  const { setId } = await params;
  const id = new URL(request.url).searchParams.get("id");
  const artifacts = await fetchQuery(api.sets.listDevArtifacts, { setId }, { token: access.token });
  const artifact = artifacts?.find((item) => item.id === id);
  if (!artifact?.url || (artifact.contentType !== "application/json" && !artifact.fileName.endsWith(".json"))) {
    return new Response(null, { status: 404 });
  }

  const response = await fetch(artifact.url, { cache: "no-store", signal: request.signal });
  if (!response.ok) return new Response(null, { status: response.status === 404 ? 404 : 502 });

  return new Response(response.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
