import {
  homeLocationSchema,
  temperatureUnits,
  type Floor,
  type HomeLocation,
  type Places,
  type Room,
  type Zone,
} from "@meetsanctum/app-sdk";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ChangedBy, RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { hostTimeZone } from "../workflows/time.js";
import { suggestLocation } from "./location.js";
import { floors, home, rooms, zoneRooms, zones } from "./schema.js";

// The Places module: the home and its floors, rooms and zones, kept in the
// core because devices and apps such as Moods all place things in rooms, and
// where the home is, which Weather and natural light both need. Admins
// change them through its routes; anyone signed in reads the rooms, apps
// read them with `places.read` and the location with `places.location`. The
// home's time zone stands on its own, so a household that keeps its
// coordinates to itself still has its clock, which the workflows engine
// reads.

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(60);
const level = z.number().int().min(-20).max(200);
const roomIds = z.array(id).max(500);

// The home's coordinates, with an optional elevation. An elevation left out
// stays while the latitude and longitude do (coordinatesAfter), so a client
// that does not know it yet takes nothing away; with new ones it goes, since
// it was for another place.
const coordinates = homeLocationSchema
  .pick({ latitude: true, longitude: true })
  .extend({ elevation: homeLocationSchema.shape.elevation.optional() });
const timeZone = homeLocationSchema.shape.timeZone;

