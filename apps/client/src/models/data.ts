import type { ModelsInfo } from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { coreJson } from "../core-fetch";
import { everyWhileShown } from "../while-shown";

// The installed desktop client can connect to a core that only sends totals.
export type ModelsResponse = Omit<ModelsInfo, "usage"> & {
  usage?: ModelsInfo["usage"];
};

// What Settings reads of the home's AI models: asked again often while a
// check runs, so its answer shows as soon as it's there, and every half
// minute otherwise, so a source that stops answering says so.

const checkingEvery = 1_500;
const restingEvery = 30_000;
const requestTimeoutMs = 10_000;

export function useModels(live?: LiveFeed) {
  const [info, setInfo] = useState<ModelsResponse>();
  const request = useRef(0);
  const latestAnswer = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const next = await coreJson<ModelsResponse>("/api/models", {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (current < latestAnswer.current) return;
      latestAnswer.current = current;
      setInfo(next);
    } catch {
      // The next refresh can ask again.
    }
  }, []);
  // An answer to a change, which is newer than any listing under way.
  const answered = useCallback((next: ModelsResponse) => {
    latestAnswer.current = ++request.current;
    setInfo(next);
  }, []);
  const checking = info?.sources.some((source) => source.checking) ?? false;
  useEffect(() => {
    const update = () => void refresh();
    update();
    const stop = live?.subscribe({ refresh: update });
    const stopPolling = everyWhileShown(
      checking ? checkingEvery : restingEvery,
      update,
    );
    return () => {
      stop?.();
      stopPolling();
    };
  }, [live, refresh, checking]);
  useEffect(
    () => () => {
      latestAnswer.current = ++request.current;
    },
    [],
  );
  return { info, refresh, answered };
}
