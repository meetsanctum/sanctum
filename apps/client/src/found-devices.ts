import type { PairingInfo } from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { coreJson } from "./core-fetch";

// Adding devices as the core says it now, read whenever the shell refreshes
// its live feed and kept current by it in between: what drivers found and
// could add, and which drivers let devices join. Settings → Devices counts
// what waits to be added and lists it on each category's page, and Add
// devices lists it too.

export function useAdding(live: LiveFeed) {
  const [adding, setAdding] = useState<PairingInfo>();
  useEffect(() => {
    let isCurrent = true;
    let revision = 0;
    const read = () => {
      const requested = ++revision;
      void coreJson<PairingInfo>("/api/devices/pairing")
        .then((info) => {
          if (isCurrent && requested === revision) setAdding(info);
        })
        .catch(() => undefined);
    };
    read();
    const unsubscribe = live.subscribe({
      message(message) {
        if (message.type === "pairing") {
          revision += 1;
          setAdding(message.pairing);
        }
      },
      refresh: read,
    });
    return () => {
      isCurrent = false;
      unsubscribe();
    };
  }, [live]);
  return adding;
}
