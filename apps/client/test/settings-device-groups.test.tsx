// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import { deferred } from "./deferred";
import { unknownHome } from "./home-fixtures";
import {
  light,
  macbook,
  maya,
  places,
  remote,
  zigbee,
} from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

// Settings → Devices' first page: a row for each category the home has
// devices in, which opens the category's page.

describe("Settings → Devices' categories", () => {
  let root: Root;
  let container: HTMLDivElement;
  let devices: DeviceInfo[];
  // The core's answer to the list of devices, while the test holds it.
  let devicesReply: Promise<DeviceInfo[]> | undefined;
  let opened: { page: string; params?: Record<string, string> }[];
  const live = createLiveFeed();
  const admin: Me = { client: macbook, person: maya };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    devices = [light("desk", "Light")];
    devicesReply = undefined;
    opened = [];
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path) => {
      if (path.startsWith("/api/activity?"))
        return { entries: [], more: false };
      switch (path) {
        case "/api/devices":
          return devicesReply ?? devices;
        case "/api/places":
          return places;
        case "/api/history/devices":
          return devices.map(({ id }) => ({ device: id, kept: true }));
        case "/api/devices/pairing":
          return { until: null, joined: [], drivers: [], finders: [] };
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

  // The category list or page, with the devices and rooms the shell has.
  async function show(known: DeviceInfo[] = [], group?: string) {
    await act(async () =>
      root.render(
        <SettingsPage
          page={group ? "device-group" : "devices"}
          params={group ? { id: group } : {}}
          open={(page, params) => opened.push({ page, params })}
          back={() => undefined}
          apps={[zigbee]}
          me={admin}
          core={{ state: "online", version: "1.2.3" } as never}
          live={live}
          devices={{ devices: known, places }}
          home={unknownHome}
          onUpdating={() => undefined}
        />,
      ),
    );
  }

  const rows = () =>
    [...container.querySelectorAll<HTMLButtonElement>("li button")].filter(
      (button) => button.getAttribute("aria-label")?.includes(": "),
    );

  it("lists the categories with their counts, and opens one", async () => {
    devices = [
      light("desk", "Light"),
      light("lamp", "Lamp", { leftAt: "2026-10-29T11:00:00.000Z" }),
      remote,
    ];
    await show();
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Lights: 1 needs attention, 2 devices",
      "Buttons: 1 device",
    ]);
    // What needs attention leads, in red with a sign.
    const lights = rows()[0]!;
    expect(lights.querySelector("span.text-destructive")?.textContent).toBe(
      "1 needs attention",
    );
    expect(lights.querySelector("svg.lucide-circle-alert")).not.toBeNull();
    // The devices themselves are on each category's page.
    expect(container.textContent).not.toContain("Lamp");

    await act(async () => rows()[1]!.click());
    expect(opened).toEqual([
      { page: "device-group", params: { id: "buttons" } },
    ]);
  });

  it("says when the home has no devices yet", async () => {
    devices = [];
    await show();
    expect(container.textContent).toContain("No devices yet.");
    expect(container.textContent).toContain("Add devices");
  });

  it("counts a failed and an available update separately", async () => {
    const firmware = {
      version: "1.0",
      updatable: true,
      sleeps: false,
      progress: null,
      remainingSeconds: null,
      problem: null,
      checkedAt: null,
      startedAt: null,
      endedAt: null,
    };
    devices = [
      light("desk", "Light", { firmware: { ...firmware, state: "failed" } }),
      light("lamp", "Lamp", { firmware: { ...firmware, state: "available" } }),
    ];
    await show();
    expect(rows()[0]?.textContent).toBe(
      "Lights1 needs attention · 1 update · 2 devices",
    );
    expect(rows()[0]?.getAttribute("aria-label")).toBe(
      "Lights: 1 needs attention, 1 update, 2 devices",
    );
  });

  it("draws from the devices the shell has, before its own read answers", async () => {
    let answer!: (devices: DeviceInfo[]) => void;
    devicesReply = new Promise((resolve) => (answer = resolve));
    await show([light("desk", "Light")]);
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Lights: 1 device",
    ]);
    expect(
      vi
        .mocked(coreJson)
        .mock.calls.filter(([path]) => path === "/api/history/devices"),
    ).toHaveLength(1);

    await act(async () => answer([light("desk", "Light"), remote]));
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Lights: 1 device",
      "Buttons: 1 device",
    ]);
  });

  it("shows cached rooms on a category page while the device read is pending", async () => {
    const { promise, resolve } = deferred<DeviceInfo[]>();
    devicesReply = promise;
    const lamp = light("desk", "Light", { roomId: "office" });
    await show([lamp], "lights");
    expect(container.textContent).toContain("Office · Hue Essential");
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Light: more"]',
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const room = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === "Room",
    )!;
    await act(async () =>
      room.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(
      document.querySelector('[role="menuitemradio"][aria-checked="true"]')
        ?.textContent,
    ).toBe("Office");
    await act(async () => resolve([lamp]));
  });
});
