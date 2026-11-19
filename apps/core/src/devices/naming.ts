import {
  deviceWords,
  sensor,
  type DeviceWords,
  type SensorMeasure,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import type { PlacesModule } from "../places/places.js";
import { deviceType } from "./classification.js";
import { deviceCapabilities, devices } from "./schema.js";

// Automatic device names: a device the household has not named is called
// after its room and what it is, "Office Light", or "Light" while it is in
// no room, and numbered from 2 when another device has that name:
// "Office Light 2". Each word starts with a capital, as a name's words do,
// and names are compared ignoring case and spacing. A device keeps a number
// that is still free, so removing "Office Light" does not rename
// "Office Light 2". A device Sanctum cannot use is an "Unknown Device" in
// any room, since its type has no word to follow a room's name. A sensor is
// called by what it measures: "Office Temperature Sensor", and "Office
// Environment Sensor" for one that measures several things.

const wordSegments = new Intl.Segmenter("en", { granularity: "word" });

// "living room light" as "Living Room Light". A word with a capital of its
// own, "TV" or "iPad", stays as it is. Word boundaries keep punctuation
// outside a word and apostrophes within it.
function capitalizeWords(name: string) {
  return Array.from(wordSegments.segment(name), ({ segment, isWordLike }) =>
    isWordLike && !/\p{Lu}/u.test(segment)
      ? segment.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())
      : segment,
  ).join("");
}

/**
 * What a device with these words is called in this room, before any number:
 * its title in no room, and in any room for words with no noun.
 */
export function baseName(words: DeviceWords, room: string | null) {
  return capitalizeWords(
    room && words.noun ? `${room} ${words.noun}` : words.title,
  );
}

const normal = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

// Whether a name is the base or the base with a number from 2.
function isNumbered(base: string, name: string) {
  const rest = normal(name).slice(normal(base).length);
  return (
    normal(name).startsWith(normal(base)) &&
    (rest === "" || /^ ([2-9]|[1-9]\d+)$/.test(rest))
  );
}

/**
 * The name for a device called after `base`, which no other device has
 * (`taken`): its current name while that still fits and is free, otherwise
 * the base, or the base with the lowest free number.
 */
export function automaticName(
  base: string,
  taken: Iterable<string>,
  current?: string | null,
) {
  const names = new Set([...taken].map(normal));
  const free = (name: string) => !names.has(normal(name));
  if (current && isNumbered(base, current) && free(current)) {
    // Keep the number, but follow changes to the room's spelling too.
    return `${base}${normal(current).slice(normal(base).length)}`;
  }
  let name = base;
  for (let number = 2; !free(name); number++) {
    name = `${base} ${number}`;
  }
  return name;
}

/** Names the core's auto-named devices, inside the change that needs it. */
export function createNaming(
  db: CoreDatabase,
  places: Pick<PlacesModule, "list">,
) {
  function roomNames() {
    return new Map(places.list().rooms.map((room) => [room.id, room.name]));
  }

  // What a device's sensors measure, as stored. Features stored by another
  // build that don't parse say nothing.
  function measuresOf(id: string): SensorMeasure[] {
    return db
      .select({
        kind: deviceCapabilities.kind,
        features: deviceCapabilities.features,
      })
      .from(deviceCapabilities)
      .where(eq(deviceCapabilities.deviceId, id))
      .all()
      .flatMap((each) => {
        if (each.kind !== "sensor") return [];
        const features = sensor.features.safeParse(each.features);
        return features.success ? [features.data.measures] : [];
      });
  }

  // Names an auto-named device after its room and type, unless another
  // device has that name already. Devices without a name of their own go
  // by their driver's.
  function rename(id: string, rooms = roomNames()) {
    const device = db.select().from(devices).where(eq(devices.id, id)).get();
    if (!device?.autoNamed) {
      return;
    }
    const base = baseName(
      deviceWords(deviceType(device), measuresOf(id)),
      (device.roomId && rooms.get(device.roomId)) || null,
    );
    const taken = db
      .select({
        id: devices.id,
        name: devices.name,
        driverName: devices.driverName,
      })
      .from(devices)
      .all()
      .flatMap((other) =>
        other.id === id ? [] : [other.name ?? other.driverName],
      );
    const name = automaticName(base, taken, device.name);
    if (name !== device.name) {
      db.update(devices).set({ name }).where(eq(devices.id, id)).run();
    }
  }

  return { roomNames, rename };
}
