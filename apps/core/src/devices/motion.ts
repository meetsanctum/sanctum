import { names, type DeviceInfo, type Places } from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { CoreDatabase } from "../database.js";
import type { EventBusFollower } from "../event-bus.js";
import type { PlacesModule } from "../places/places.js";
import type { Devices } from "./devices.js";
import { placeSensing } from "./schema.js";
import type { View } from "./views.js";

// Motion and the light level in a room, a zone or the whole home, as the
// core's motion triggers and conditions and its light-level condition read
// them. A place has motion while any of its motion sensors that answer sees
// motion, and is quiet once every one that answers has said no motion,
// since the last of them did. A sensor that is offline or has yet to report
// does not count, so a place with none answering is neither. Its light level
// is the highest any of its light sensors that answer reads, so a dark
// corner does not make a bright room dark.
//
// Each place's motion is kept (place_sensing), and changes only as the place
// itself does, whatever made it: a sensor's report, a sensor moved, or a room
// that joined or left a zone. A place that goes quiet is quiet from that
// moment, even when the sensors left in it have been quiet for longer, and
// one that stays quiet keeps its time. So the triggers, their timers and the
// conditions that read it agree, also across a restart and while workflows
// are held, and a zone that loses its room with motion starts counting.

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
  /** Whether any of those sees motion now. */
  motion: boolean;
  /**
   * While it is quiet, since when: the time the last of its sensors said no
   * motion, or null while a sensor has said so but not when (before the
   * core kept the time).
   */
  quietSince: Date | null;
};

const nobody: PlaceMotion = {
  answering: false,
  motion: false,
  quietSince: null,
};

/**
 * A place's motion changed, as it was and is now.
 */
export type PlaceMotionChange = {
  place: MotionPlace;
  before: PlaceMotion;
  after: PlaceMotion;
};

/**
 * The places changed together, and the sensor whose own report made it, if
 * one did. Keeping them together starts each workflow once for one report,
 * with every trigger it matched.
 */
export type MotionChange = {
  places: PlaceMotionChange[];
  sensedBy: string | null;
};

/** A place as its kept motion names it: "home", "room:<id>" or "zone:<id>". */
export const placeKey = (place: MotionPlace) =>
  place.kind === "home" ? "home" : `${place.kind}:${place.id}`;

function placeOf(key: string): MotionPlace | null {
  if (key === "home") return { kind: "home" };
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  return kind === "room" || kind === "zone" ? { kind, id } : null;
}

const keptMotion = (row: typeof placeSensing.$inferSelect): PlaceMotion => ({
  answering: row.answering,
  motion: row.active,
  quietSince: row.inactiveSince,
});

// Every place motion is read in: the home, each room and each zone.
function everyPlace(home: Places): MotionPlace[] {
  return [
    { kind: "home" },
    ...home.rooms.map((room) => ({ kind: "room" as const, id: room.id })),
    ...home.zones.map((zone) => ({ kind: "zone" as const, id: zone.id })),
  ];
}

// The rooms a place covers in these places, or null for the whole home.
function roomsIn(home: Places, place: MotionPlace): ReadonlySet<string> | null {
  if (place.kind === "home") return null;
  if (place.kind === "room") {
    return new Set(
      home.rooms.some((room) => room.id === place.id) ? [place.id] : [],
    );
  }
  return new Set(home.zones.find((zone) => zone.id === place.id)?.roomIds);
}

/**
 * The rooms a place covers, or null for the whole home. A room or zone the
 * home no longer has covers none.
 */
export function placeRooms(
  places: Pick<PlacesModule, "list">,
  place: MotionPlace,
): ReadonlySet<string> | null {
  return roomsIn(places.list(), place);
}

const sameMotion = (a: PlaceMotion, b: PlaceMotion) =>
  a.answering === b.answering &&
  a.motion === b.motion &&
  a.quietSince?.getTime() === b.quietSince?.getTime();

// What a place's motion is now, from what it was and what its sensors say:
// quiet from this moment if it had motion, keeping its time if it was quiet,
// and as its sensors say when it starts answering.
function nextMotion(
  was: PlaceMotion | undefined,
  sensed: PlaceMotion,
  at: Date,
): PlaceMotion {
  if (!sensed.answering) return nobody;
  if (sensed.motion) return { answering: true, motion: true, quietSince: null };
  if (was?.motion) return { answering: true, motion: false, quietSince: at };
  if (was?.answering) {
    return { ...sensed, quietSince: was.quietSince ?? sensed.quietSince };
  }
  return sensed;
}

