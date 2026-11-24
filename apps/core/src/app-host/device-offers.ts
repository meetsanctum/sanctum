import {
  discoveredServices,
  foundDevice,
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

// How often to check a list that couldn't be read whole or can change.
const againMs = 60_000;

type Offered = { app: string; name: string; services: readonly string[] };

const hostOf = ({ host }: Sighting) => host.toLowerCase().replace(/\.$/, "");

// AirPlay alone also finds Macs and HomePods. Only tvOS devices with a
// Companion endpoint can be added through the Apple Home Devices offer.
function countAppleTvs(sightings: readonly Sighting[]) {
  const companionHosts = new Set(
    sightings
      .filter(({ service }) => service === "_companion-link._tcp")
      .map(hostOf),
  );
  const devices = new Set<string>();
  for (const each of sightings) {
    if (each.service !== "_airplay._tcp" || !companionHosts.has(hostOf(each))) {
      continue;
    }
    const txt = Object.fromEntries(
      Object.entries(each.txt).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const model = /^AppleTV(\d+),\d+$/.exec(txt.model ?? "");
    const deviceId = txt.deviceid?.toUpperCase();
    if (
      model &&
      Number(model[1]) >= 5 &&
      deviceId &&
      /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(deviceId) &&
      foundDevice.shape.name.safeParse(each.name).success
    ) {
      devices.add(deviceId);
    }
  }
  return devices.size;
}

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
}) {
  const { log } = options;
  let offered: Offered[] = [];
  // The catalog can be reused until the home's app list changes.
  let checkedFor: string | undefined;
  let isCacheFresh = false;
  let reading: Promise<void> | undefined;
  let isAgain = false;
  let timer: NodeJS.Timeout | undefined;
  let isClosed = false;

  const listKey = () => [...options.added.ids()].sort().join("\n");
  // An app added since the last read is no longer offered.
  const current = () => {
    if (offered.length === 0) return offered;
    const added = options.added.ids();
    return offered.filter(({ app }) => !added.has(app));
  };

  async function read() {
    const listing = await options.available.listing();
    if (isClosed || isAgain) return;
    let next = offeredOf(listing.apps);
    // An app only part of the list showed stays offered until it's read.
    if (!listing.isComplete) {
      const listed = new Set(listing.apps.map(({ id }) => id));
      const kept = offered.filter(({ app }) => !listed.has(app));
      next = [...next, ...kept];
    }
    isCacheFresh = listing.isCacheable;
    const changed = JSON.stringify(next) !== JSON.stringify(offered);
    offered = next;
    if (changed) options.onChange();
  }

  // One read at a time; a change while one is under way reads again after.
  function check() {
    if (isClosed || !options.hasInstalled()) return Promise.resolve();
    const key = listKey();
    if (key !== checkedFor) {
      checkedFor = key;
      isCacheFresh = false;
      isAgain = reading !== undefined;
    }
    if (reading) return reading;
    if (isCacheFresh) return Promise.resolve();
    reading = read()
      .catch((error: unknown) => {
        if (!isClosed)
          log(`apps: Add devices' offers weren't read (${String(error)})`);
      })
      .finally(() => {
        reading = undefined;
        if (isAgain) {
          isAgain = false;
          void check();
        }
      });
    return reading;
  }

  function interrupt() {
    isClosed = true;
    clearInterval(timer);
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
        // A device that announces two of its services is one device: each
        // counts once, by the host it announces.
        const matching = sightings.filter((each) =>
          services.includes(each.service),
        );
        const found =
          app === "sanctum.apple-home-devices"
            ? countAppleTvs(matching)
            : new Set(matching.map((each) => each.host.toLowerCase())).size;
        return found > 0 ? [{ app, name, found }] : [];
      });
    },

    /** The home's list may have changed: reads the offers again if so. */
    check,

    /** Reads now and checks for changes later. */
    start() {
      if (isClosed || timer) return;
      void check();
      timer = setInterval(() => void check(), againMs);
      timer.unref();
    },

    interrupt,

    async close() {
      interrupt();
      await reading;
    },
  };
}
