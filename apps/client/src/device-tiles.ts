import {
  deviceCategories,
  deviceCategoryOf,
  deviceTypes,
  maintenanceOf,
  sensorMeasures,
  type CapabilityInfo,
  type DeviceCategory,
  type DeviceInfo,
  type DeviceType,
  type Places,
  type SensorMeasure,
  type TemperatureUnit,
} from "@meetsanctum/app-sdk";
import {
  formatLightLevelRange,
  formatTemperatureRange,
  lightColour,
  pressLabel,
  type Tile,
  type TileSection,
} from "@meetsanctum/ui-sdk";

import { contactText } from "./contact";
import {
  canPlayPause,
  isMedia,
  isPlaying,
  mediaText,
  type Media,
} from "./media";
import { motionText } from "./motion";

// The home's lights, switches, remotes and sensors as tiles: one tile for
// each light, switch, button, motion sensor, contact sensor or media player
// a device has,
// and one for each device with sensors, grouped in sections by room or by
// category; a room's page joins a device's into one (roomTilesOf). Each
// tile shows what the core shows: a command waiting for the device as it
// will be, a colour held for a light that is off, a device that did not
// answer, and one that is offline or not paired any more. A remote's
// shows its latest press for a few seconds; a sensor's its readings, in the
// unit the home shows temperatures in; a motion sensor's whether it sees
// motion, or for how long it has not; a contact sensor's whether it is open,
// and for how long; a media player's what it is playing, White while it
// plays. A remote or sensor on a battery gone quiet says "Not
// heard from" (maintenance.ts), not what it said days ago.

const quiet = "Not heard from";

export const tileKey = (device: string, capability: string) =>
  `${device}/${capability}`;

/** What the place of the devices in no room is called, wherever it is named. */
export const noRoomName = "No room";

/** The tiles a category holds: those of the kinds of capability it does. */
export const tilesIn = (
  category: (typeof deviceCategories)[number],
  tiles: readonly Tile[],
) =>
  tiles.filter((tile) =>
    category.holds.some((each) => each.kind === tile.kind),
  );

// What a tile says under its name. A command on its way shows as it will be,
// with no word for the wait, since most land before a word could be read and
// it would only flash; a device that missed the last command says so until
// it answers; a colour or brightness held for a light that is off waits for
// it to turn on.
function statusOf(capability: Switchable, onText: string) {
  const on = capability.state?.on === true;
  const shown = on ? onText : "Off";
  switch (capability.sync) {
    case "conflict":
      return "Not responding";
    case "held": {
      const brightness =
        capability.kind === "light"
          ? capability.desired?.brightness
          : undefined;
      return `Off · ${brightness === undefined ? "new colour" : `${brightness}%`} when on`;
    }
    default:
      return shown;
  }
}

// What a tile says of a device that doesn't answer: one its network no
// longer has, as after a reset, is not paired any more.
const offline = (device: DeviceInfo) =>
  device.leftAt === null ? "Offline" : "Not paired";

// A capability a tile switches: a light or a switch.
type Switchable = Extract<CapabilityInfo, { kind: "light" | "switch" }>;

export const isSwitchable = (
  capability: CapabilityInfo,
): capability is Switchable =>
  capability.kind === "light" || capability.kind === "switch";

function tileOf(
  device: DeviceInfo,
  capability: Switchable,
  several: boolean,
  roomId: string | null,
): Tile {
  const base = {
    key: tileKey(device.id, capability.id),
    deviceId: device.id,
    capabilityId: capability.id,
    kind: capability.kind,
    roomId,
    // A double switch names each of its switches.
    name: several ? `${device.name} ${capability.id}` : device.name,
    look: "off" as const,
    on: false,
    dims: false,
    disabled: false,
  };
  if (device.availability === "offline") {
    return { ...base, status: offline(device), disabled: true };
  }
  if (!capability.state) {
    return { ...base, status: "Unknown" };
  }
  const { on } = capability.state;
  if (capability.kind === "light") {
    const { brightness } = capability.state;
    const dims = capability.features.brightness && brightness !== undefined;
    return {
      ...base,
      status: statusOf(capability, dims ? `${brightness}%` : "On"),
      on,
      look: on ? "lit" : "off",
      colour: lightColour(capability.state),
      dims,
      brightness: dims ? brightness : undefined,
    };
  }
  return {
    ...base,
    status: statusOf(capability, "On"),
    on,
    look: on ? "on" : "off",
  };
}

