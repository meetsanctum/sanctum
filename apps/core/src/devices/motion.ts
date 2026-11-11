import { names, type DeviceInfo } from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { PlacesModule } from "../places/places.js";
import type { Devices } from "./devices.js";
import type { View } from "./views.js";

// Motion and the light level in a room, a zone or the whole home, as the
// core's motion triggers and conditions and its light-level condition read
// them. A place has motion while any of its motion sensors that answer sees
// someone, and is quiet once every one that answers has said no motion,
// since the last of them did. A sensor that is offline or has yet to report
// does not count, so a place with none answering is neither. Its light level
// is the highest any of its light sensors that answer reads, so a dark
// corner does not make a bright room dark.

/**
 * Where motion and the light level are read: a room, a zone or the whole
 * home, as a lights place but never chosen lights. Its schema says
 * `place`, so Automations offers the same picker.
 */
export const motionPlace = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("room"), id: names("room") }),
    z.strictObject({ kind: z.literal("zone"), id: names("zone") }),
    z.strictObject({ kind: z.literal("home") }),
  ])
  .meta({ place: true });
export type MotionPlace = z.output<typeof motionPlace>;

export type PlaceMotion = {
  /** Whether any of its motion sensors answers. */
  answering: boolean;
  /** Whether any of those sees someone now. */
  occupied: boolean;
  /**
   * While it is quiet, since when: the time the last of its sensors said no
   * motion, or null while a sensor has said so but not when (before the
   * core kept the time).
   */
  quietSince: Date | null;
};

const nobody: PlaceMotion = {
  answering: false,
  occupied: false,
  quietSince: null,
};

/**
 * The rooms a place covers, or null for the whole home. A room or zone the
 * home no longer has covers none.
 */
export function placeRooms(
  places: Pick<PlacesModule, "list">,
  place: MotionPlace,
): ReadonlySet<string> | null {
  if (place.kind === "home") return null;
  const home = places.list();
  if (place.kind === "room") {
    return new Set(
      home.rooms.some((room) => room.id === place.id) ? [place.id] : [],
    );
  }
  return new Set(home.zones.find((zone) => zone.id === place.id)?.roomIds);
}

// The devices in these rooms that answer.
function answeringIn(
  devices: readonly DeviceInfo[],
  rooms: ReadonlySet<string> | null,
) {
  return devices.filter(
    (device) =>
      device.availability !== "offline" &&
      (!rooms || (device.roomId !== null && rooms.has(device.roomId))),
  );
}

/** Whether these devices see motion in these rooms, and since when it has been quiet. */
export function motionOf(
  devices: readonly DeviceInfo[],
  rooms: ReadonlySet<string> | null,
): PlaceMotion {
  const sensors = answeringIn(devices, rooms).flatMap((device) =>
    device.capabilities.flatMap((capability) =>
      capability.kind === "occupancy" && capability.observed
        ? [{ occupied: capability.observed.occupied, at: capability.changedAt }]
        : [],
    ),
  );
  if (sensors.length === 0) return nobody;
  if (sensors.some((sensor) => sensor.occupied)) {
    return { answering: true, occupied: true, quietSince: null };
  }
  const times = sensors.map((sensor) =>
    sensor.at === null ? NaN : Date.parse(sensor.at),
  );
  return {
    answering: true,
    occupied: false,
    quietSince: times.some(Number.isNaN) ? null : new Date(Math.max(...times)),
  };
}

/** The highest light level these devices read in these rooms, in lux, or null when none reads one. */
export function lightLevelOf(
  devices: readonly DeviceInfo[],
  rooms: ReadonlySet<string> | null,
): number | null {
  const levels = answeringIn(devices, rooms).flatMap((device) =>
    device.capabilities.flatMap((capability) =>
      capability.kind === "sensor" &&
      capability.features.measures === "illuminance" &&
      capability.observed
        ? [capability.observed.value]
        : [],
    ),
  );
  return levels.length > 0 ? Math.max(...levels) : null;
}

export function createMotion(options: {
  devices: Pick<Devices, "list">;
  places: Pick<PlacesModule, "list">;
}) {
  const { devices, places } = options;
  return {
    /**
     * A place's name as a run's entry keeps it, "motion in Office": the
     * room's or zone's, or "the home"; none for one the home no longer has.
     */
    name(place: MotionPlace): string | undefined {
      if (place.kind === "home") return "the home";
      const home = places.list();
      return (place.kind === "room" ? home.rooms : home.zones).find(
        (each) => each.id === place.id,
      )?.name;
    },

    /** Motion in a place now. */
    at(place: MotionPlace, view: View = {}): PlaceMotion {
      return motionOf(devices.list(view), placeRooms(places, place));
    },

    /**
     * Motion in a place before and after one device changed, as a trigger
     * compares them: before, with that device as it was.
     */
    around(
      place: MotionPlace,
      change: { id: string; before: DeviceInfo | null },
    ): { was: PlaceMotion; now: PlaceMotion } {
      const rooms = placeRooms(places, place);
      const now = devices.list();
      const was = now.flatMap((device) =>
        device.id === change.id ? [] : [device],
      );
      if (change.before) was.push(change.before);
      return { was: motionOf(was, rooms), now: motionOf(now, rooms) };
    },

    /** A place's light level now, in lux, or null when none of its sensors reads one. */
    lightLevel(place: MotionPlace, view: View = {}): number | null {
      return lightLevelOf(devices.list(view), placeRooms(places, place));
    },
  };
}

export type Motion = ReturnType<typeof createMotion>;
