import { deviceTypes, type DeviceType } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import type { PlacesModule } from "../places/places.js";
import { deviceType } from "./classification.js";
import { deviceCapabilities, devices } from "./schema.js";

// Automatic device names: a device the household has not named is called
// after its room and what it is, "Office light", or "Light" while it is in
// no room, and numbered from 2 when another device has that name:
// "Office light 2". Names are compared ignoring case and spacing, and are
// in sentence case like the rest of the interface. A device keeps a number
// that is still free, so removing "Office light" does not rename
// "Office light 2".

const words = new Map<DeviceType, string>(
  deviceTypes.map((type) => [type.id, type.noun]),
);

/** What a device of this type is called in this room, before any number. */
export function baseName(type: DeviceType, room: string | null) {
  const word = words.get(type)!;
  return room ? `${room} ${word}` : `${word[0]!.toUpperCase()}${word.slice(1)}`;
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

  // Names an auto-named device after its room and type, unless another
  // device has that name already. Devices without a name of their own go
  // by their driver's.
  function rename(id: string, rooms = roomNames()) {
    const device = db.select().from(devices).where(eq(devices.id, id)).get();
    if (!device?.autoNamed) {
      return;
    }
    const capabilities = db
      .select({ kind: deviceCapabilities.kind })
      .from(deviceCapabilities)
      .where(eq(deviceCapabilities.deviceId, id))
      .all();
    const base = baseName(
      deviceType({ ...device, capabilities }),
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