// A remote's tile: idle, or White with its latest press for a moment.
function buttonTile(
  device: DeviceInfo,
  capabilityId: string,
  several: boolean,
  roomId: string | null,
  pressed: string | undefined,
  isQuiet: boolean,
): Tile {
  return {
    key: tileKey(device.id, capabilityId),
    deviceId: device.id,
    capabilityId,
    kind: "button",
    roomId,
    // A device with several buttons names each, as a double switch does.
    name: several ? `${device.name} ${capabilityId}` : device.name,
    status:
      device.availability === "offline"
        ? offline(device)
        : pressed
          ? pressLabel(pressed)
          : isQuiet
            ? quiet
            : "Idle",
    look: pressed ? "on" : "off",
    on: pressed !== undefined,
    dims: false,
    disabled: device.availability === "offline",
  };
}

// The tile of a device with nothing here to show, which Sanctum cannot
// use: what its driver calls it under its name. It switches nothing, and
// opens the device's page as any tile does.
function unknownTile(
  device: DeviceInfo,
  roomId: string | null,
  isQuiet: boolean,
): Tile {
  return {
    key: tileKey(device.id, ""),
    deviceId: device.id,
    capabilityId: "",
    kind: "unknown",
    roomId,
    name: device.name,
    status:
      device.availability === "offline"
        ? offline(device)
        : isQuiet
          ? quiet
          : device.driverName,
    look: "off",
    on: false,
    dims: false,
    disabled: device.availability === "offline",
  };
}

type Sensor = Extract<CapabilityInfo, { kind: "sensor" }>;

const isSensor = (capability: CapabilityInfo): capability is Sensor =>
  capability.kind === "sensor";

// A sensor's tile, one for each device whatever it measures: what it reads
// now. Nothing is known of one that is offline, and one that has just
// joined waits for its first reading, which can take a while: sensors on a
// battery say something only every few minutes.
function sensorTile(
  device: DeviceInfo,
  sensors: Sensor[],
  roomId: string | null,
  unit: TemperatureUnit,
  isQuiet: boolean,
): Tile {
  const base = {
    key: tileKey(device.id, sensors[0]!.id),
    deviceId: device.id,
    capabilityId: sensors[0]!.id,
    kind: "sensor" as const,
    roomId,
    name: device.name,
    look: "off" as const,
    on: false,
    dims: false,
    disabled: false,
    measures: [...new Set(sensors.map((sensor) => sensor.features.measures))],
  };
  if (device.availability === "offline") {
    return { ...base, status: offline(device), disabled: true };
  }
  if (isQuiet) return { ...base, status: quiet };
  const readings: NonNullable<Tile["readings"]> = {};
  for (const sensor of sensors) {
    readings[sensor.features.measures] ??= sensor.state?.value;
  }
  const status = readingsText([readings], unit);
  return status
    ? { ...base, status, readings }
    : { ...base, status: "Waiting for a reading" };
}

type Motion = Extract<CapabilityInfo, { kind: "motion" }>;

const isMotion = (capability: CapabilityInfo): capability is Motion =>
  capability.kind === "motion";

// A motion sensor's tile: White while it sees motion, as a remote's after a
// press, otherwise how long it has seen none, by `now`.
function motionTile(
  device: DeviceInfo,
  capability: Motion,
  several: boolean,
  roomId: string | null,
  now: number,
  isQuiet: boolean,
): Tile {
  const base = {
    key: tileKey(device.id, capability.id),
    deviceId: device.id,
    capabilityId: capability.id,
    kind: "motion" as const,
    roomId,
    // A device that senses in several places names each.
    name: several ? `${device.name} ${capability.id}` : device.name,
    look: "off" as const,
    on: false,
    dims: false,
    disabled: false,
  };
  if (device.availability === "offline") {
    return { ...base, status: offline(device), disabled: true };
  }
  if (isQuiet) return { ...base, status: quiet };
  if (!capability.state) return { ...base, status: "Waiting for a reading" };
  const { motion } = capability.state;
  return {
    ...base,
    status: motionText(motion, capability.changedAt, now),
    on: motion,
    look: motion ? "on" : "off",
    motion: { motion, changedAt: capability.changedAt },
  };
}

