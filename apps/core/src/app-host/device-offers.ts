import {
  discoveredServices,
  type AvailableApp,
  type DeviceOffer,
  type Sighting,
} from "@meetsanctum/app-sdk";

import type { AddedApps } from "./added.js";
import type { AvailableApps } from "./available.js";

// An app the home could add that finds its devices on the home's network, as
// ESPHome does, is offered in Add devices once one of them announces itself:
// "2 ESPHome devices found", with Add ESPHome, which opens its sheet. It needs
// the local network, so it asks rather than adding itself. The core looks for
// the services those apps would look for, and counts what it finds; the
// sightings reach no app until one is added and granted them.

// How soon a list that couldn't be read whole is read again.
const againMs = 60_000;

type Offered = { app: string; name: string; services: readonly string[] };

const offeredOf = (apps: readonly AvailableApp[]): Offered[] =>
  apps.flatMap((app) => {
    const services = discoveredServices(app.requests.map(({ id }) => id));
    return services.length > 0
      ? [{ app: app.id, name: app.name, services }]
      : [];
  });

export function createDeviceOffers(options: {
  available: Pick<AvailableApps, "listing">;
  added: Pick<AddedApps, "ids">;
  hasInstalled: () => boolean;
  // What the manager found on the home's network, of the services asked for.
  sightings: () => readonly Sighting[];
  // The apps offered, or what they'd look for, changed.
  onChange: () => void;
  log: (message: string) => void;
  againMs?: number;
}) {
  const { log } = options;
  let offered: Offered[] = [];
  // The home's list the offers were read for, so a change reads them again.
  let readFor: string | undefined;
  let reading: Promise<void> | undefined;
  let isAgain = false;
  let timer: NodeJS.Timeout | undefined;
  let isClosed = false;

  const listKey = () => [...options.added.ids()].sort().join("\n");
  // An app added since the last read is no longer offered.
  const current = () => {
    const added = options.added.ids();
    return offered.filter(({ app }) => !added.has(app));
  };

  async function read() {
    const key = listKey();
    let next: Offered[];
    let isComplete: boolean;
    try {
      const listing = await options.available.listing();
      next = offeredOf(listing.apps);
      isComplete = listing.isComplete;
    } catch (error) {
      log(`apps: Add devices' offers weren't read (${String(error)})`);
      return;
    }
    if (isClosed) return;
    // An app only part of the list showed stays offered until it's read.
    if (!isComplete) {
      const kept = offered.filter(
        (each) => !next.some(({ app }) => app === each.app),
      );
      next = [...next, ...kept];
    } else {
      readFor = key;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(offered);
    offered = next;
    if (changed) options.onChange();
  }

  // One read at a time; a change while one is under way reads again after.
  function check() {
    if (isClosed || !options.hasInstalled()) return Promise.resolve();
    if (reading) {
      isAgain = true;
      return reading;
    }
    if (readFor === listKey()) return Promise.resolve();
    reading = read().finally(() => {
      reading = undefined;
      if (isAgain) {
        isAgain = false;
        void check();
      }
    });
    return reading;
  }

  return {
    /** The services the apps offered would look for. */
    services(): string[] {
      return [...new Set(current().flatMap(({ services }) => services))];
    },

    /** The apps offered for devices found now, with how many each found. */
    list(): DeviceOffer[] {
      const sightings = options.sightings();
      return current().flatMap(({ app, name, services }) => {
        const found = sightings.filter((each) =>
          services.includes(each.service),
        ).length;
        return found > 0 ? [{ app, name, found }] : [];
      });
    },

    /** The home's list may have changed: reads the offers again if so. */
    check,

    /** Reads the offers now, and again while they couldn't be read whole. */
    start() {
      void check();
      // A list read whole isn't read again until the home's list changes.
      timer = setInterval(() => void check(), options.againMs ?? againMs);
      timer.unref();
    },

    async close() {
      isClosed = true;
      clearInterval(timer);
      await reading;
    },
  };
}

export type DeviceOffers = ReturnType<typeof createDeviceOffers>;
