import {
  deviceCategories,
  maintenanceOf,
  sensorMeasures,
  type CapabilityInfo,
  type DeviceInfo,
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

import { motionText } from "./motion";

// The home's lights, switches, remotes and sensors as tiles: one tile for
// each light, switch, button or motion sensor a device has, and one for each
// device with sensors, grouped in sections by room or by category. Each tile
// shows what the core shows: a command waiting for the device, a colour held
// for a light that is off, a device that did not answer, and one that is
// offline or not paired any more. A remote's shows its latest press for a
// few seconds; a sensor's its readings, in the unit the home shows
// temperatures in; a motion sensor's whether it sees motion, or for how long
// it has not. A remote or sensor on a battery gone quiet says "Not heard
// from" (maintenance.ts), not what it said days ago.

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

// What a tile says under its name. A light turning on or off says so while
// the command is on its way, but a new level or colour shows as it will be;
// a device that missed the last command says so until it answers; a colour
// or brightness held for a light that is off waits for it to turn on.
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
    case "pending": {
      const asked = capability.desired?.on;
      const was = capability.observed?.on;
      if (asked === true && was !== true) return "Turning on…";
      if (asked === false && was !== false) return "Turning off…";
      return shown;
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

const switchable = (capability: CapabilityInfo): capability is Switchable =>
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

type Occupancy = Extract<CapabilityInfo, { kind: "occupancy" }>;

const isOccupancy = (capability: CapabilityInfo): capability is Occupancy =>
  capability.kind === "occupancy";

// A motion sensor's tile: White while it sees motion, as a remote's after a
// press, otherwise how long it has seen none, by `now`.
function motionTile(
  device: DeviceInfo,
  capability: Occupancy,
  several: boolean,
  roomId: string | null,
  now: number,
  isQuiet: boolean,
): Tile {
  const base = {
    key: tileKey(device.id, capability.id),
    deviceId: device.id,
    capabilityId: capability.id,
    kind: "occupancy" as const,
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
  const { occupied } = capability.state;
  return {
    ...base,
    status: motionText(occupied, capability.changedAt, now),
    on: occupied,
    look: occupied ? "on" : "off",
    motion: { occupied, changedAt: capability.changedAt },
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
 * Every light, switch, button, sensor and motion sensor the devices have,
 * as tiles, and one for each device with none of them, with each button's
 * press of the last few seconds by its tile's key, and how long motion
 * sensors have been quiet by `now`, which also says which devices on a
 * battery have gone quiet.
 */
export function tilesOf(
  devices: DeviceInfo[],
  places: Places | undefined,
  pressed: ReadonlyMap<string, string> = new Map(),
  now = Date.now(),
) {
  const rooms = new Set((places?.rooms ?? []).map((room) => room.id));
  const unit = places?.home.temperatureUnit ?? "celsius";
  return devices.flatMap((device) => {
    const roomId =
      device.roomId && rooms.has(device.roomId) ? device.roomId : null;
    const isQuiet = maintenanceOf(device, now) === "quiet";
    const controls = device.capabilities.filter(switchable);
    const buttons = device.capabilities.filter(
      (each) => each.kind === "button",
    );
    const sensors = device.capabilities.filter(isSensor);
    const motion = device.capabilities.filter(isOccupancy);
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
      ...(sensors.length > 0
        ? [sensorTile(device, sensors, roomId, unit, isQuiet)]
        : []),
    ];
    // A device none of whose parts has a tile still has one of its own.
    return tiles.length > 0 ? tiles : [unknownTile(device, roomId, isQuiet)];
  });
}

const byName = (a: Tile, b: Tile) => a.name.localeCompare(b.name);

/** Tiles in a section for each room, in the order of the home's rooms; those without a room come last. */
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
      id: "no-room",
      title: noRoomName,
      tiles: tiles.filter((tile) => tile.roomId === null),
    },
  ]
    .filter((section) => section.tiles.length > 0)
    .map((section) => ({ ...section, tiles: section.tiles.sort(byName) }));
}

/** Tiles in a section for each category, as a room's page shows them. */
export function sectionsByCategory(tiles: Tile[]): TileSection[] {
  return deviceCategories
    .map((category) => ({
      id: category.id,
      title: category.title,
      tiles: tilesIn(category, tiles).sort(byName),
    }))
    .filter((section) => section.tiles.length > 0);
}

/**
 * A room's devices as its page shows them: a section for each category,
 * then the devices Sanctum cannot use, which no category holds.
 */
export function sectionsOfRoom(tiles: Tile[]): TileSection[] {
  const unknown = tiles.filter((tile) => tile.kind === "unknown").sort(byName);
  return [
    ...sectionsByCategory(tiles),
    ...(unknown.length > 0
      ? [{ id: "unknown", title: "Unknown devices", tiles: unknown }]
      : []),
  ];
}

/** A category's or a group's status: "3 on", "Off", or nothing for no tiles. */
export function onMeta(tiles: Tile[]) {
  const on = tiles.filter((tile) => tile.on).length;
  return on ? `${on} on` : tiles.length ? "Off" : "";
}
