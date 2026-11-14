import {
  discoveredServices,
  sightingKey,
  type DriverDiscovery,
  type Sighting,
} from "@meetsanctum/app-sdk";

import type { InstalledApp } from "./installed.js";

// Drivers hear only the services they hold permission for. Each delivery
// follows the last completed one, taking its permissions and run afresh.
// Changes during a call are taken in once it ends; a failed call is retried
// with everything current and anything it may have missed losing.

const againMs = 30_000;

type Heard = {
  entry: InstalledApp;
  runId: number;
  sightings: Map<string, Sighting>;
  isPending: boolean;
  hasHeard: boolean;
  needsFull: boolean;
  retry?: NodeJS.Timeout;
};

const looks = (entry: InstalledApp) =>
  entry.manifest.driver?.hooks.includes("discovered") === true;

export function createDiscoveryHandOut(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  accepts: (entry: InstalledApp) => boolean;
  sightings: () => readonly Sighting[];
  discovered: (appId: string, discovery: DriverDiscovery) => Promise<void>;
  log: (message: string) => void;
  againMs?: number;
}) {
  const { installed, log } = options;
  const heard = new Map<string, Heard>();
  const turns = new Map<string, Promise<void>>();
  let isClosed = false;

  function forget(appId: string) {
    clearTimeout(heard.get(appId)?.retry);
    heard.delete(appId);
  }

  function isCurrent(appId: string, state: Heard) {
    return (
      !isClosed &&
      heard.get(appId) === state &&
      installed.get(appId) === state.entry &&
      state.entry.runId === state.runId
    );
  }

  async function handOut(appId: string, state: Heard) {
    if (!isCurrent(appId, state)) return;
    const services = new Set(discoveredServices(state.entry.granted));
    if (!options.accepts(state.entry) || services.size === 0) {
      forget(appId);
      return;
    }
    const want = new Map(
      options
        .sightings()
        .filter((sighting) => services.has(sighting.service))
        .map((sighting) => [sightingKey(sighting), sighting]),
    );
    const found = [...want].flatMap(([key, sighting]) =>
      !state.needsFull &&
      JSON.stringify(state.sightings.get(key)) === JSON.stringify(sighting)
        ? []
        : [sighting],
    );
    const lost = [...state.sightings]
      .filter(([key]) => !want.has(key))
      .map(([, { service, name }]) => ({ service, name }));
    if (state.hasHeard && found.length === 0 && lost.length === 0) {
      state.isPending = false;
      return;
    }
    try {
      await options.discovered(appId, { found, lost });
      if (!isCurrent(appId, state)) return;
      state.sightings = want;
      state.hasHeard = true;
      state.needsFull = false;
      state.isPending = false;
      sync();
    } catch (error) {
      if (!isCurrent(appId, state)) return;
      log(
        `apps: ${appId} didn't take in what was found (${error instanceof Error ? error.message : String(error)})`,
      );
      // A hook may have applied part of its input before failing. Keep both
      // sets so a sighting gone before the retry is still handed on as lost.
      state.sightings = new Map([...state.sightings, ...want]);
      state.needsFull = true;
      state.isPending = false;
      state.retry = setTimeout(() => {
        state.retry = undefined;
        sync();
      }, options.againMs ?? againMs);
      state.retry.unref();
    }
  }

  function sync() {
    if (isClosed) return;
    for (const appId of heard.keys()) {
      if (!installed.has(appId)) forget(appId);
    }
    for (const entry of installed.values()) {
      const appId = entry.app.id;
      if (
        !looks(entry) ||
        !options.accepts(entry) ||
        discoveredServices(entry.granted).length === 0
      ) {
        forget(appId);
        continue;
      }
      let state = heard.get(appId);
      if (state?.entry !== entry || state.runId !== entry.runId) {
        forget(appId);
        state = {
          entry,
          runId: entry.runId,
          sightings: new Map(),
          isPending: false,
          hasHeard: false,
          needsFull: false,
        };
        heard.set(appId, state);
      }
      if (state.isPending || state.retry) continue;
      state.isPending = true;
      // Recheck the run and permissions when this turn actually starts.
      const before = turns.get(appId) ?? Promise.resolve();
      const turn = before.then(() => handOut(appId, state));
      turns.set(appId, turn);
      void turn.then(() => {
        if (turns.get(appId) === turn) turns.delete(appId);
      });
    }
  }

  return {
    services() {
      return [
        ...new Set(
          [...installed.values()]
            .filter(looks)
            .flatMap((entry) => discoveredServices(entry.granted)),
        ),
      ].sort();
    },
    sync,
    close() {
      isClosed = true;
      for (const appId of heard.keys()) forget(appId);
    },
  };
}