// Null takes the time zone or the coordinates away, and the elevation with
// them.
export const homeChanges = z
  .object({
    name: name.optional(),
    timeZone: timeZone.nullable().optional(),
    coordinates: coordinates.nullable().optional(),
    temperatureUnit: z.enum(temperatureUnits).optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    "change the name, the time zone, the coordinates or the temperature unit",
  );
export const newFloor = z.object({ name, level: level.default(0) });
export const floorChanges = z.object({
  id,
  name: name.optional(),
  level: level.optional(),
});
export const newRoom = z.object({ name, floorId: id.nullable().default(null) });
export const roomChanges = z.object({
  id,
  name: name.optional(),
  floorId: id.nullable().optional(),
});
export const newZone = z.object({ name, roomIds: roomIds.default([]) });
export const zoneChanges = z.object({
  id,
  name: name.optional(),
  roomIds: roomIds.optional(),
});
export const removal = z.object({ id });

// The home's name until an admin gives it one.
const defaultHomeName = "Home";

// The home's id (schema.ts), made on the first start of its database. A
// row from before home ids gets one then, and a home without a row gets its
// row, with the default name until an admin gives it one. A database
// restored from a backup made before home ids therefore gets a new id, and
// apps take it for another home.
export function loadHomeId(
  db: CoreDatabase,
  now: () => Date = () => new Date(),
) {
  const homeId = randomUUID();
  db.transaction(() => {
    db.update(home)
      .set({ homeId })
      .where(and(eq(home.id, 1), isNull(home.homeId)))
      .run();
    db.insert(home)
      .values({ id: 1, homeId, name: defaultHomeName, updatedAt: now() })
      .onConflictDoNothing()
      .run();
  });
  return db
    .select({ homeId: home.homeId })
    .from(home)
    .where(eq(home.id, 1))
    .get()!.homeId!;
}

export class PlacesError extends Error {
  constructor(
    // location_unavailable: the services that suggest a location did not
    // answer (location.ts). time_zone_needed: coordinates without a time
    // zone, which Weather and natural light could not use.
    readonly code: "not_found" | "location_unavailable" | "time_zone_needed",
    message: string,
  ) {
    super(message);
  }
}

// The coordinates are both set or neither, and the elevation only with them.
function coordinatesOf(row: {
  latitude: number | null;
  longitude: number | null;
  elevation: number | null;
}) {
  return row.latitude !== null && row.longitude !== null
    ? {
        latitude: row.latitude,
        longitude: row.longitude,
        elevation: row.elevation,
      }
    : null;
}

// Where a change puts the home, keeping or dropping an elevation it leaves
// out as `coordinates` says.
function coordinatesAfter(
  changed: z.output<typeof coordinates> | null | undefined,
  current: ReturnType<typeof coordinatesOf>,
) {
  if (changed === undefined) return current;
  if (changed === null) return null;
  const isSameSpot =
    current?.latitude === changed.latitude &&
    current.longitude === changed.longitude;
  return {
    ...changed,
    elevation:
      changed.elevation === undefined
        ? isSameSpot
          ? current.elevation
          : null
        : changed.elevation,
  };
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name);

export function createPlaces(
  db: CoreDatabase,
  options: {
    record: RecordActivity;
    // Called after a change has committed, with the places before it, so
    // live clients and running apps can follow.
    onChange?: (places: Places, before: Places) => void;
    // Where the home is changed, which apps read apart from the places.
    onLocationChange?: (
      before: HomeLocation | null,
      after: HomeLocation | null,
    ) => void;
    // Capture dependent state before the foreign-key cascade; the returned
    // notification runs only once the removal has committed, before
    // onChange, so what follows the devices hears them move first.
    onRoomRemoving?: (roomId: string) => () => void;
    // For the location suggestion, which asks the internet.
    fetch?: typeof fetch;
    log?: (message: string) => void;
    now?: () => Date;
    // The time zone the core's own times use instead of the home's, as tests
    // set it.
    timeZone?: () => string | null;
  },
) {
  const { record } = options;
  const now = options.now ?? (() => new Date());

  // The home's name; the time zone its days run in: the one an admin set,
  // or the host's while there is none, as the workflows engine and apps'
  // jobs count it; and how it shows temperatures.
  function homeOf(row: typeof home.$inferSelect | undefined): Places["home"] {
    return {
      name: row?.name ?? defaultHomeName,
      timeZone: options.timeZone?.() ?? row?.timeZone ?? hostTimeZone(),
      temperatureUnit: row?.temperatureUnit ?? "celsius",
    };
  }

  function list(): Places {
    const memberships = db.select().from(zoneRooms).all();
    return {
      home: homeOf(db.select().from(home).get()),
      floors: db
        .select({ id: floors.id, name: floors.name, level: floors.level })
        .from(floors)
        .all()
        .sort((a, b) => a.level - b.level || byName(a, b)),
      rooms: db
        .select({ id: rooms.id, name: rooms.name, floorId: rooms.floorId })
        .from(rooms)
        .all()
        .sort(byName),
      zones: db
        .select({ id: zones.id, name: zones.name })
        .from(zones)
        .all()
        .sort(byName)
        .map((zone) => ({
          ...zone,
          roomIds: memberships
            .filter((member) => member.zoneId === zone.id)
            .map((member) => member.roomId),
        })),
    };
  }

  // Runs a change and its activity entry in one transaction, then tells
  // live clients and running apps, after `committed` when given.
  function change<T>(
    by: ChangedBy,
    action: string,
    work: () => {
      subjectId?: string;
      result: T;
      detail?: Record<string, unknown>;
    },
    committed?: () => void,
  ): T {
    const before = list();
    const wasAt = locationNow();
    const result = db.transaction(() => {
      const done = work();
      record({
        action,
        outcome: "ok",
        personId: by.personId,
        clientId: by.clientId,
        subjectId: done.subjectId,
        detail: done.detail,
      });
      return done.result;
    });
    committed?.();
    options.onChange?.(list(), before);
    const isAt = locationNow();
    if (JSON.stringify(wasAt) !== JSON.stringify(isAt)) {
      options.onLocationChange?.(wasAt, isAt);
    }
    return result;
  }

  function notFound(kind: string, placeId: string) {
    return new PlacesError("not_found", `No ${kind} ${placeId}`);
  }

  function assertFloor(floorId: string | null | undefined) {
    if (
      floorId &&
      !db
        .select({ id: floors.id })
        .from(floors)
        .where(eq(floors.id, floorId))
        .get()
    ) {
      throw notFound("floor", floorId);
    }
  }

  function setZoneRooms(zoneId: string, ids: readonly string[]) {
    const unique = [...new Set(ids)];
    const known = unique.length
      ? db
          .select({ id: rooms.id })
          .from(rooms)
          .where(inArray(rooms.id, unique))
          .all()
      : [];
    const missing = unique.find(
      (each) => !known.some((room) => room.id === each),
    );
    if (missing) {
      throw notFound("room", missing);
    }
    db.delete(zoneRooms).where(eq(zoneRooms.zoneId, zoneId)).run();
    if (unique.length) {
      db.insert(zoneRooms)
        .values(unique.map((roomId) => ({ zoneId, roomId })))
        .run();
    }
    return unique;
  }

  // The home's name, time zone and coordinates with its elevation.
  // Where the home is, for apps: its coordinates, elevation and time zone, or null
  // until an admin has set the coordinates and time zone.
  function locationNow(): HomeLocation | null {
    const { timeZone: zone, coordinates: at } = homeInfo();
    return zone && at ? { ...at, timeZone: zone } : null;
  }

  function homeInfo() {
    const row = db.select().from(home).get();
    return {
      name: row?.name ?? defaultHomeName,
      timeZone: row?.timeZone ?? null,
      coordinates: row ? coordinatesOf(row) : null,
      temperatureUnit: row?.temperatureUnit ?? "celsius",
    };
  }

  return {
    list,
    home: homeInfo,

    location: locationNow,

    // The home's time zone, or null while it uses the host's.
    timeZone(): string | null {
      return homeInfo().timeZone;
    },

    hasRoom(roomId: string) {
      return !!db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.id, roomId))
        .get();
    },

    hasZone(zoneId: string) {
      return !!db
        .select({ id: zones.id })
        .from(zones)
        .where(eq(zones.id, zoneId))
        .get();
    },

    // Where the home's public IP address says it is (location.ts), for the
    // admin to check and save; nothing is saved here.
    async suggestLocation(by: ChangedBy) {
      const entry = {
        action: "home.suggestLocation",
        personId: by.personId,
        clientId: by.clientId,
      };
      try {
        const suggestion = await suggestLocation(options.fetch ?? fetch);
        record({ ...entry, outcome: "ok" });
        return suggestion;
      } catch (error) {
        options.log?.(
          `places: no location suggestion (${error instanceof Error ? error.message : String(error)})`,
        );
        record({ ...entry, outcome: "failed", reason: "location_unavailable" });
        throw new PlacesError(
          "location_unavailable",
          "The location services did not answer",
        );
      }
    },

    updateHome(by: ChangedBy, input: z.input<typeof homeChanges>) {
      const changes = homeChanges.parse(input);
      return change(by, "home.update", () => {
        const current = homeInfo();
        const zone =
          changes.timeZone === undefined ? current.timeZone : changes.timeZone;
        const at = coordinatesAfter(changes.coordinates, current.coordinates);
        if (at && !zone) {
          throw new PlacesError(
            "time_zone_needed",
            "Coordinates need a time zone",
          );
        }
        const set = {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.temperatureUnit === undefined
            ? {}
            : { temperatureUnit: changes.temperatureUnit }),
          timeZone: zone,
          latitude: at?.latitude ?? null,
          longitude: at?.longitude ?? null,
          elevation: at?.elevation ?? null,
          updatedAt: now(),
        };
        db.insert(home)
          .values({ id: 1, name: defaultHomeName, ...set })
          .onConflictDoUpdate({ target: home.id, set })
          .run();
        return { result: homeInfo() };
      });
    },

    addFloor(by: ChangedBy, input: z.input<typeof newFloor>): Floor {
      const values = newFloor.parse(input);
      return change(by, "floor.add", () => {
        const at = now();
        const floor = { id: randomUUID(), ...values };
        db.insert(floors)
          .values({ ...floor, createdAt: at, updatedAt: at })
          .run();
        return { subjectId: floor.id, result: floor };
      });
    },

    updateFloor(by: ChangedBy, input: z.input<typeof floorChanges>): Floor {
      const { id: floorId, ...changes } = floorChanges.parse(input);
      return change(by, "floor.update", () => {
        const updated = db
          .update(floors)
          .set({ ...changes, updatedAt: now() })
          .where(eq(floors.id, floorId))
          .returning({ id: floors.id, name: floors.name, level: floors.level })
          .get();
        if (!updated) {
          throw notFound("floor", floorId);
        }
        return { subjectId: floorId, result: updated };
      });
    },

    // Its rooms stay, on no floor.
    removeFloor(by: ChangedBy, input: z.input<typeof removal>) {
      const { id: floorId } = removal.parse(input);
      change(by, "floor.remove", () => {
        if (
          !db.delete(floors).where(eq(floors.id, floorId)).returning().get()
        ) {
          throw notFound("floor", floorId);
        }
        return { subjectId: floorId, result: undefined };
      });
    },

    addRoom(by: ChangedBy, input: z.input<typeof newRoom>): Room {
      const values = newRoom.parse(input);
      return change(by, "room.add", () => {
        assertFloor(values.floorId);
        const at = now();
        const room = { id: randomUUID(), ...values };
        db.insert(rooms)
          .values({ ...room, createdAt: at, updatedAt: at })
          .run();
        return { subjectId: room.id, result: room };
      });
    },

    updateRoom(by: ChangedBy, input: z.input<typeof roomChanges>): Room {
      const { id: roomId, ...changes } = roomChanges.parse(input);
      return change(by, "room.update", () => {
        assertFloor(changes.floorId);
        const updated = db
          .update(rooms)
          .set({ ...changes, updatedAt: now() })
          .where(eq(rooms.id, roomId))
          .returning({ id: rooms.id, name: rooms.name, floorId: rooms.floorId })
          .get();
        if (!updated) {
          throw notFound("room", roomId);
        }
        return { subjectId: roomId, result: updated };
      });
    },

    // Its devices stay, in no room, and it leaves its zones.
    removeRoom(by: ChangedBy, input: z.input<typeof removal>) {
      const { id: roomId } = removal.parse(input);
      const notify = options.onRoomRemoving?.(roomId);
      change(
        by,
        "room.remove",
        () => {
          const removed = db
            .delete(rooms)
            .where(eq(rooms.id, roomId))
            .returning()
            .get();
          if (!removed) {
            throw notFound("room", roomId);
          }
          // Its name, for the entries that name the room.
          return {
            subjectId: roomId,
            result: undefined,
            detail: { name: removed.name },
          };
        },
        notify,
      );
    },

    addZone(by: ChangedBy, input: z.input<typeof newZone>): Zone {
      const values = newZone.parse(input);
      return change(by, "zone.add", () => {
        const at = now();
        const zoneId = randomUUID();
        db.insert(zones)
          .values({
            id: zoneId,
            name: values.name,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        const members = setZoneRooms(zoneId, values.roomIds);
        return {
          subjectId: zoneId,
          result: { id: zoneId, name: values.name, roomIds: members },
        };
      });
    },

    updateZone(by: ChangedBy, input: z.input<typeof zoneChanges>): Zone {
      const {
        id: zoneId,
        roomIds: members,
        ...changes
      } = zoneChanges.parse(input);
      return change(by, "zone.update", () => {
        const updated = db
          .update(zones)
          .set({ ...changes, updatedAt: now() })
          .where(eq(zones.id, zoneId))
          .returning({ id: zones.id, name: zones.name })
          .get();
        if (!updated) {
          throw notFound("zone", zoneId);
        }
        const roomList = members
          ? setZoneRooms(zoneId, members)
          : db
              .select({ roomId: zoneRooms.roomId })
              .from(zoneRooms)
              .where(eq(zoneRooms.zoneId, zoneId))
              .all()
              .map((member) => member.roomId);
        return { subjectId: zoneId, result: { ...updated, roomIds: roomList } };
      });
    },

    removeZone(by: ChangedBy, input: z.input<typeof removal>) {
      const { id: zoneId } = removal.parse(input);
      change(by, "zone.remove", () => {
        if (!db.delete(zones).where(eq(zones.id, zoneId)).returning().get()) {
          throw notFound("zone", zoneId);
        }
        return { subjectId: zoneId, result: undefined };
      });
    },
  };
}

export type PlacesModule = ReturnType<typeof createPlaces>;
