import { join } from "node:path";

import { addressKey } from "../auth/limits.js";
import type { CoreDatabase } from "../database.js";
import {
  indexKit,
  indexPages,
  type KitIndex,
  type PagesIndex,
} from "./files.js";
import { createPageTickets } from "./tickets.js";

// Apps' pages and the kit they import, for the frames the shell shows them
// in: the tickets clients load them with, and what the core serves, built
// from the kit in its image and each app's running package.

// An address that sends this many tickets that open nothing, in the window,
// is turned away until the window has passed.
const failuresAllowed = 30;
const failureWindowMs = 5 * 60_000;
const trackedAddresses = 1_024;

export function createPages(
  db: CoreDatabase,
  options: {
    packagesDir: string;
    kitDir: string;
    // The folder of the version an installed app runs, and its name.
    runningPackage: (appId: string) => { folder: string; name: string } | null;
    now: () => Date;
    log: (message: string) => void;
  },
) {
  const { packagesDir, kitDir, runningPackage, now, log } = options;
  const tickets = createPageTickets(db, { now });
  // The kit doesn't change while the core runs, and each folder of an app's
  // versions never changes once staged, so each is indexed once.
  let kit: Promise<KitIndex | null> | undefined;
  const indexed = new Map<string, Promise<PagesIndex | null>>();
  const failures = new Map<string, number[]>();

  return {
    tickets,

    /** The kit this core serves, or none where its image has none. */
    kit() {
      kit ??= indexKit(kitDir, log);
      return kit;
    },

    /** An installed app's pages at the version it runs, or none. */
    async pagesOf(appId: string) {
      const running = runningPackage(appId);
      if (!running) return null;
      const key = `${appId}/${running.folder}`;
      let found = indexed.get(key);
      if (!found) {
        found = indexPages(
          join(packagesDir, appId, running.folder, "pages"),
          log,
        );
        indexed.set(key, found);
      }
      const pages = await found;
      return pages ? { ...pages, name: running.name } : null;
    },

    /** Whether an address has sent too many tickets that open nothing. */
    turnedAway(address: string) {
      const recent = (failures.get(addressKey(address)) ?? []).filter(
        (at) => at > now().getTime() - failureWindowMs,
      );
      return recent.length >= failuresAllowed;
    },

    /** Counts a ticket that opened nothing. */
    failed(address: string) {
      const key = addressKey(address);
      const at = now().getTime();
      const recent = (failures.get(key) ?? []).filter(
        (each) => each > at - failureWindowMs,
      );
      failures.delete(key);
      failures.set(key, [...recent, at]);
      while (failures.size > trackedAddresses) {
        failures.delete(failures.keys().next().value!);
      }
    },
  };
}

export type Pages = ReturnType<typeof createPages>;
