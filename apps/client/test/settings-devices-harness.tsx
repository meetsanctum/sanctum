import type { DeviceInfo, PairingInfo } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import type { OnHome } from "../src/dashboards";
import { unknownHome } from "./home-fixtures";
import {
  light,
  macbook,
  maya,
  places,
  zigbee,
} from "./settings-devices-fixtures";

let root: Root;
export let container: HTMLDivElement;
export let devices: DeviceInfo[];
// What is on Home, and what Settings asked of it.
export let home: OnHome;
export let homeChanges: string[];
// Whether the devices keep their history.
let kept: boolean;
export let pairing: PairingInfo;
export let requests: { path: string; json?: unknown }[];
let removal: (json: { force: boolean }) => void;
export const live = createLiveFeed();

beforeEach(() => {
  homeChanges = [];
  home = {
    ...unknownHome,
    devices: ["desk"],
    add: async (device) => void homeChanges.push(`add ${device}`),
    remove: async (device) => void homeChanges.push(`remove ${device}`),
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  devices = [light("desk", "Light")];
  kept = true;
  pairing = {
    until: null,
    joined: [],
    drivers: ["sanctum.zigbee"],
    finders: [],
    offers: [],
    found: [],
  };
  requests = [];
  removal = () => undefined;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    requests.push({ path, json: init.json });
    // Settings shows the activity log's newest entries too.
    if (path.startsWith("/api/activity?")) return { entries: [], more: false };
    switch (path) {
      case "/api/devices":
        return devices;
      case "/api/places":
        return places;
      case "/api/devices/update": {
        const { id, ...changes } = init.json as { id: string };
        const device = { ...devices.find((each) => each.id === id)! };
        return Object.assign(device, changes);
      }
      case "/api/devices/remove":
        removal(init.json as { force: boolean });
        return { id: (init.json as { id: string }).id };
      case "/api/devices/pairing/open":
        pairing = { ...pairing, until: "2026-10-29T12:04:00.000Z" };
        return { ...pairing, since: "2026-10-29T12:00:00.000Z" };
      case "/api/devices/pairing/close":
        pairing = { ...pairing, until: null };
        return pairing;
      case "/api/devices/pairing":
        return pairing;
      case "/api/history/devices":
        return devices.map((each) => ({ device: each.id, kept }));
      case "/api/history/keep":
        kept = (init.json as { kept: boolean }).kept;
        return init.json;
      // What the rest of Settings asks for.
      case "/api/places/home":
        return { name: "Home", timeZone: null, coordinates: null };
      case "/api/auth/clients":
      case "/api/people":
      case "/api/entities":
        return [];
      default:
        return {};
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A category's page of Settings → Devices, or the list without one.
export async function show(me: Me, group: string | null = "lights") {
  await act(async () =>
    root.render(
      <SettingsPage
        page={group ? "device-group" : "devices"}
        params={group ? { id: group } : {}}
        open={() => undefined}
        back={() => undefined}
        apps={[zigbee]}
        me={me}
        core={{ state: "online", version: "1.2.3" } as never}
        live={live}
        devices={{ devices: [], places: undefined }}
        home={home}
        onUpdating={() => undefined}
      />,
    ),
  );
}

export const admin: Me = { client: macbook, person: maya };

// Sets an input's value the way typing does, so React sees it.
export async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// A button in the open dialog, if there is one: other sections of
// Settings have buttons of the same name, such as Household's Save.
export function button(name: string) {
  const scope = document.querySelector("[role=dialog]") ?? document;
  return [...scope.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
}

export async function choose(menu: string, item: string) {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${menu}"]`,
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  const found = [
    ...document.querySelectorAll<HTMLElement>(
      "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]",
    ),
  ].find((candidate) => candidate.textContent === item)!;
  await act(async () => found.click());
}

export function setDevices(next: DeviceInfo[]) {
  devices = next;
}

export function setPairing(next: PairingInfo) {
  pairing = next;
}

export function onRemove(remove: (json: { force: boolean }) => void) {
  removal = remove;
}
