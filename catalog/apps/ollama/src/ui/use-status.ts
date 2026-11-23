import { useAppClient } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OllamaStatus } from "../index";

// What Ollama's page shows, read from the app: every second while a model
// downloads, so its bar moves, and every 15 seconds otherwise, as memory and
// storage change. Each change it asks for reads again at once.

const downloadingEveryMs = 1_000;
const restingEveryMs = 15_000;

export function useStatus() {
  const client = useAppClient();
  const [status, setStatus] = useState<OllamaStatus>();
  const [hasFailed, setHasFailed] = useState(false);
  const request = useRef({ isPending: false });

  const load = useCallback(async () => {
    const current = { isPending: true };
    request.current = current;
    try {
      const next = await client.call("ollama.status", {});
      if (current !== request.current) return;
      setStatus(next as OllamaStatus);
      setHasFailed(false);
    } catch {
      if (current === request.current) setHasFailed(true);
    } finally {
      current.isPending = false;
    }
  }, [client]);

  const isDownloading = (status?.downloads ?? []).some(
    (download) => !download.problem,
  );
  useEffect(() => {
    void load();
    return () => {
      request.current = { isPending: false };
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(
      () => {
        if (!request.current.isPending) void load();
      },
      isDownloading ? downloadingEveryMs : restingEveryMs,
    );
    return () => clearInterval(timer);
  }, [load, isDownloading]);

  /** Asks the app for a change, then reads again; false when it was refused. */
  const act = useCallback(
    async (action: string, input: Record<string, unknown>) => {
      try {
        await client.call(action, input);
        return true;
      } catch {
        return false;
      } finally {
        await load();
      }
    },
    [client, load],
  );

  return { status, hasFailed, act };
}
