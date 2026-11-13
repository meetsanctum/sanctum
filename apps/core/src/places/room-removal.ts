import type { RoomRemoval } from "@meetsanctum/app-sdk";

import type { AppHost } from "../app-host/host.js";
import type { Devices } from "../devices/devices.js";
import type { Entities } from "../entities/entities.js";
import type { Workflows } from "../workflows/workflows.js";
import { PlacesError, type PlacesModule } from "./places.js";

// What removing a room takes with it, for the warning someone reads before
// removing it; nothing changes here. Its devices move to No room and stay
// paired. Apps clean up what they keep for it on place.deleted, counted here
// from their entities whose state puts them in the room by `placeId`, as a
// room section's tiles do. Workflows keep their config, so those that name
// the room, in a field their pieces declare with names("room"), are broken
// once it is gone, until they are changed.

export function roomRemoval(
  modules: {
    places: Pick<PlacesModule, "hasRoom">;
    devices: Pick<Devices, "list">;
    entities: Pick<Entities, "list">;
    apps: Pick<AppHost, "list">;
    workflows: Pick<Workflows, "naming">;
  },
  roomId: string,
): RoomRemoval {
  if (!modules.places.hasRoom(roomId)) {
    throw new PlacesError("not_found", `No room ${roomId}`);
  }
  const devices = modules.devices
    .list()
    .filter((device) => device.roomId === roomId)
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const titles = new Map<string, string>(
    modules.apps
      .list()
      .flatMap((app) =>
        app.provides.entities.map(
          (type) => [`${app.id}\u0000${type.id}`, type.title] as const,
        ),
      ),
  );
  const counts = new Map<string, RoomRemoval["entities"][number]>();
  for (const entity of modules.entities.list()) {
    if (!isIn(entity.state, roomId)) continue;
    const key = `${entity.app}\u0000${entity.type}`;
    const counted = counts.get(key) ?? {
      app: entity.app,
      type: entity.type,
      title: titles.get(key) ?? entity.type,
      count: 0,
    };
    counted.count += 1;
    counts.set(key, counted);
  }

  const workflows = modules.workflows.naming("room", roomId);

  return { devices, entities: [...counts.values()], workflows };
}

function isIn(state: unknown, roomId: string) {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { placeId?: unknown }).placeId === roomId
  );
}