const sensesMotion = (device: DeviceInfo | null) =>
  device?.capabilities.some((each) => each.kind === "motion") ?? false;

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
      capability.kind === "motion" && capability.observed
        ? [{ motion: capability.observed.motion, at: capability.changedAt }]
        : [],
    ),
  );
  if (sensors.length === 0) return nobody;
  if (sensors.some((sensor) => sensor.motion)) {
    return { answering: true, motion: true, quietSince: null };
  }
  const times = sensors.map((sensor) =>
    sensor.at === null ? NaN : Date.parse(sensor.at),
  );
  return {
    answering: true,
    motion: false,
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
  db: CoreDatabase;
  devices: Pick<Devices, "list">;
  places: Pick<PlacesModule, "list">;
  // A place's motion changed, once it has been kept.
  onChange?: (change: MotionChange) => void;
  now?: () => Date;
}) {
  const { db, devices, places } = options;
  const now = options.now ?? (() => new Date());

  function kept(): Map<string, PlaceMotion> {
    return new Map(
      db
        .select()
        .from(placeSensing)
        .where(eq(placeSensing.kind, "motion"))
        .all()
        .map((row) => [row.place, keptMotion(row)]),
    );
  }

  function keep(key: string, motion: PlaceMotion, at: Date) {
    const values = {
      answering: motion.answering,
      active: motion.motion,
      inactiveSince: motion.quietSince,
      updatedAt: at,
    };
    db.insert(placeSensing)
      .values({ place: key, kind: "motion", ...values })
      .onConflictDoUpdate({
        target: [placeSensing.place, placeSensing.kind],
        set: values,
      })
      .run();
  }

  // Works every place's motion out again from its sensors and what it was,
  // keeps what changed, then says so. A place first seen, as the core first
  // keeps its motion or a room or zone is added, is kept as its sensors say,
  // and a place gone is forgotten, its motion now nobody's.
  function refresh(sensedBy: string | null, says = true) {
    const home = places.list();
    const sensors = devices.list();
    const was = kept();
    const at = now();
    const changes: PlaceMotionChange[] = [];
    db.transaction(() => {
      for (const place of everyPlace(home)) {
        const key = placeKey(place);
        const before = was.get(key);
        was.delete(key);
        const after = nextMotion(
          before,
          motionOf(sensors, roomsIn(home, place)),
          at,
        );
        if (before && sameMotion(before, after)) continue;
        keep(key, after, at);
        if (before) changes.push({ place, before, after });
      }
      for (const [key, before] of was) {
        db.delete(placeSensing)
          .where(
            and(eq(placeSensing.place, key), eq(placeSensing.kind, "motion")),
          )
          .run();
        const place = placeOf(key);
        if (place && !sameMotion(before, nobody)) {
          changes.push({ place, before, after: nobody });
        }
      }
    });
    if (says && changes.length > 0) {
      options.onChange?.({ places: changes, sensedBy });
    }
  }

  // Each place's motion, kept from the first time the core builds this, as
  // its sensors say then. Nothing is said: nothing changed.
  refresh(null, false);

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

    /**
     * Motion in a place now, as it's kept. A view that may not read motion
     * sensors, as a driver's that brings some itself, sees only those it
     * may, as they say now.
     */
    at(place: MotionPlace, view: View = {}): PlaceMotion {
      if (view.kinds && !view.kinds.has("motion")) {
        return motionOf(devices.list(view), placeRooms(places, place));
      }
      const row = db
        .select()
        .from(placeSensing)
        .where(
          and(
            eq(placeSensing.place, placeKey(place)),
            eq(placeSensing.kind, "motion"),
          ),
        )
        .get();
      // A room or zone just added is kept once the bus has said so.
      return row
        ? keptMotion(row)
        : motionOf(devices.list(), placeRooms(places, place));
    },

    // What the event bus says (event-bus.ts): a motion sensor that reported,
    // went offline or came back, moved, came or went, and a change of the
    // places. Only a sensor's own report, in the room it was in, sensed it.
    follower: {
      "device.changed"({ id, before, after }) {
        if (!sensesMotion(before) && !sensesMotion(after)) return;
        const stayed = before && after && before.roomId === after.roomId;
        refresh(stayed ? id : null);
      },
      "places.changed": () => refresh(null),
    } satisfies EventBusFollower,

    /** A place's light level now, in lux, or null when none of its sensors reads one. */
    lightLevel(place: MotionPlace, view: View = {}): number | null {
      return lightLevelOf(devices.list(view), placeRooms(places, place));
    },
  };
}

export type Motion = ReturnType<typeof createMotion>;