// A media player's tile: what it is playing, White while it plays, and its
// round button plays or pauses it where it can now.
function mediaTile(
  device: DeviceInfo,
  capability: Media,
  several: boolean,
  roomId: string | null,
): Tile {
  const base = {
    key: tileKey(device.id, capability.id),
    deviceId: device.id,
    capabilityId: capability.id,
    kind: "media" as const,
    roomId,
    // A device with several players names each.
    name: several ? `${device.name} ${capability.id}` : device.name,
    look: "off" as const,
    on: false,
    dims: false,
    disabled: false,
  };
  if (device.availability === "offline") {
    return {
      ...base,
      status: offline(device),
      disabled: true,
      media: { playing: false, canPlayPause: false },
    };
  }
  const playing = isPlaying(capability);
  return {
    ...base,
    status: mediaText(capability),
    on: playing,
    look: playing ? "on" : "off",
    media: { playing, canPlayPause: canPlayPause(capability) },
  };
}

type Contact = Extract<CapabilityInfo, { kind: "contact" }>;

const isContact = (capability: CapabilityInfo): capability is Contact =>
  capability.kind === "contact";

// A contact sensor's tile: White while it is open, saying for how long by
// `now`, with the glyph of the door or window the household shows it as.
// One that is offline, has gone quiet or has said nothing yet is not
// known, which its tile never shows as closed.
function contactTile(
  device: DeviceInfo,
  capability: Contact,
  several: boolean,
  roomId: string | null,
  now: number,
  isQuiet: boolean,
): Tile {
  const base = {
    key: tileKey(device.id, capability.id),
    deviceId: device.id,
    capabilityId: capability.id,
    kind: "contact" as const,
    ...((device.shownAs === "door" || device.shownAs === "window") && {
      shownAs: device.shownAs,
    }),
    roomId,
    // A device with several contacts names each.
    name: several ? `${device.name} ${capability.id}` : device.name,
    look: "off" as const,
    on: false,
    dims: false,
    disabled: false,
  };
  if (device.availability === "offline") {
    return { ...base, status: offline(device), disabled: true };
  }
  if (isQuiet) return { ...base, status: quiet };
  if (!capability.state) return { ...base, status: "Waiting for a reading" };
  const { open } = capability.state;
  return {
    ...base,
    status: contactText(open, capability.changedAt, now),
    on: open,
    look: open ? "on" : "off",
    contact: { open, changedAt: capability.changedAt },
  };
}

/** One measure of some sensors: its value, or its lowest and highest across them. */
export type Reading = {
  measure: SensorMeasure;
  /** Such as "21.5°", "19.5–21.5°" or "48%". */
  text: string;
  /** As a screen reader says it, such as "19.5 to 21.5°". */
  spoken: string;
};

/** What each measure is called, as a screen reader says a reading. */
export const measureNames: Record<SensorMeasure, string> = {
  temperature: "Temperature",
  humidity: "Humidity",
  illuminance: "Light level",
};

/**
 * What the Environment category and the home's status range across the home:
 * a light level across it says nothing, since one room is dark while
 * another is bright.
 */
export const climateMeasures = ["temperature", "humidity"] as const;

/**
 * What some sensors read now, measure by measure, as a room's page, a
 * sensor's tile, the Environment category and the dashboard's status say it.
 * Humidity is in whole percent, as temperatures are in tenths of a degree;
 * a light level is in lux.
 */
export function readingsOf(
  readings: readonly Tile["readings"][],
  unit: TemperatureUnit,
  measures: readonly SensorMeasure[] = sensorMeasures,
): Reading[] {
  return measures.flatMap((measure) => {
    const values = readings.flatMap((each) => {
      const value = each?.[measure];
      return value === undefined ? [] : [value];
    });
    if (values.length === 0) return [];
    const [min, max] = [Math.min(...values), Math.max(...values)];
    let text: string;
    if (measure === "temperature") {
      text = formatTemperatureRange(min, max, unit, { compact: true });
    } else if (measure === "illuminance") {
      text = formatLightLevelRange(min, max);
    } else {
      const [low, high] = [Math.round(min), Math.round(max)];
      text = `${low === high ? low : `${low}–${high}`}%`;
    }
    return [{ measure, text, spoken: text.replace("–", " to ") }];
  });
}

