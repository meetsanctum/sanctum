import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";

export const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [{ id: "office", name: "Office", floorId: null }],
};

export const lampState = {
  on: true,
  brightness: 40,
  colorMode: "color" as const,
  hue: 28,
  saturation: 65,
};
export const lamp: DeviceInfo = {
  id: "lamp",
  name: "Lamp",
  driverName: "Lamp",
  type: "light",
  driver: "sanctum.zigbee",
  manufacturer: null,
  model: null,
  roomId: "office",
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  battery: null,
  leftAt: null,
  capabilities: [
    {
      id: "light",
      kind: "light",
      features: {
        brightness: true,
        colorTemperature: { min: 153, max: 500 },
        color: true,
      },
      state: lampState,
      observed: lampState,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};
export const kettle: DeviceInfo = {
  ...lamp,
  type: "switch",
  id: "kettle",
  name: "Kettle",
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

// An office button, whose detail shows the pages apps add for remotes.
export const remote: DeviceInfo = {
  ...lamp,
  type: "button",
  id: "remote",
  name: "Office button",
  capabilities: [
    {
      id: "button",
      kind: "button",
      features: { actions: ["single", "double"], holds: [] },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};
