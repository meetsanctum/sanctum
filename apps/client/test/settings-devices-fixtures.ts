import type { AppInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";

// The home Settings → Devices' tests see: a light, an office button and
// the Zigbee app, and Maya on her MacBook.

export const office = { id: "office", name: "Office", floorId: null };
// A Saturday.
export const now = Date.parse("2026-10-31T12:00:00Z");
export const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [office],
  zones: [],
};
export function light(
  id: string,
  name: string,
  extra: Partial<DeviceInfo> = {},
) {
  return {
    id,
    name,
    driverName: "Hue Essential White and Color Ambiance A60",
    type: "light",
    driver: "sanctum.zigbee",
    manufacturer: "Philips",
    model: "9290022166",
    roomId: null,
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
        state: { on: false },
        observed: { on: false },
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ],
    ...extra,
  } satisfies DeviceInfo;
}
// The office button.
export const remote = {
  ...light("remote", "Office button", { roomId: "office" }),
  driverName: "Wireless mini switch",
  type: "button",
  manufacturer: "Aqara",
  model: "WXKG11LM",
  capabilities: [
    {
      id: "button",
      kind: "button",
      features: { actions: ["single", "double", "hold"], holds: [] },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
} satisfies DeviceInfo;
export const zigbee: AppInfo = {
  id: "sanctum.zigbee",
  name: "Zigbee",
  version: "0.2.0",
  icon: { glyph: "radio-tower", color: "graphite" },
  pages: ["main"],
  permissions: ["devices.register"],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
export const maya = {
  id: "maya",
  name: "Maya",
  avatar: null,
  colour: "#c5cdac",
} as const;
export const macbook = {
  id: "macbook",
  name: "Maya's MacBook",
  kind: "personal",
  platform: "macos",
  personId: "maya",
  createdAt: "2026-10-26T12:00:00Z",
  lastSeenAt: "2026-10-28T11:59:30Z",
  connectedSince: null,
  current: true,
} as const;
