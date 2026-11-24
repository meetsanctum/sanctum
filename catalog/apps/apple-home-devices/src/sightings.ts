import {
  foundDevice,
  maxFound,
  type DriverDiscovery,
  type Sighting,
} from "@meetsanctum/app-sdk";

import type { Endpoint } from "./boxes.js";
import { kindOf, type BoxKind } from "./models.js";

// The boxes on the home's network, from what they announce. Each announces
// AirPlay, with its device id and model, and Companion, the remote control
// connection, under the same host name; an Apple TV is one this app can use
// once both are seen. A Companion announcement that drops for a moment, as one
// did for two minutes overnight, leaves the port it announced last.

export const airplayService = "_airplay._tcp";
export const companionService = "_companion-link._tcp";

/** A box as its announcements describe it. Only TVs have pairing endpoints. */
export type Box =
  | (Endpoint & { kind: "tv" })
  | (Pick<Endpoint, "deviceId" | "name" | "model"> & { kind: "homepod" });

type AirPlay = {
  deviceId: string;
  name: string;
  model: string;
  kind: BoxKind;
  host: string;
  address: string;
  port: number;
};

type Companion = { host: string; address: string; port: number };
const keepCompanionMs = 5 * 60_000;

/** The device id AirPlay announces, as the key the app adds the box by. */
export const keyOf = (deviceId: string) => deviceId.toLowerCase();

const deviceIdPattern = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

function txtOf(sighting: Sighting) {
  return Object.fromEntries(
    Object.entries(sighting.txt).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
}

// The host compared without case or a trailing dot.
const hostOf = (host: string) => host.toLowerCase().replace(/\.$/, "");

function airplayOf(sighting: Sighting): AirPlay | null {
  const txt = txtOf(sighting);
  const deviceId = txt.deviceid?.toUpperCase();
  const model = txt.model;
  if (!deviceId || !deviceIdPattern.test(deviceId) || !model) return null;
  const kind = kindOf(model);
  const name = foundDevice.shape.name.safeParse(sighting.name);
  if (!kind || !name.success) return null;
  return {
    deviceId,
    name: name.data,
    model,
    kind,
    host: hostOf(sighting.host),
    address: sighting.addresses[0]!,
    port: sighting.port,
  };
}

/** The boxes seen so far, from each change of what's announced. */
export function createSightings() {
  // By service and instance name, as discovery names them.
  const airplay = new Map<string, AirPlay>();
  const companion = new Map<string, Companion>();
  const lastCompanion = new Map<string, { link: Companion; until: number }>();

  return {
    /** Takes what changed; answers the keys of the boxes it changed. */
    take({ found, lost }: DriverDiscovery): Set<string> {
      const changed = new Set<string>();
      const gone: Companion[] = [];
      const touch = (host: string) => {
        for (const each of airplay.values()) {
          if (each.host === host) changed.add(keyOf(each.deviceId));
        }
      };
      for (const each of lost) {
        if (each.service === airplayService) {
          const was = airplay.get(each.name);
          airplay.delete(each.name);
          if (was) changed.add(keyOf(was.deviceId));
        } else if (each.service === companionService) {
          const was = companion.get(each.name);
          companion.delete(each.name);
          if (was) {
            gone.push(was);
            touch(was.host);
          }
        }
      }
      for (const sighting of found) {
        if (sighting.service === airplayService) {
          const was = airplay.get(sighting.name);
          if (was) changed.add(keyOf(was.deviceId));
          const now = airplayOf(sighting);
          if (now) {
            airplay.set(sighting.name, now);
            changed.add(keyOf(now.deviceId));
          } else {
            airplay.delete(sighting.name);
          }
        } else if (sighting.service === companionService) {
          const was = companion.get(sighting.name);
          const now = {
            host: hostOf(sighting.host),
            address: sighting.addresses[0]!,
            port: sighting.port,
          };
          companion.set(sighting.name, now);
          lastCompanion.delete(now.host);
          if (was && was.host !== now.host) touch(was.host);
          touch(now.host);
        }
      }
      if (gone.length > 0 || lastCompanion.size > 0) {
        const tvHosts = new Set(
          [...airplay.values()]
            .filter((each) => each.kind === "tv")
            .map((each) => each.host),
        );
        const at = Date.now();
        for (const [host, { until }] of lastCompanion) {
          if (!tvHosts.has(host) || at >= until) lastCompanion.delete(host);
        }
        for (const link of gone) {
          if (!tvHosts.has(link.host)) continue;
          lastCompanion.delete(link.host);
          lastCompanion.set(link.host, { link, until: at + keepCompanionMs });
          if (lastCompanion.size > maxFound) {
            lastCompanion.delete(lastCompanion.keys().next().value!);
          }
        }
      }
      return changed;
    },

    /** TVs with both announcements and HomePods seen on AirPlay, by key. */
    boxes(): Map<string, Box> {
      const boxes = new Map<string, Box>();
      const live = new Map<string, Companion>();
      for (const each of companion.values()) live.set(each.host, each);
      const at = Date.now();
      for (const each of airplay.values()) {
        const { deviceId, name, model, kind } = each;
        const key = keyOf(deviceId);
        if (kind === "homepod") {
          if (!boxes.has(key)) boxes.set(key, { deviceId, name, model, kind });
          continue;
        }
        const last = lastCompanion.get(each.host);
        const link =
          live.get(each.host) ?? (last && at < last.until ? last.link : null);
        if (!link) continue;
        boxes.set(key, {
          deviceId,
          name,
          model,
          kind,
          address: each.address,
          airplayPort: each.port,
          companionAddress: link.address,
          companionPort: link.port,
        });
      }
      return boxes;
    },
  };
}

export type Sightings = ReturnType<typeof createSightings>;
