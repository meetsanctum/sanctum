import type { PairingInfo } from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { coreJson } from "./core-fetch";

// Adding devices as the core says it now, read whenever the shell refreshes
// its live feed and kept current by it in between: what drivers found and
// could add, and which drivers let devices join. Settings → Devices says
// when something waits to be added, and Add devices lists it.

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

/**
 * What Settings → Devices' heading says while found devices wait to be
 * added, those an app the home could add found too.
 */
export function foundHint(
  adding: Partial<Pick<PairingInfo, "found" | "offers">> | undefined,
) {
  const count =
    (adding?.found?.length ?? 0) +
    (adding?.offers?.reduce((sum, { found }) => sum + found, 0) ?? 0);
  return count > 0 ? `${count} found on your network` : undefined;
}