/** What some sensors read now in a line, such as "21.5° · 48%"; empty when they read nothing. */
export function readingsText(
  readings: readonly Tile["readings"][],
  unit: TemperatureUnit,
  measures?: readonly SensorMeasure[],
) {
  return readingsOf(readings, unit, measures)
    .map((each) => each.text)
    .join(" · ");
}

/** The readings of the sensors among some tiles that answer. */
export const sensorReadings = (tiles: readonly Tile[]) =>
  tiles.flatMap((tile) =>
    tile.kind === "sensor" && tile.readings && !tile.disabled
      ? [tile.readings]
      : [],
  );

/**
 * Every light, switch, button, sensor, motion sensor and contact sensor
 * the devices have, as tiles, and one for each device with none of them,
 * with each button's press of the last few seconds by its tile's key, and
 * how long motion sensors have been quiet and contact sensors open by
 * `now`, which also says which devices on a battery have gone quiet.
 */
export function tilesOf(
  devices: DeviceInfo[],
  places: Places | undefined,
  pressed: ReadonlyMap<string, string> = new Map(),
  now = Date.now(),
) {
  const tilePlaces = tilePlacesOf(places);
  return devices.flatMap((device) =>
    tilesOfDevice(device, tilePlaces, pressed, now),
  );
}

export function tilePlacesOf(places: Places | undefined) {
  const rooms = new Set((places?.rooms ?? []).map((room) => room.id));
  const unit: TemperatureUnit = places?.home.temperatureUnit ?? "celsius";
  return { rooms, unit };
}

export function tilesOfDevice(
  device: DeviceInfo,
  { rooms, unit }: ReturnType<typeof tilePlacesOf>,
  pressed: ReadonlyMap<string, string>,
  now: number,
): Tile[] {
  const roomId =
    device.roomId && rooms.has(device.roomId) ? device.roomId : null;
  const isQuiet = maintenanceOf(device, now) === "quiet";
  const controls = device.capabilities.filter(isSwitchable);
  const buttons = device.capabilities.filter((each) => each.kind === "button");
  const sensors = device.capabilities.filter(isSensor);
  const motion = device.capabilities.filter(isMotion);
  const contacts = device.capabilities.filter(isContact);
  const players = device.capabilities.filter(isMedia);
  const tiles = [
    ...controls.map((capability) =>
      tileOf(device, capability, controls.length > 1, roomId),
    ),
    ...buttons.map((button) =>
      buttonTile(
        device,
        button.id,
        buttons.length > 1,
        roomId,
        pressed.get(tileKey(device.id, button.id)),
        isQuiet,
      ),
    ),
    // A motion sensor that measures has both tiles, its motion's first.
    ...motion.map((capability) =>
      motionTile(device, capability, motion.length > 1, roomId, now, isQuiet),
    ),
    ...contacts.map((capability) =>
      contactTile(
        device,
        capability,
        contacts.length > 1,
        roomId,
        now,
        isQuiet,
      ),
    ),
    ...players.map((capability) =>
      mediaTile(device, capability, players.length > 1, roomId),
    ),
    ...(sensors.length > 0
      ? [sensorTile(device, sensors, roomId, unit, isQuiet)]
      : []),
  ];
  // A device none of whose parts has a tile still has one of its own.
  return tiles.length > 0 ? tiles : [unknownTile(device, roomId, isQuiet)];
}

const byName = (a: Tile, b: Tile) => a.name.localeCompare(b.name);

/** Tiles in a section for each room, in the order of the home's rooms; those without a room come last. */
/** The id of the section of tiles in no room, among rooms' sections. */
export const noRoomSection = "no-room";

export function sectionsByRoom(
  tiles: Tile[],
  places: Places | undefined,
): TileSection[] {
  return [
    ...(places?.rooms ?? []).map((room) => ({
      id: room.id,
      title: room.name,
      tiles: tiles.filter((tile) => tile.roomId === room.id),
    })),
    {
      id: noRoomSection,
      title: noRoomName,
      tiles: tiles.filter((tile) => tile.roomId === null),
    },
  ]
    .filter((section) => section.tiles.length > 0)
    .map((section) => ({ ...section, tiles: section.tiles.sort(byName) }));
}

