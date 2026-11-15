"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";

import { api } from "../convex/_generated/api";

type ArtifactResult = FunctionReturnType<typeof api.sets.listDevArtifacts>;

export function useVerifiedSetArtifacts(setId: string, enabled: boolean) {
  const { getToken, sessionId } = useAuth();
  const [response, setResponse] = useState<{
    sessionId: string;
    setId: string;
    value: ArtifactResult | undefined;
  }>();

  useEffect(() => {
    if (!enabled || !sessionId) return;

    const client = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const publish = (value: ArtifactResult | undefined) => {
      if (!disposed) setResponse({ sessionId, setId, value });
    };
    const watch = client.watchQuery(api.sets.listDevArtifacts, { setId });
    client.setAuth(
      ({ forceRefreshToken }) => getToken({ template: "set-dev", skipCache: forceRefreshToken }).catch(() => null),
      (authenticated) => {
        if (disposed) return;
        unsubscribe?.();
        unsubscribe = undefined;
        if (!authenticated) {
          publish(null);
          return;
        }
        const update = () => {
          try {
            publish(watch.localQueryResult());
          } catch (error) {
            console.error("Could not load live DEV data.", error);
            publish(null);
          }
        };
        unsubscribe = watch.onUpdate(update);
        update();
      },
    );

    return () => {
      disposed = true;
      unsubscribe?.();
      void client.close();
    };
  }, [enabled, getToken, sessionId, setId]);

  if (enabled && response && response.sessionId === sessionId && response.setId === setId) {
    return response.value;
  }
}
