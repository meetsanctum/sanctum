import type {
  AppInfo,
  DeviceInfo,
  FoundDevice,
  JoinedDevice,
  PairingInfo,
} from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import * as coreFetch from "../src/core-fetch";
import { light, office, zigbee } from "./settings-devices-fixtures";

// Add devices with what drivers found: an example driver's sensor that asks
// nothing and its plug that asks for its key, beside Zigbee letting devices
// join. The shared setup answers requests as the core would.

export const example: AppInfo = {
  ...zigbee,
  id: "sanctum.example",
  name: "Example",
};
export const key = {
  id: "key",
  label: "Encryption key",
  kind: "secret" as const,
  help: "Under api: encryption: key in its configuration.",
  placeholder: null,
  refusals: { wrongKey: "That key doesn't match. Copy it again." },
};
const sensor: FoundDevice = {
  driver: "sanctum.example",
  key: "kitchen",
  name: "Kitchen sensor",
  description: "temperature, humidity, motion",
  type: "sensor",
  asks: [],
  refusals: {
    notWaiting:
      "It stopped waiting for a key. Turn it off and on again, then add it.",
  },
};
export const plug: FoundDevice = {
  driver: "sanctum.example",
  key: "living-room",
  name: "Living room plug",
  description: "needs its encryption key",
  type: null,
  asks: [key],
  refusals: {},
};
export const joiningDevice: Omit<JoinedDevice, "stage"> = {
  driver: zigbee.id,
  key: "0x9",
  description: null,
  deviceId: null,
  known: false,
  joinedAt: "2026-10-29T12:00:01.000Z",
};

// What Add devices starts with: Zigbee lets devices join once asked, and the
// example driver found two.
function pairingAtStart(): PairingInfo {
  return {
    until: null,
    joined: [],
    drivers: ["sanctum.zigbee"],
    finders: [],
    offers: [],
    found: [sensor, plug],
  };
}

// What the core holds and was asked, which a test changes as it goes.
export const core: {
  devices: DeviceInfo[];
  adding: PairingInfo;
  requests: { path: string; json?: unknown }[];
  // What adding a device answers, by its key.
  answers: Record<string, (json: { answers: object }) => unknown>;
} = { devices: [], adding: pairingAtStart(), requests: [], answers: {} };

export let root: Root;
let container: HTMLDivElement;
export const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  core.devices = [];
  core.adding = pairingAtStart();
  core.requests = [];
  core.answers = {};
  vi.spyOn(coreFetch, "coreJson").mockImplementation(
    async (path, init = {}) => {
      core.requests.push({ path, json: init.json });
      switch (path) {
        case "/api/devices/pairing/open":
          core.adding = { ...core.adding, until: "2026-10-29T12:04:00.000Z" };
          return { ...core.adding, since: "2026-10-29T12:00:00.000Z" };
        case "/api/devices/pairing/close":
          core.adding = { ...core.adding, until: null };
          return core.adding;
        case "/api/devices/add": {
          const body = init.json as { key: string; answers: object };
          return core.answers[body.key]!(body);
        }
        default:
          return {};
      }
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

export async function show(
  onChanged: (device: DeviceInfo) => void = () => {},
  includeAdding = true,
) {
  await act(async () =>
    root.render(
      <AddDevices
        open
        onOpenChange={() => undefined}
        devices={core.devices}
        rooms={[office]}
        apps={[zigbee, example]}
        adding={includeAdding ? core.adding : undefined}
        live={live}
        onChanged={onChanged}
      />,
    ),
  );
  return document.querySelector<HTMLElement>("[role=dialog]")!;
}

// The overlay's page, under its title.
export const page = () =>
  document.querySelector<HTMLElement>(
    "[role=dialog] [data-slot=overlay-content]",
  )!;

// Chooses a way to add devices on the first page, by its name.
export async function way(name: string) {
  const card = [
    ...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
  ].find((candidate) => candidate.textContent?.startsWith(name));
  await act(async () => card!.click());
}

export function named(label: string) {
  return document.querySelector<HTMLButtonElement>(
    `[role=dialog] button[aria-label="${label}"]`,
  )!;
}

export async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export const cards = () => [
  ...page().querySelectorAll('[aria-label="Devices found"] > li'),
];

export const makeKitchenSensor = () =>
  light("sensor-1", "Kitchen sensor", {
    driver: "sanctum.example",
    driverName: "Kitchen sensor",
  });
