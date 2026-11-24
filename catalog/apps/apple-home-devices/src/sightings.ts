import type { DriverDiscovery, Sighting } from "@meetsanctum/app-sdk";

import type { Endpoint } from "./boxes.js";
import { kindOf, type BoxKind } from "./models.js";

// The boxes on the home's network, from what they announce. Each announces
// AirPlay, with its device id and model, and Companion, the remote control
// connection, under the same host name; an Apple TV is one this app can use
// once both are seen. A Companion announcement that drops for a moment, as one
// did for two minutes overnight, leaves the port it announced last.

export const airplayService = "_airplay._tcp";
export const companionService = "_companion-link._tcp";

/** A box as its announcements describe it. */
export type Box = Endpoint & { kind: BoxKind };

type AirPlay = {
  deviceId: string;
  name: string;
  model: string;
  host: string;
  address: string;
  port: number;
};

type Companion = { host: string; address: string; port: number };

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
  if (!kindOf(model)) return null;
  return {
    deviceId,
    name: sighting.name,
    model,
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
  // The Companion port each host announced last, kept while it's gone.
  const lastCompanion = new Map<string, Companion>();

  return {
    /** Takes what changed; answers the keys of the boxes it changed. */
    take({ found, lost }: DriverDiscovery): Set<string> {
      const changed = new Set<string>();
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
          if (was) touch(was.host);
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
          const now = {
            host: hostOf(sighting.host),
            address: sighting.addresses[0]!,
            port: sighting.port,
          };
          companion.set(sighting.name, now);
          lastCompanion.set(now.host, now);
          touch(now.host);
        }
      }
      return changed;
    },

    /** Every box seen with both announcements, by its key. */
    boxes(): Map<string, Box> {
      const boxes = new Map<string, Box>();
      for (const each of airplay.values()) {
        const kind = kindOf(each.model)!;
        // A HomePod is listed by AirPlay alone, since it's never connected.
        const link =
          lastCompanion.get(each.host) ??
          (kind === "homepod" ? { address: each.address, port: 0 } : null);
        if (!link) continue;
        boxes.set(keyOf(each.deviceId), {
          deviceId: each.deviceId,
          name: each.name,
          model: each.model,
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
