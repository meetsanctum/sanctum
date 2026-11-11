import type { DeviceInfo } from "./devices.js";
import type { EntityInfo } from "./entities.js";
import type { PersonInfo } from "./people.js";
import type { Floor, HomeLocation, Places, Room, Zone } from "./places.js";

// The core's events: what happens to the core's own nouns, which an app
// follows from its start context with ctx.events.on(name, handler). Each is
// about a device, a place, a person or an entity of a standard type, needs
// the permission to read it, and shows it as the app's reads would; or about
// the app's own permissions, which needs none. Apps never hear another app's
// own events.

/** A place as the core's events name it: the home, a floor, a room or a zone. */
export type Place =
  | ({ kind: "home" } & Places["home"])
  | ({ kind: "floor" } & Floor)
  | ({ kind: "room" } & Room)
  | ({ kind: "zone" } & Zone);

// Something the app may read was added, changed or deleted: a change
// carries it before and after, a deletion it as it was last. One that
// itself changes so that it leaves what the app may read, such as a device
// whose last light goes, is deleted for that app. A permission switched off
// is never such a deletion: the app hears permissions.changed, and what the
// permission covered is only out of sight.
type Lifecycle<Noun extends string, T> =
  | ({ name: `${Noun}.added` } & Record<Noun, T>)
  | ({ name: `${Noun}.changed`; before: T } & Record<Noun, T>)
  | ({ name: `${Noun}.deleted` } & Record<Noun, T>);

/**
 * A device changed: a report, a command confirmed or in conflict, going
 * offline, moving to another room. Needs `devices.read:<kind>` (or
 * `devices.control:<kind>`) and shows the capabilities of those kinds only.
 */
export type DeviceEvent = Lifecycle<"device", DeviceInfo>;

/**
 * A remote was pressed: one of its button's actions, once for each press.
 * Needs `devices.read:button`; none goes out while the remote is captured.
 */
export type DevicePressEvent = {
  name: "device.pressed";
  device: DeviceInfo;
  capability: string;
  action: string;
};

/**
 * A floor, room or zone was added, changed or deleted, or the home was
 * renamed; needs `places.read`. Deleting a room moves its devices to no
 * room, each a device.changed, and takes it out of its zones.
 */
export type PlaceEvent = Lifecycle<"place", Place>;

/**
 * Where the home is was set, changed or taken away, null where there's none then;
 * needs `places.location`.
 */
export type LocationEvent = {
  name: "location.changed";
  location: HomeLocation | null;
  before: HomeLocation | null;
};

/** Someone joined the household, changed or left it; needs `people.read`. */
export type PersonEvent = Lifecycle<"person", PersonInfo>;

/**
 * An entity of a standard type was published, changed or removed, by
 * whichever app provides it; needs `entities.read:<type>`. A key that
 * changes type is deleted as the old type and added as the new one.
 */
export type EntityEvent = Lifecycle<"entity", EntityInfo>;

/**
 * The household granted the app a permission it asks for, or took one
 * away: what it may do now and what it could before. Losing a permission is
 * never a deletion: what it covered is only out of sight, so the app keeps
 * its data about it. Needs no permission.
 */
export type PermissionsEvent = {
  name: "permissions.changed";
  granted: string[];
  before: string[];
};

export type CoreEvent =
  | DeviceEvent
  | DevicePressEvent
  | PlaceEvent
  | LocationEvent
  | PersonEvent
  | EntityEvent
  | PermissionsEvent;

export const coreEventNames = [
  "device.added",
  "device.changed",
  "device.deleted",
  "device.pressed",
  "place.added",
  "place.changed",
  "place.deleted",
  "location.changed",
  "person.added",
  "person.changed",
  "person.deleted",
  "entity.added",
  "entity.changed",
  "entity.deleted",
  "permissions.changed",
] as const satisfies readonly CoreEvent["name"][];

export type CoreEventName = (typeof coreEventNames)[number];

export type CoreEventOf<Name extends CoreEventName> = Extract<
  CoreEvent,
  { name: Name }
>;

export type CoreEventHandler<Name extends CoreEventName = CoreEventName> = (
  event: CoreEventOf<Name>,
) => void | Promise<void>;

/**
 * The handlers an app's start context registers, by event name. They stay
 * on the app's side of the boundary: the core only learns which events the
 * app follows (CoreCalls.follow) and hands each one on as data.
 */
export type CoreEventHandlers = Map<CoreEventName, CoreEventHandler[]>;
