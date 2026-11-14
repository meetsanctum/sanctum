import { sightingKey, type Sighting } from "@meetsanctum/app-sdk";

import type { DiscoveryAnswer } from "../manager.js";

// What the manager finds on the home's network for the apps that look for it.
// The manager never calls the core, so the core asks: a long poll, answered
// at once with what changed or within 30 s with nothing, naming the services
// the apps that may look are looking for. An answer from another run of the
// manager, as after it restarts, holds every sighting afresh. A manager from
// before it finds nothing, so apps hear of nothing; one that doesn't answer
// is asked again a little later.

// How soon it looks again while nothing is looked for, which costs nothing,
// and while the manager can't look, which a manager's update may change.
const idleMs = 1_000;
const notYetMs = 30_000;
const firstRetryMs = 5_000;
const lastRetryMs = 60_000;

export type SightingsManager = {
  capabilities(): { discovery: boolean };
  discovery(
    after: string | null,
    services: readonly string[],
  ): Promise<DiscoveryAnswer>;
};

export type Sightings = ReturnType<typeof createSightings>;

export function createSightings(options: {
  manager: SightingsManager;
  // The services the apps that may look for them look for, now.
  services: () => readonly string[];
  // Something was found, changed or lost.
  onChange: () => void;
  log: (message: string) => void;
  notYetMs?: number;
  retryMs?: number;
}) {
  const { manager, log } = options;
  const kept = new Map<string, Sighting>();
  let after: string | null = null;
  let closed = false;
  let wake: (() => void) | undefined;

  function pause(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  }

  function take(answer: DiscoveryAnswer) {
    let changed = false;
    if (answer.full) {
      changed = kept.size > 0 || answer.found.length > 0;
      kept.clear();
    }
    for (const sighting of answer.found) {
      const key = sightingKey(sighting);
      if (JSON.stringify(kept.get(key)) === JSON.stringify(sighting)) continue;
      kept.set(key, sighting);
      changed = true;
    }
    for (const lost of answer.lost) {
      changed = kept.delete(sightingKey(lost)) || changed;
    }
    after = answer.after;
    if (changed) options.onChange();
  }

  async function follow() {
    let retry = options.retryMs ?? firstRetryMs;
    let failing = false;
    while (!closed) {
      const services = options.services();
      // Nothing to look for, or a manager that can't: nothing is found.
      const can = manager.capabilities().discovery;
      if (services.length === 0 || !can) {
        if (kept.size > 0) {
          kept.clear();
          after = null;
          options.onChange();
        }
        await pause(can ? idleMs : (options.notYetMs ?? notYetMs));
        continue;
      }
      try {
        take(await manager.discovery(after, services));
        retry = options.retryMs ?? firstRetryMs;
        if (failing) log("discovery: the manager answers again");
        failing = false;
      } catch (error) {
        if (closed) return;
        if (!failing) {
          log(`discovery: the manager didn't answer (${String(error)})`);
        }
        failing = true;
        await pause(retry);
        retry = Math.min(retry * 2, lastRetryMs);
      }
    }
  }

  return {
    start() {
      void follow().catch((error: unknown) => {
        log(`discovery: stopped asking the manager (${String(error)})`);
      });
    },

    /** What the manager last said it found, of the services asked for. */
    list(): Sighting[] {
      return [...kept.values()];
    },

    /** Asks again now rather than after a pause, as when an app starts looking. */
    nudge() {
      wake?.();
    },

    close() {
      closed = true;
      wake?.();
    },
  };
}
