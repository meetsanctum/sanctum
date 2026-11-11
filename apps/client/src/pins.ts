import type { UpdatePins } from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { coreJson } from "./core-fetch";

// The apps pinned at the top of the sidebar, which the core keeps for the
// household, like the dashboards: read whenever the shell refreshes its live
// feed and followed over it in between. A change shows at once and is
// sent, in the order made; once the last has answered, they are read
// again, so a refused one goes.
export function usePins(live: LiveFeed) {
  // None until the core has answered.
  const [pins, setPins] = useState<string[]>();
  // Each read and each pushed list outdates the reads still out.
  const latest = useRef(0);
  const refresh = useRef<(() => Promise<void>) | undefined>(undefined);
  // Changes still on their way, which what the core pushes or answers
  // meanwhile would undo on screen.
  const changing = useRef(0);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    let isStopped = false;
    const read = async () => {
      if (isStopped) return;
      const requestId = ++latest.current;
      await coreJson<string[]>("/api/pins").then(
        (list) => {
          if (
            !isStopped &&
            requestId === latest.current &&
            changing.current === 0
          ) {
            setPins(list);
          }
        },
        () => undefined,
      );
    };
    refresh.current = read;
    const stop = live.subscribe({
      refresh: read,
      message(message) {
        if (message.type !== "pins" || changing.current > 0) return;
        latest.current += 1;
        setPins(message.apps);
      },
    });
    return () => {
      isStopped = true;
      refresh.current = undefined;
      changing.current = 0;
      writes.current = Promise.resolve();
      stop();
    };
  }, [live]);

  // The whole list in its new order. A refusal throws a CoreError.
  const change = useCallback(async (apps: string[]) => {
    const read = refresh.current;
    changing.current += 1;
    latest.current += 1;
    setPins(apps);
    const write = writes.current.then(async () => {
      if (!read || read !== refresh.current) return;
      await coreJson<string[]>("/api/pins/update", {
        method: "POST",
        json: { apps } satisfies UpdatePins,
      });
    });
    writes.current = write.catch(() => undefined);
    try {
      await write;
    } finally {
      if (read === refresh.current) {
        changing.current -= 1;
        if (changing.current === 0) await read?.();
      }
    }
  }, []);

  return { pins, change };
}
