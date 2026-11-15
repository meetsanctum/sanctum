import type { DeviceInfo, EntityInfo, Places } from "@meetsanctum/app-sdk";
import { useAppClient, useAppSettings } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useState } from "react";

import type { Preview } from "../preview.js";
import type { TargetState } from "../target.js";

// What natural light's page shows: the lights that take a colour
// temperature, by room once it may read the home's rooms, where each that
// follows the curve stands (its own naturalLight.target entities), whether
// natural light is on, and today's curve. Devices, entities and rooms are
// read once and then followed live; the curve is read again every minute,
// and at once when its settings change.

export type LightRow = {
  device: string;
  capability: string;
  name: string;
  roomId: string | null;
  /** Where it stands, while it follows the curve. */
  target: TargetState | null;
};

/** A room's lights, or those in no room (`id` null). */
export type RoomLights = {
  id: string | null;
  name: string;
  lights: LightRow[];
};

export type NaturalLightView = {
  loaded: boolean;
  lights: LightRow[];
  /** The lights by room, in the home's order; null while it may not read rooms. */
  rooms: RoomLights[] | null;
  /** Whether natural light is on, as its settings say. */
  isOn: boolean;
  /** Today's curve; null until the home has a location, undefined while loading. */
  preview: Preview | null | undefined;
  follow(light: LightRow, follow: boolean): Promise<void>;
  /** Every light in a room follows or is left out; answers those it couldn't change. */
  followRoom(room: RoomLights, follow: boolean): Promise<number>;
  resume(light: LightRow): Promise<void>;
};

const keyOf = (device: string, capability: string) => `${device}/${capability}`;

export function useNaturalLight(): NaturalLightView {
  const client = useAppClient();
  const [devices, setDevices] = useState<DeviceInfo[]>();
  const [entities, setEntities] = useState<EntityInfo[]>();
  const [preview, setPreview] = useState<Preview | null>();
  // Null when it may not read the home's rooms, or they couldn't be read.
  const [places, setPlaces] = useState<Places | null>();
  // Followed live, so a changed curve shows at once.
  const settings = useAppSettings();

  useEffect(() => {
    let isCurrent = true;
    // A live change that arrives while a read is under way makes it read
    // again, rather than overwrite the change with an older answer.
    let revision = 0;
    let request = 0;
    let placesRevision = 0;
    let placesRequest = 0;
    const load = async () => {
      const requestId = ++request;
      const startedAt = revision;
      try {
        const [nextDevices, nextEntities] = await Promise.all([
          client.devices(),
          client.entities(),
        ]);
        if (!isCurrent || requestId !== request) return;
        if (startedAt !== revision) {
          void load();
          return;
        }
        setDevices(nextDevices);
        setEntities(
          nextEntities.filter((entity) => entity.app === client.app.id),
        );
      } catch {
        // The shell asks again when the connection is back.
      }
    };
    const loadPlaces = async () => {
      const requestId = ++placesRequest;
      const startedAt = placesRevision;
      let next: Places | null;
      try {
        next = await client.places();
      } catch {
        next = null;
      }
      if (
        isCurrent &&
        requestId === placesRequest &&
        startedAt === placesRevision
      ) {
        setPlaces(next);
      }
    };
    const stop = client.subscribe({
      refresh: () => {
        void load();
        void loadPlaces();
      },
      message(message) {
        if (message.type === "places") {
          placesRevision += 1;
          setPlaces(message.places);
        } else if (message.type === "device") {
          revision += 1;
          setDevices((list) => {
            const others = (list ?? []).filter(
              (each) => each.id !== message.id,
            );
            return message.device ? [...others, message.device] : others;
          });
        } else if (message.type === "entity" && message.app === client.app.id) {
          revision += 1;
          setEntities((list) => {
            const others = (list ?? []).filter(
              (each) => each.key !== message.key,
            );
            return message.entity ? [...others, message.entity] : others;
          });
        }
      },
    });
    void load();
    void loadPlaces();
    return () => {
      isCurrent = false;
      stop();
    };
  }, [client]);

  useEffect(() => {
    let isCurrent = true;
    const read = async () => {
      try {
        const next = await client.call("naturalLight.preview", {});
        if (isCurrent) setPreview(next as Preview | null);
      } catch {
        // Read again on the next minute.
      }
    };
    void read();
    const timer = setInterval(() => void read(), 60_000);
    return () => {
      isCurrent = false;
      clearInterval(timer);
    };
  }, [client, settings]);

  const targets = new Map(
    (entities ?? []).map((entity) => [entity.key, entity.state as TargetState]),
  );
  const lights: LightRow[] = (devices ?? [])
    .flatMap((device) =>
      device.capabilities.flatMap((capability) => {
        const target = targets.get(keyOf(device.id, capability.id)) ?? null;
        const takes =
          capability.kind === "light" &&
          capability.features.colorTemperature !== null;
        return takes || target
          ? [
              {
                device: device.id,
                capability: capability.id,
                name: device.name,
                roomId: device.roomId,
                target,
              },
            ]
          : [];
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const rooms = places ? roomsOf(places, lights) : null;

  const follow = useCallback(
    async (light: LightRow, follow: boolean) => {
      await client.call("naturalLight.follow", {
        device: light.device,
        capability: light.capability,
        follow,
      });
    },
    [client],
  );
  const followRoom = useCallback(
    async (room: RoomLights, follow: boolean) => {
      const answer = (await client.call("naturalLight.followRoom", {
        placeId: room.id,
        follow,
      })) as { failed: unknown[] };
      return answer.failed.length;
    },
    [client],
  );
  const resume = useCallback(
    async (light: LightRow) => {
      await client.call("naturalLight.resume", {
        device: light.device,
        capability: light.capability,
      });
    },
    [client],
  );

  return {
    loaded:
      devices !== undefined && entities !== undefined && places !== undefined,
    lights,
    rooms,
    isOn: settings?.on !== false,
    preview,
    follow,
    followRoom,
    resume,
  };
}

/**
 * The lights by room, in the home's order, then those in no room; a room
 * with none is left out. A light whose room the home no longer has counts
 * as in no room.
 */
function roomsOf(places: Places, lights: readonly LightRow[]): RoomLights[] {
  const known = new Set(places.rooms.map((room) => room.id));
  const groups: RoomLights[] = places.rooms.map((room) => ({
    id: room.id,
    name: room.name,
    lights: lights.filter((light) => light.roomId === room.id),
  }));
  groups.push({
    id: null,
    name: "No room",
    lights: lights.filter(
      (light) => light.roomId === null || !known.has(light.roomId),
    ),
  });
  return groups.filter((group) => group.lights.length > 0);
}

/**
 * A colour temperature as people read it, such as 3,450 K: to 50 K, about
 * what one mired is worth around 4,000 K, so a light and the curve it
 * follows read alike.
 */
export function kelvinLabel(kelvin: number) {
  return `${(Math.round(kelvin / 50) * 50).toLocaleString()} K`;
}

/** A colour temperature in mireds, as people read it. */
export const kelvin = (mired: number) => kelvinLabel(1_000_000 / mired);

/** A time of day in the home's time zone, as this device writes times. */
export function timeOfDay(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}
