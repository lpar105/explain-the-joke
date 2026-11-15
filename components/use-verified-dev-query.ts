"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient, type Watch } from "convex/react";
import { useCallback, useEffect, useState } from "react";

import { api } from "../convex/_generated/api";

type WatchQuery<Result> = (client: ConvexReactClient) => Watch<Result>;

function useVerifiedDevQuery<Result>(watchQuery: WatchQuery<Result>, enabled: boolean) {
  const { getToken, sessionId } = useAuth();
  const [response, setResponse] = useState<{
    sessionId: string;
    watchQuery: WatchQuery<Result>;
    value: Result | null | undefined;
  }>();

  useEffect(() => {
    if (!enabled || !sessionId) return;

    const client = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const publish = (value: Result | null | undefined) => {
      if (!disposed) setResponse({ sessionId, watchQuery, value });
    };
    const watch = watchQuery(client);
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
  }, [enabled, getToken, sessionId, watchQuery]);

  if (enabled && response && response.sessionId === sessionId && response.watchQuery === watchQuery) {
    return response.value;
  }
}

export function useVerifiedSetArtifacts(setId: string, enabled: boolean) {
  const watch = useCallback(
    (client: ConvexReactClient) => client.watchQuery(api.sets.listDevArtifacts, { setId }),
    [setId],
  );
  return useVerifiedDevQuery(watch, enabled);
}

const watchDashboard = (client: ConvexReactClient) => client.watchQuery(api.sets.getDevPipelineDashboard, {});

export function useVerifiedPipelineDashboard(enabled: boolean) {
  return useVerifiedDevQuery(watchDashboard, enabled);
}
