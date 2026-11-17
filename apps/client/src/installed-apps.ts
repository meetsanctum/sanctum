import type { AppInfo } from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { CoreError, coreJson } from "./core-fetch";

// The apps the home has installed, as the core lists them (GET /api/apps).
// After an update the core serves before it has installed its apps, and
// refuses the list until it has: what was listed stays meanwhile, since the
// home still has those apps, and the core is asked again soon.

// How soon the core is asked again while it can't say.
const waitingEveryMs = 2_000;

export function useInstalledApps(live: LiveFeed) {
  const [installed, setInstalled] = useState<AppInfo[]>([]);
  // The core couldn't say at the last read.
  const [isWaiting, setWaiting] = useState(false);
  const readId = useRef(0);
  const again = useRef<number>(undefined);
  // Grant changes answered while a read is under way.
  const changedApps = useRef(new Map<string, AppInfo>());
  // Whether the list is the home's, from a read that succeeded: until then
  // an app announced as it installs is one of many still to come.
  const hasRead = useRef(false);

  /** Reads the list. Any other failure leaves it for the next read. */
  const read = useCallback(async function read(): Promise<void> {
    const id = ++readId.current;
    window.clearTimeout(again.current);
    changedApps.current.clear();
    let next: AppInfo[];
    try {
      next = await coreJson<AppInfo[]>("/api/apps");
    } catch (error) {
      if (id !== readId.current) return;
      if (error instanceof CoreError && error.status === 503) {
        setWaiting(true);
        again.current = window.setTimeout(() => void read(), waitingEveryMs);
      }
      return;
    }
    if (id !== readId.current) return;
    hasRead.current = true;
    setWaiting(false);
    // Keep grant changes received during this read without dropping the
    // rest of the list, including when it is the first read. The same list
    // keeps the apps' clients, so their pages do not reload.
    const list = next.map((app) => changedApps.current.get(app.id) ?? app);
    setInstalled((current) =>
      JSON.stringify(current) === JSON.stringify(list) ? current : list,
    );
  }, []);

  /** Drops a read under way and asks no more until the next `read`. */
  const stop = useCallback(() => {
    readId.current += 1;
    window.clearTimeout(again.current);
  }, []);

  // An app as the core answered a change of its permissions, or adding it,
  // which the shell takes at once for everything that shows it.
  const appChanged = useCallback((changed: AppInfo) => {
    // A read started before this answer must keep these newer grants.
    changedApps.current.set(changed.id, changed);
    // One that's new, as when someone added it, joins the list in its
    // place by name.
    setInstalled((current) =>
      current.some((each) => each.id === changed.id) || !hasRead.current
        ? current.map((each) => (each.id === changed.id ? changed : each))
        : [...current, changed].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, []);
  // A change made on another client reaches this one at once, so the
  // app's pages get a client with what it holds now.
  useEffect(
    () =>
      live.subscribe({
        message(message) {
          if (message.type === "app") appChanged(message.app);
        },
      }),
    [live, appChanged],
  );

  return { installed, isWaiting, read, stop, appChanged };
}
