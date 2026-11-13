import type {
  AppInfo,
  DeviceInfo,
  EntityInfo,
  Places,
  RoomSectionInfo,
} from "@meetsanctum/app-sdk";

export const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "hall", name: "Hall", floorId: null },
    { id: "attic", name: "Attic", floorId: null },
  ],
};

export function light(
  id: string,
  name: string,
  roomId: string | null,
  on: boolean,
): DeviceInfo {
  const state = { on, brightness: 40 };
  return {
    id,
    name,
    driverName: name,
    type: "light",
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId,
    availability: "online",
    lastSeenAt: null,
    firmware: null,
    probe: false,
    battery: null,
    leftAt: null,
    problem: null,
    capabilities: [
      {
        id: "light",
        kind: "light",
        features: { brightness: true, colorTemperature: null, color: false },
        state,
        observed: state,
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ],
  };
}
export const plug: DeviceInfo = {
  ...light("plug", "Kettle", "office", true),
  type: "switch",
  capabilities: [
    {
      id: "power",
      kind: "switch",
      features: {},
      state: { on: true },
      observed: { on: true },
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};
export const lamp = light("lamp", "Lamp", "office", true);
export const hallLight = light("hall-light", "Ceiling", "hall", false);
export const loose = light("loose", "Loose", null, false);

const moodsSection: RoomSectionInfo = {
  id: "moods.room",
  title: "Moods",
  entityType: "moods.mood",
  kind: "tiles",
  order: 200,
  press: { action: "moods.runMood" },
  open: { page: "room", label: "Edit" },
  whenEmpty: { roomHas: "light" },
};
const app = (id: string, name: string, section: RoomSectionInfo): AppInfo => ({
  id,
  name,
  version: "0.1.0",
  icon: { glyph: "sparkles", color: "ember" },
  pages: ["room"],
  permissions: [],
  requests: [],
  state: "running",
  settings: null,
  provides: {
    entities: [],
    widgets: [],
    roomSections: [section],
    devicePages: [],
  },
});
export const moods = app("sanctum.moods", "Moods", moodsSection);
// More apps' sections, which come after Moods by their weight, ties by
// app id, and before the devices.
export const spots = app("test.spots", "Spots", {
  ...moodsSection,
  id: "spots.room",
  title: "Spots",
  entityType: "spots.spot",
  order: 400,
  press: { action: "spots.use" },
  open: null,
  whenEmpty: null,
});
export const alarms = app("test.alarms", "Alarms", {
  ...spots.provides.roomSections[0]!,
  id: "alarms.room",
  title: "Alarms",
  entityType: "alarms.alarm",
  order: 500,
  press: { action: "alarms.arm" },
});
export const awnings = app("test.awnings", "Awnings", {
  ...alarms.provides.roomSections[0]!,
  id: "awnings.room",
  title: "Awnings",
  entityType: "awnings.awning",
});

export const entity = (
  appId: string,
  type: string,
  key: string,
  state: Record<string, unknown>,
): EntityInfo => ({
  app: appId,
  key,
  type,
  name: String(state.name),
  state: { icon: "sun", order: 0, active: false, input: { id: key }, ...state },
  updatedAt: "2026-10-29T10:00:00.000Z",
});
export const relax = entity("sanctum.moods", "moods.mood", "relax", {
  placeId: "office",
  name: "Relax",
  icon: "armchair",
  order: 0,
  active: true,
});
export const work = entity("sanctum.moods", "moods.mood", "work", {
  placeId: "office",
  name: "Work",
  icon: "briefcase",
  order: 1,
});

// A climate sensor in a room, as Zigbee brings one: a reading for each
// measure.
export function sensor(
  id: string,
  roomId: string | null,
  temperature: number,
  humidity: number,
  availability: DeviceInfo["availability"] = "online",
): DeviceInfo {
  const reading = (measure: "temperature" | "humidity", value: number) => ({
    id: measure,
    kind: "sensor" as const,
    features: { measures: measure },
    state: { value },
    observed: { value },
    desired: null,
    sync: "synced" as const,
    setBy: null,
    changedAt: null,
  });
  return {
    ...light(id, `${id} sensor`, roomId, false),
    type: "sensor",
    availability,
    battery: 87,
    capabilities: [
      reading("temperature", temperature),
      reading("humidity", humidity),
    ],
  };
}
