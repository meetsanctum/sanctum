import type { AppSettings } from "@meetsanctum/app-sdk";
import { useEffect, useState } from "react";

import { useAppClient } from "./app-ui";

/**
 * The app's own settings, read once and then followed live as the household
 * changes them; undefined until the core answers.
 */
export function useAppSettings(): AppSettings | undefined {
  const client = useAppClient();
  const [settings, setSettings] = useState<AppSettings>();

  useEffect(() => {
    let isCurrent = true;
    let revision = 0;
    let request = 0;
    const load = async () => {
      const currentRequest = ++request;
      const startedAt = revision;
      try {
        const answer = await client.settings();
        // A change pushed meanwhile is newer than this answer.
        if (isCurrent && currentRequest === request && startedAt === revision) {
          setSettings(answer);
        }
      } catch {
        // The shell refreshes once the connection is back.
      }
    };
    const stop = client.subscribe({
      refresh: () => void load(),
      message(message) {
        if (message.type !== "settings") return;
        revision += 1;
        setSettings(message.settings);
      },
    });
    void load();
    return () => {
      isCurrent = false;
      stop();
    };
  }, [client]);

  return settings;
}
