// @vitest-environment jsdom
import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { DeviceDetail } from "../src/device-detail";
import { forgetPageTicket } from "../src/frames/page-ticket";
import { useDevices } from "../src/use-devices";
import { devicePageAnswer, pressesApp } from "./device-detail-app-fixtures";
import { unknownHome } from "./home-fixtures";
import { light, places, plug, sensor } from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({
  coreJson: vi.fn(),
  currentCredential: () => ({ token: "client" }),
}));

// A device's detail is the device's, whichever of its tiles opened it: the
// same pages in the same order, opening on the page of the tile pressed.

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];

const presses = pressesApp(["devices.read:button"]);

const button: CapabilityInfo = {
  id: "button",
  kind: "button",
  features: { actions: ["single"], holds: [] },
  state: null,
  observed: null,
  desired: null,
  sync: "synced",
  setBy: null,
  changedAt: null,
};

// A light with a button and a temperature sensor, as an ESPHome panel.
const panel: DeviceInfo = {
  ...light("panel", "Desk panel", "office", true),
  capabilities: [
    ...light("panel", "", null, true).capabilities,
    button,
    sensor("panel", "office", 22, 48).capabilities[0]!,
  ],
};

// A module with two relays.
const relay: DeviceInfo = {
  ...plug,
  id: "relay",
  name: "Relay",
  capabilities: [
    { ...plug.capabilities[0]!, id: "1" },
    {
      ...plug.capabilities[0]!,
      id: "2",
      state: { on: false },
      observed: { on: false },
    } as CapabilityInfo,
  ],
};

function Detail(props: { tileKey: string }) {
  const shown = useDevices(live);
  return (
    <DeviceDetail
      container={container}
      tileKey={props.tileKey}
      open
      devices={shown}
      apps={[presses]}
      live={live}
      home={unknownHome}
      onClose={() => {}}
      onCovering={() => {}}
      onShowActivity={() => {}}
      onOpenAppSettings={() => {}}
      onOpenStatus={() => {}}
    />
  );
}

async function open(tileKey: string) {
  await act(async () =>
    root.render(<Detail key={tileKey} tileKey={tileKey} />),
  );
  await act(async () => live.refresh());
}

const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
const tabs = () =>
  [...dialog().querySelectorAll('[role="tab"]')].map((each) => [
    each.getAttribute("aria-label"),
    each.getAttribute("aria-selected"),
  ]);
const posted = () =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([path]) => path === "/api/devices/command")
    .map(([, init]) => init?.json);

beforeEach(() => {
  forgetPageTicket();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  live = createLiveFeed();
  devices = [panel, relay];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    const page = devicePageAnswer(path, presses.info.id);
    if (page) return page;
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path === "/api/devices/command") return { ok: true, init };
    if (path.startsWith("/api/activity?")) return { entries: [], more: false };
    if (path.startsWith("/api/history/")) {
      const query = new URL(path, "http://core").searchParams;
      return {
        device: query.get("device"),
        capability: query.get("capability"),
        kind: "sensor",
        from: query.get("from"),
        to: query.get("to"),
        kept: false,
        states: [],
        period: query.get("period"),
        fields: {},
      };
    }
    throw new Error(`Unexpected ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("a light with a button and a temperature sensor", () => {
  it.each([
    ["panel/light", "Brightness"],
    ["panel/temperature", "Readings"],
    ["panel/button", "Presses, from Presses"],
  ])(
    "has the same pages from each of its tiles, opening from %s on %s",
    async (tileKey, page) => {
      await open(tileKey);

      expect(dialog().querySelector("h2")?.textContent).toBe("Desk panel");
      expect(dialog().textContent).toContain("Office · 40%");
      expect(tabs()).toEqual(
        [
          "Brightness",
          "Readings",
          "Presses, from Presses",
          "History",
          "Activity",
        ].map((each) => [each, each === page ? "true" : "false"]),
      );
    },
  );
});

describe("a device with two switches", () => {
  it("gives its second switch's tile that switch's own controls and history", async () => {
    await open("relay/2");

    expect(dialog().querySelector("h2")?.textContent).toBe("Relay 2");
    expect(dialog().textContent).toContain("Office · Off");
    expect(tabs()).toEqual([
      ["Power", "true"],
      ["History", "false"],
      ["Activity", "false"],
    ]);
    await act(async () =>
      dialog()
        .querySelector<HTMLButtonElement>('button[aria-label="Relay 2"]')!
        .click(),
    );
    expect(posted()).toEqual([
      { device: "relay", capability: "2", command: { on: true } },
    ]);
  });
});