// The kind of the capability that says what a device of a type is: a
// light's light, a plug's switch, a motion sensor's motion.
// A smart speaker's microphones have no tile: its room's tile is its media
// player's.
export const primaryKindOf = (type: DeviceType) =>
  type === "smart-speaker"
    ? "media"
    : deviceTypes.find((each) => each.id === type)?.needs[0];

const isControlTile = (tile: Tile) =>
  tile.kind === "light" || tile.kind === "switch";

/** A tile of a room's page, and the category whose section it is in: none for a device Sanctum cannot use. */
type RoomTile = { tile: Tile; category: DeviceCategory | undefined };

/**
 * The devices among some tiles as a room's page shows them: one tile for
 * all a device does, built from its tiles. It says the device's main state,
 * from its type, and sits in its type's category: a motion sensor that
 * measures says whether it sees motion, under Presence. It switches and
 * dims the device's light or switch of its type's kind, a light's first
 * light even where a switch comes before it, and otherwise its first light
 * or switch, with that tile's key, so a command waiting or failed shows on
 * it, and pressing it opens the detail on its first page. A further light
 * or switch keeps a tile of its own. A media device keeps its first
 * player's controls and any lights or switches get their own tiles. A press
 * flashes only a remote's: a light with a button goes on showing whether it
 * is on.
 */
function roomTilesOf(
  tiles: readonly Tile[],
  devices: readonly DeviceInfo[],
): RoomTile[] {
  const byDevice = new Map<string, Tile[]>();
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  for (const tile of tiles) {
    const own = byDevice.get(tile.deviceId);
    if (own) own.push(tile);
    else byDevice.set(tile.deviceId, [tile]);
  }
  return [...byDevice].flatMap(([id, own]) => {
    const device = devicesById.get(id);
    const kind = device && primaryKindOf(device.type);
    const ofKind = own.filter((tile) => tile.kind === kind);
    const first = ofKind[0] ?? own[0]!;
    const controls = own.filter(isControlTile);
    if (first.kind === "media") {
      return [
        {
          tile: { ...first, name: device?.name ?? first.name },
          category: "media",
        },
        ...controls.map((tile) => ({
          tile,
          category: deviceCategoryOf(tile.kind)?.id,
        })),
      ];
    }
    // Keep the tile's key stable but open the part whose state it shows.
    const active = isControlTile(first)
      ? first
      : (ofKind.find((tile) => tile.on) ?? first);
    const control = isControlTile(active) ? active : controls[0];
    const one: Tile = control
      ? {
          ...control,
          status: active.status,
          look: active.kind === "button" && active.on ? "on" : control.look,
        }
      : // A device with several motions or contacts goes by its own name.
        { ...active, key: first.key, name: device?.name ?? active.name };
    return [
      { tile: one, category: deviceCategoryOf(active.kind)?.id },
      ...controls
        .filter((tile) => tile.key !== control?.key)
        .map((tile) => ({
          tile,
          category: deviceCategoryOf(tile.kind)?.id,
        })),
    ];
  });
}

/**
 * A room's devices as its page shows them, a tile for each (roomTilesOf):
 * a section for each category, then the devices Sanctum cannot use, which
 * no category holds.
 */
export function sectionsOfRoom(
  tiles: readonly Tile[],
  devices: readonly DeviceInfo[],
): TileSection[] {
  const placed = roomTilesOf(tiles, devices);
  const of = (category: DeviceCategory | undefined) =>
    placed
      .filter((each) => each.category === category)
      .map((each) => each.tile)
      .sort(byName);
  const unknown = of(undefined);
  return [
    ...deviceCategories
      .map((category) => ({
        id: category.id,
        title: category.title,
        tiles: of(category.id),
      }))
      .filter((section) => section.tiles.length > 0),
    ...(unknown.length > 0
      ? [{ id: "unknown", title: "Unknown devices", tiles: unknown }]
      : []),
  ];
}

/** A category's or a group's status: "3 on", "Off", or nothing for no tiles. */
export function onMeta(tiles: readonly Tile[]) {
  const on = tiles.filter((tile) => tile.on).length;
  return on ? `${on} on` : tiles.length ? "Off" : "";
}
