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

/**
 * Whether a kit can stand in for the one pages were built against: one of
 * its major from that version on, where below 1.0 the minor is the major.
 */
export function kitFits(builtFor: string, served: string) {
  const parts = (version: string) =>
    /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  const want = parts(builtFor);
  const have = parts(served);
  if (!want || !have) return false;
  const [wantMajor, wantMinor, wantPatch] = want as [number, number, number];
  const [haveMajor, haveMinor, havePatch] = have as [number, number, number];
  if (wantMajor !== haveMajor) return false;
  if (wantMajor === 0 && wantMinor !== haveMinor) return false;
  return haveMinor !== wantMinor
    ? haveMinor > wantMinor
    : havePatch >= wantPatch;
}

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
  // versions never changes once staged, so each is indexed once. One that
  // couldn't be read, as when a file went while it was read, is tried again
  // next time rather than kept failed.
  let kit: Promise<KitIndex | null> | undefined;
  const indexed = new Map<string, Promise<PagesIndex | null>>();
  const failures = new Map<string, number[]>();
  // Pages built for a kit this one can't stand in for, said once each.
  const misfits = new Set<string>();

  function kitIndex() {
    kit ??= indexKit(kitDir, log).catch((error: unknown) => {
      log(`pages: the kit couldn't be read (${String(error)})`);
      kit = undefined;
      return null;
    });
    return kit;
  }

  return {
    tickets,

    /** The kit this core serves, or none where its image has none. */
    kit: kitIndex,

    /**
     * An installed app's pages at the version it runs, or none: none too
     * when they were built for a kit this core's can't stand in for.
     */
    async pagesOf(appId: string) {
      const running = runningPackage(appId);
      if (!running) return null;
      const key = `${appId}/${running.folder}`;
      let found = indexed.get(key);
      if (!found) {
        found = indexPages(
          join(packagesDir, appId, running.folder, "pages"),
          log,
        ).catch((error: unknown) => {
          log(`pages: ${appId}'s pages couldn't be read (${String(error)})`);
          indexed.delete(key);
          return null;
        });
        indexed.set(key, found);
      }
      const pages = await found;
      const served = await kitIndex();
      if (!pages || !served) return null;
      if (!kitFits(pages.kit, served.version)) {
        if (!misfits.has(key)) {
          misfits.add(key);
          log(
            `pages: ${appId}'s pages need kit ${pages.kit}, and this core's is ${served.version}`,
          );
        }
        return null;
      }
      return { ...pages, name: running.name };
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
