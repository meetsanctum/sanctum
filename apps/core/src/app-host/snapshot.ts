import type { DeviceInfo } from "@meetsanctum/app-sdk";

import type { Devices } from "../devices/devices.js";
import { viewOf, type View } from "../devices/views.js";
import type { Entities } from "../entities/entities.js";
import type { People } from "../people/people.js";
import type { PlacesModule } from "../places/places.js";

// What an app apart reads while its start hook runs: the home as it was when
// the hook began, however often it reads the same thing. The core's events
// it follows are delivered from that same moment on, so its catch-up and its
// events neither miss nor repeat a change. What it may read stays live: a
// permission switched off midway is still refused. Once the hook has ended,
// reads are live again.

type Live = {
  people: Pick<People, "list">;
  places: Pick<PlacesModule, "list" | "location">;
  devices: Devices;
  entities: Entities;
};

export function createReadSnapshot({
  people,
  places,
  devices,
  entities,
}: Live) {
  let held:
    | {
        people: ReturnType<People["list"]>;
        places: ReturnType<PlacesModule["list"]>;
        location: ReturnType<PlacesModule["location"]>;
        devices: DeviceInfo[];
        entities: ReturnType<Entities["list"]>;
      }
    | undefined = {
    people: people.list(),
    places: places.list(),
    location: places.location(),
    devices: devices.list(),
    entities: entities.list(),
  };

  return {
    people: { list: () => held?.people ?? people.list() },
    places: {
      list: () => held?.places ?? places.list(),
      location: () => (held ? held.location : places.location()),
    },
    devices: {
      ...devices,
      list: (view: View = {}) =>
        held
          ? held.devices.flatMap((device) => viewOf(device, view) ?? [])
          : devices.list(view),
      get(id: string, view: View = {}) {
        if (!held) {
          return devices.get(id, view);
        }
        const device = held.devices.find((each) => each.id === id);
        return device ? viewOf(device, view) : null;
      },
    } as Devices,
    entities: {
      ...entities,
      list: (filter: Parameters<Entities["list"]>[0] = {}) =>
        held
          ? held.entities.filter(
              (entity) =>
                (!filter.type || entity.type === filter.type) &&
                (!filter.app || entity.app === filter.app),
            )
          : entities.list(filter),
    } as Entities,
    /** The hook has ended, so what it reads from here on is live. */
    release() {
      held = undefined;
    },
  };
}

export type ReadSnapshot = ReturnType<typeof createReadSnapshot>;
