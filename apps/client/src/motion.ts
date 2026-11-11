import type { Places } from "@meetsanctum/app-sdk";
import type { Tile } from "@meetsanctum/ui-sdk";

import { midnight, timeText } from "./device-history-data";

// What motion sensors say, in words rather than a value: on a sensor's tile,
// in a room's line under its name, and where in the home there is motion
// now, for its status and the Motion category. A place has motion while any
// of its motion sensors that answers sees it, and is quiet since the last of
// them went quiet, as the core's motion pieces read it
// (apps/core/src/devices/motion.ts). Offline sensors, and those yet to say
// anything, are left out.

const minute = 60_000;
const hour = 60 * minute;

const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

/**
 * What a motion sensor, or a place, says while it answers: "Motion now",
 * or how long there has been none. A sensor that has not said when it went
 * quiet, as before the core kept the time, says only "No motion".
 */
export function motionText(
  occupied: boolean,
  changedAt: string | null,
  now: number,
) {
  if (occupied) return "Motion now";
  const since = changedAt === null ? NaN : Date.parse(changedAt);
  if (Number.isNaN(since) || now - since < minute) return "No motion";
  if (now - since < hour) {
    return `No motion for ${Math.floor((now - since) / minute)} min`;
  }
  if (since >= midnight(now)) return `No motion since ${timeText(since)}`;
  if (since >= midnight(now, 1)) return "No motion since yesterday";
  return `No motion since ${date.format(since)}`;
}

/** The motion of the motion sensors among some tiles that answer and have said something. */
const answering = (tiles: readonly Tile[]) =>
  tiles.flatMap((tile) =>
    tile.kind === "occupancy" && tile.motion && !tile.disabled
      ? [tile.motion]
      : [],
  );

/**
 * A place's motion as its line says it, from its motion sensors' tiles:
 * "Motion now" while any sees it, otherwise quiet since the last of them
 * went quiet; null while none of them answers.
 */
export function placeMotionText(tiles: readonly Tile[], now: number) {
  const sensors = answering(tiles);
  if (sensors.length === 0) return null;
  if (sensors.some((sensor) => sensor.occupied)) return "Motion now";
  const times = sensors.map((sensor) =>
    sensor.changedAt === null ? NaN : Date.parse(sensor.changedAt),
  );
  const last = times.some(Number.isNaN)
    ? null
    : new Date(Math.max(...times)).toISOString();
  return motionText(false, last, now);
}

/** Where in the home there is motion now. */
export type HomeMotion = {
  /** Whether any motion sensor answers. */
  answering: boolean;
  /** The rooms with motion, in the home's order. */
  rooms: string[];
  /** Whether a sensor in no room sees motion. */
  elsewhere: boolean;
};

export function homeMotion(
  tiles: readonly Tile[],
  places: Places | undefined,
): HomeMotion {
  const seeing = (tile: Tile) =>
    tile.kind === "occupancy" &&
    !tile.disabled &&
    tile.motion?.occupied === true;
  return {
    answering: answering(tiles).length > 0,
    rooms: (places?.rooms ?? [])
      .filter((room) =>
        tiles.some((tile) => tile.roomId === room.id && seeing(tile)),
      )
      .map((room) => room.name),
    elsewhere: tiles.some((tile) => tile.roomId === null && seeing(tile)),
  };
}

/**
 * Where there is motion now, as the home's status says it: "Office",
 * "Office and Hall", "3 rooms" or "No motion". Motion from a sensor in no
 * room counts only while no room has any, as "Motion now".
 */
export function motionWhere(motion: HomeMotion) {
  const { rooms } = motion;
  if (rooms.length === 0) return motion.elsewhere ? "Motion now" : "No motion";
  if (rooms.length === 1) return rooms[0]!;
  if (rooms.length === 2) return `${rooms[0]} and ${rooms[1]}`;
  return `${rooms.length} rooms`;
}

/** The same as the Motion category says it under its name: "Motion in Office", "No motion". */
export function motionInText(motion: HomeMotion) {
  return motion.rooms.length > 0
    ? `Motion in ${motionWhere(motion)}`
    : motionWhere(motion);
}
