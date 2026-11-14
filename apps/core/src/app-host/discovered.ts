import {
  discoveredServices,
  sightingKey,
  type DriverDiscovery,
  type Sighting,
} from "@meetsanctum/app-sdk";

import type { InstalledApp } from "./installed.js";

// What the drivers that look for devices on the home's network hear of them
// (driver.discovered): those of the services each holds discover:mdns: for,
// every one as it starts, then each found, changed or lost, in order. What
// each has heard is kept for its run, so a driver that starts again hears
// everything again, and one that couldn't take a change in hears everything
// a little later. A driver that isn't running, or holds no such permission,
// hears nothing.

const againMs = 30_000;

type Heard = {
  runId: number;
  sightings: Map<string, { said: string; service: string; name: string }>;
};

const looks = (entry: InstalledApp) =>
  entry.manifest.driver?.hooks.includes("discovered") === true;

export function createDiscoveryHandOut(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  // Whether it takes calls now.
  accepts: (entry: InstalledApp) => boolean;
  sightings: () => readonly Sighting[];
  // Hands a driver what changed.
  discovered: (appId: string, discovery: DriverDiscovery) => Promise<void>;
  log: (message: string) => void;
  againMs?: number;
}) {
  const { installed, log } = options;
  const heard = new Map<string, Heard>();
  const turns = new Map<string, Promise<void>>();
  let again: NodeJS.Timeout | undefined;

  function handOut(appId: string, discovery: DriverDiscovery) {
    const before = turns.get(appId) ?? Promise.resolve();
    const turn = before.then(() =>
      options.discovered(appId, discovery).catch((error: unknown) => {
        log(
          `apps: ${appId} didn't take in what was found (${error instanceof Error ? error.message : String(error)})`,
        );
        // It hears everything afresh.
        heard.delete(appId);
        again ??= setTimeout(() => {
          again = undefined;
          sync();
        }, options.againMs ?? againMs);
        again.unref?.();
      }),
    );
    turns.set(appId, turn);
    void turn.then(() => {
      if (turns.get(appId) === turn) turns.delete(appId);
    });
  }

  function sync() {
    const all = options.sightings();
    for (const entry of installed.values()) {
      if (!looks(entry)) continue;
      const appId = entry.app.id;
      const services = new Set(discoveredServices(entry.granted));
      // One not running, or not allowed to look, hears nothing; one allowed
      // again hears everything afresh.
      if (!options.accepts(entry) || services.size === 0) {
        heard.delete(appId);
        continue;
      }
      const want = new Map(
        all
          .filter((sighting) => services.has(sighting.service))
          .map((sighting) => [sightingKey(sighting), sighting]),
      );
      const before = heard.get(appId);
      const had =
        before?.runId === entry.runId
          ? before.sightings
          : new Map<string, never>();
      const found = [...want].flatMap(([key, sighting]) =>
        had.get(key)?.said === JSON.stringify(sighting) ? [] : [sighting],
      );
      const lost = [...had]
        .filter(([key]) => !want.has(key))
        .map(([, { service, name }]) => ({ service, name }));
      heard.set(appId, {
        runId: entry.runId,
        sightings: new Map(
          [...want].map(([key, sighting]) => [
            key,
            {
              said: JSON.stringify(sighting),
              service: sighting.service,
              name: sighting.name,
            },
          ]),
        ),
      });
      // A driver starting with nothing found hears so too, once.
      const starts = before?.runId !== entry.runId;
      if (found.length > 0 || lost.length > 0 || starts) {
        handOut(appId, { found, lost });
      }
    }
  }

  return {
    /** The services the drivers that may look are looking for. */
    services() {
      return [
        ...new Set(
          [...installed.values()]
            .filter(looks)
            .flatMap((entry) => discoveredServices(entry.granted)),
        ),
      ].sort();
    },

    /** Hands each driver what changed for it since it last heard. */
    sync,

    close() {
      clearTimeout(again);
    },
  };
}
