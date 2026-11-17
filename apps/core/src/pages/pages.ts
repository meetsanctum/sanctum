import { stat } from "node:fs/promises";
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
 * its major from that version on, where below 1.0 the minor is the major,
 * and a prerelease comes before its release, as SemVer orders them.
 */
export function kitFits(builtFor: string, served: string) {
  const parse = (version: string) => {
    const match =
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        version,
      );
    return match
      ? {
          core: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
          pre: match[4]?.split(".") ?? [],
        }
      : undefined;
  };
  const want = parse(builtFor);
  const have = parse(served);
  if (!want || !have) return false;
  if (want.core[0] !== have.core[0]) return false;
  if (want.core[0] === 0 && want.core[1] !== have.core[1]) return false;
  return compareVersions(have, want) >= 0;
}

// SemVer's precedence: the numbers, then a release after its prereleases,
// then prereleases identifier by identifier, numbers before words.
function compareVersions(
  a: { core: readonly number[]; pre: string[] },
  b: { core: readonly number[]; pre: string[] },
) {
  for (let each = 0; each < 3; each++) {
    if (a.core[each] !== b.core[each]) return a.core[each]! - b.core[each]!;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return b.pre.length - a.pre.length;
  }
  for (let each = 0; each < Math.max(a.pre.length, b.pre.length); each++) {
    const x = a.pre[each];
    const y = b.pre[each];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return Number(x) - Number(y);
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
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
  // Each folder of an app's versions never changes once staged, so each is
  // indexed once, and the kit once each time its kit.json changes. One that
  // couldn't be read, as when a file went while it was read, is tried again
  // next time rather than kept failed.
  let kit: Promise<KitIndex | null> | undefined;
  // When its kit.json last changed, looked at once a second at most: in
  // development ui-sdk's build replaces the kit as the core runs.
  let kitChanged: number | undefined;
  let kitLookedAt = -Infinity;
  const indexed = new Map<string, Promise<PagesIndex | null>>();
  const failures = new Map<string, number[]>();
  // Pages built for a kit this one can't stand in for, said once each.
  const misfits = new Set<string>();

  async function kitIndex() {
    if (now().getTime() - kitLookedAt >= 1_000) {
      kitLookedAt = now().getTime();
      const changed = await stat(join(kitDir, "kit.json")).then(
        (found) => found.mtimeMs,
        () => undefined,
      );
      if (changed !== kitChanged) {
        kitChanged = changed;
        kit = undefined;
      }
    }
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
