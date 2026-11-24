import type { CapabilityInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { useDevices } from "../src/use-devices";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// The shell's devices: what the core answers and pushes, the commands sent
// from here, and the tiles they fail.

export const places: Places = {
  home: {
    name: "Home",
    timeZone: "UTC",
    temperatureUnit: "celsius",
    hourCycle: "24h",
  },
  floors: [],
  zones: [],
  rooms: [{ id: "room", name: "Room", floorId: null }],
};
export const capability = (
  on: boolean,
): Extract<CapabilityInfo, { kind: "switch" }> => ({
  id: "switch",
  kind: "switch",
  features: {},
  state: { on },
  observed: { on },
  desired: null,
  sync: "synced",
  setBy: null,
  changedAt: null,
});
export const device = (on: boolean): DeviceInfo => ({
  id: "device",
  name: "Switch",
  driverName: "Switch",
  type: "switch",
  driver: "test",
  manufacturer: null,
  model: null,
  roomId: "room",
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  identify: false,
  battery: null,
  batteryLow: null,
  shownAs: null,
  leftAt: null,
  problem: null,
  capabilities: [capability(on)],
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
export let devices: ReturnType<typeof useDevices>;
// The core's routes the hook calls, each answering what a test gives it.
type Route = (json?: unknown) => Promise<unknown>;
export let client: {
  devices: ReturnType<typeof vi.fn<Route>>;
  places: ReturnType<typeof vi.fn<Route>>;
  command: ReturnType<typeof vi.fn<Route>>;
  lights: ReturnType<typeof vi.fn<Route>>;
};
export const live = createLiveFeed();
function Harness() {
  devices = useDevices(live);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = {
    devices: vi.fn<Route>(),
    places: vi.fn<Route>(),
    command: vi.fn<Route>(),
    lights: vi.fn<Route>(),
  };
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    switch (path) {
      case "/api/devices":
        return client.devices();
      case "/api/places":
        return client.places();
      case "/api/devices/command":
        return client.command(init?.json);
      case "/api/devices/lights":
        return client.lights(init?.json);
      default:
        throw new Error(`Not in this test: ${path}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

export async function seed() {
  await act(async () => {
    devices.apply({ type: "places", places });
    devices.apply({ type: "device", id: "device", device: device(false) });
  });
}

export function pendingLoad() {
  const snapshot = deferred<DeviceInfo[]>();
  client.devices.mockReturnValueOnce(snapshot.promise);
  client.places.mockResolvedValueOnce(places);
  let loading!: Promise<void>;
  act(() => {
    loading = devices.load();
  });
  return { snapshot, loading };
}
