// @vitest-environment jsdom
import type {
  AppInfo,
  CapabilityInfo,
  DeviceInfo,
  OccupancyFeatures,
  OccupancyState,
  Places,
} from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { whyNot } from "../src/device-firmware";
import {
  clearAfterOptions,
  clearAfterWords,
  hasMotionSettings,
} from "../src/motion-settings";
import { SettingsPage } from "../src/settings";
import { unknownHome } from "./home-fixtures";

// A motion sensor's settings in Settings → Devices: its place in the device's
// menu, and the dialog that sends each change at once and says how it went.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const office = { id: "office", name: "Office", floorId: null };
const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [office],
  zones: [],
};

// A Hue motion sensor: three levels, how long it waits, its light.
const hue: OccupancyFeatures = {
  senses: "motion",
  sensitivity: ["low", "medium", "high"],
  clearAfter: { min: 0, max: 65_535 },
  indicator: true,
};

function occupancy(
  observed: OccupancyState,
  extra: Partial<Extract<CapabilityInfo, { kind: "occupancy" }>> = {},
  features: OccupancyFeatures = hue,
) {
  return {
    id: "occupancy",
    kind: "occupancy",
    features,
    state: observed,
    observed,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
    ...extra,
  } satisfies CapabilityInfo;
}

const settled: OccupancyState = {
  occupied: false,
  sensitivity: "medium",
  clearAfter: 60,
  indicator: true,
};

function sensor(
  capability: CapabilityInfo = occupancy(settled),
  extra: Partial<DeviceInfo> = {},
): DeviceInfo {
  return {
    id: "motion",
    name: "Office motion sensor",
    driverName: "Hue motion sensor",
    type: "motion",
    driver: "sanctum.zigbee",
    manufacturer: "Philips",
    model: "SML001",
    roomId: "office",
    availability: "online",
    lastSeenAt: null,
    firmware: { version: "2.53.6", updatable: true, sleeps: true } as never,
    probe: false,
    battery: 87,
    leftAt: null,
    problem: null,
    capabilities: [
      capability,
      {
        id: "illuminance",
        kind: "sensor",
        features: { measures: "illuminance" },
        state: { value: 320 },
        observed: { value: 320 },
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ],
    ...extra,
  };
}

const lamp: DeviceInfo = {
  ...sensor(),
  id: "lamp",
  name: "Office light",
  driverName: "Hue White and Color Ambiance",
  type: "light",
  probe: true,
  battery: null,
  leftAt: null,
  capabilities: [
    {
      id: "light",
      kind: "light",
      features: { brightness: true, colorTemperature: null, color: false },
      state: { on: true },
      observed: { on: true },
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};

describe("a motion sensor's settings' words", () => {
  it("say how long it waits, and offer the usual lengths within its range", () => {
    expect(clearAfterWords(10)).toBe("10 seconds");
    expect(clearAfterWords(60)).toBe("1 minute");
    expect(clearAfterWords(90)).toBe("90 seconds");
    expect(clearAfterWords(1800)).toBe("30 minutes");
    expect(clearAfterOptions({ min: 0, max: 65_535 }, 60)).toEqual([
      10, 30, 60, 120, 300, 600, 900, 1800,
    ]);
    // One a minute at least, with the one it has, not a usual one.
    expect(clearAfterOptions({ min: 60, max: 65_535 }, 90)).toEqual([
      60, 90, 120, 300, 600, 900, 1800,
    ]);
  });

  it("know a sensor with none to change, and that it sleeps between readings", () => {
    expect(hasMotionSettings(hue)).toBe(true);
    expect(
      hasMotionSettings({
        senses: "motion",
        sensitivity: null,
        clearAfter: null,
        indicator: false,
      }),
    ).toBe(false);
    expect(whyNot(sensor(), "probe")).toBe("It sleeps between readings");
  });
});

describe("Settings → Devices' motion settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  let devices: DeviceInfo[];
  let requests: { path: string; json?: unknown }[];
  let answers: Record<string, () => unknown>;
  const live = createLiveFeed();
  const zigbee: AppInfo = {
    id: "sanctum.zigbee",
    name: "Zigbee",
    version: "0.3.0",
    icon: { glyph: "radio-tower", color: "graphite" },
    pages: ["main"],
    permissions: ["devices.register"],
    requests: [],
    state: "running",
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  };
  const me = {
    client: {
      id: "macbook",
      name: "Maya's MacBook",
      kind: "personal",
      platform: "macos",
      personId: "maya",
      createdAt: "2026-10-26T12:00:00Z",
      lastSeenAt: "2026-10-28T11:59:30Z",
      current: true,
    },
    person: { id: "maya", name: "Maya", avatar: null, colour: "#c5cdac" },
  } as Me;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    devices = [sensor(), lamp];
    requests = [];
    answers = {};
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      requests.push({ path, json: init.json });
      if (answers[path]) return answers[path]();
      if (path.startsWith("/api/activity?"))
        return { entries: [], more: false };
      switch (path) {
        case "/api/devices":
          return devices;
        case "/api/places":
          return places;
        case "/api/places/home":
          return { name: "Home", timeZone: null, coordinates: null };
        case "/api/history/devices":
          return devices.map((each) => ({ device: each.id, kept: true }));
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
    vi.unstubAllGlobals();
  });

  async function show() {
    await act(async () =>
      root.render(
        <SettingsPage
          page="main"
          params={{}}
          open={() => undefined}
          back={() => undefined}
          apps={[zigbee]}
          me={me}
          core={{ state: "online", version: "1.2.3" } as never}
          live={live}
          devices={{ devices: [], places: undefined }}
          home={unknownHome}
          onUpdating={() => undefined}
        />,
      ),
    );
  }

  async function openMenu(menu: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${menu}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    return [
      ...document.querySelectorAll<HTMLElement>(
        "[role=menuitem], [role=menuitemcheckbox]",
      ),
    ];
  }

  async function openSettings() {
    const item = (await openMenu("Office motion sensor: more")).find((each) =>
      each.textContent?.startsWith("Motion settings"),
    )!;
    await act(async () => item.click());
    return document.querySelector<HTMLElement>("[role=dialog]")!;
  }

  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")!;
  const inDialog = (name: string) =>
    [...dialog().querySelectorAll("button")].find(
      (each) => each.textContent === name,
    )!;
  const announced = () =>
    dialog().querySelector("[role=status]")!.textContent ?? "";
  const pressed = () =>
    [...dialog().querySelectorAll("[data-state=on]")].map(
      (each) => each.textContent,
    );
  const update = (capability: CapabilityInfo) =>
    act(async () =>
      live.publish({
        type: "device",
        id: "motion",
        device: sensor(capability),
      }),
    );
  // What the core answers a command with: the asked-for setting pending.
  const pendingAnswer = (asked: Partial<OccupancyState>) =>
    occupancy(settled, {
      state: { ...settled, ...asked },
      desired: asked,
      sync: "pending",
    });

  it("is in a motion sensor's menu after Keep history, and in no one else's", async () => {
    await show();
    expect(container.querySelector("li svg.lucide-footprints")).not.toBeNull();

    const items = (await openMenu("Office motion sensor: more")).map(
      (each) => each.textContent,
    );
    expect(items.indexOf("Motion settings")).toBe(
      items.indexOf("Keep history") + 1,
    );
    expect(items[items.indexOf("Motion settings") + 1]).toBe(
      "Check for update",
    );
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(
      (await openMenu("Office light: more")).some((each) =>
        each.textContent?.startsWith("Motion settings"),
      ),
    ).toBe(false);
  });

  it("dims it, with why, for a sensor with none to change", async () => {
    devices = [
      sensor(
        occupancy(
          { occupied: false },
          {},
          {
            senses: "motion",
            sensitivity: null,
            clearAfter: null,
            indicator: false,
          },
        ),
        { name: "Office motion sensor", driverName: "VALLHORN" },
      ),
    ];
    await show();
    const item = (await openMenu("Office motion sensor: more")).find((each) =>
      each.textContent?.startsWith("Motion settings"),
    )!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("It has none to change");
  });

  it("shows the settings it has, as it reports them", async () => {
    await show();
    const settings = await openSettings();
    expect(settings.textContent).toContain("Motion settings");
    expect(settings.textContent).toContain(
      "Office motion sensor. Each change is sent to it at once.",
    );
    expect(
      [
        ...settings.querySelectorAll(
          "[role=group] button, [role=radiogroup] button",
        ),
      ].map((each) => each.textContent),
    ).toEqual(["Low", "Medium", "High"]);
    expect(pressed()).toEqual(["Medium"]);
    expect(inDialog("1 minute")).toBeDefined();
    expect(
      settings.querySelector("[role=switch]")!.getAttribute("aria-checked"),
    ).toBe("true");
    expect(settings.textContent).toContain(
      "Higher notices smaller movements, from further away, and pets too.",
    );
  });

  it("sends a change at once, waits for a sleeping sensor, and says once it took it", async () => {
    answers["/api/devices/command"] = () =>
      pendingAnswer({ sensitivity: "high" });
    await show();
    await openSettings();

    await act(async () => inDialog("High").click());
    expect(requests.at(-1)).toEqual({
      path: "/api/devices/command",
      json: {
        device: "motion",
        capability: "occupancy",
        command: { sensitivity: "high" },
      },
    });
    expect(pressed()).toEqual(["High"]);
    expect(dialog().textContent).toContain(
      "Waiting for it to wake. Press its button to send it now.",
    );
    expect(announced()).toBe(
      "Waiting for it to wake. Press its button to send it now.",
    );

    await update(occupancy({ ...settled, sensitivity: "high" }));
    expect(dialog().textContent).not.toContain("Waiting for it to wake");
    expect(dialog().textContent).toContain("Higher notices smaller movements");
    expect(pressed()).toEqual(["High"]);
    expect(announced()).toBe("Sensitivity set to High.");
  });

  it("puts a change it didn't take back on what it says, in red, with Try again", async () => {
    answers["/api/devices/command"] = () =>
      pendingAnswer({ sensitivity: "high" });
    await show();
    await openSettings();
    await act(async () => inDialog("High").click());

    await update(occupancy(settled, { sync: "conflict" }));
    const conflict =
      "It didn't take High, so it stays on Medium. Press its button, then try again.";
    expect(dialog().textContent).toContain(conflict);
    expect(dialog().querySelector(".text-destructive")!.textContent).toContain(
      conflict,
    );
    expect(pressed()).toEqual(["Medium"]);
    expect(announced()).toBe(conflict);

    await act(async () => inDialog("Try again").click());
    expect(requests.at(-1)?.json).toEqual({
      device: "motion",
      capability: "occupancy",
      command: { sensitivity: "high" },
    });
    expect(dialog().textContent).toContain("Waiting for it to wake");
  });

  it.each([false, true])(
    "ignores an older failed change after another choice (reopened: %s)",
    async (reopen) => {
      let rejectFirst!: (reason: unknown) => void;
      answers["/api/devices/command"] = () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        });
      await show();
      await openSettings();
      await act(async () => inDialog("High").click());

      if (reopen) {
        await act(async () => inDialog("Done").click());
        await openSettings();
      }
      answers["/api/devices/command"] = () =>
        pendingAnswer({ sensitivity: "low" });
      await act(async () => inDialog("Low").click());
      await act(async () => rejectFirst(new CoreError(503, "unavailable")));
      expect(pressed()).toEqual(["Low"]);
      expect(dialog().textContent).not.toContain("Zigbee isn't running.");
      expect(dialog().textContent).toContain("Waiting for it to wake");
    },
  );

  it("keeps the latest choice when an older command answer arrives last", async () => {
    let finishFirst!: (value: CapabilityInfo) => void;
    answers["/api/devices/command"] = () =>
      new Promise<CapabilityInfo>((resolve) => {
        finishFirst = resolve;
      });
    await show();
    await openSettings();
    await act(async () => inDialog("High").click());
    answers["/api/devices/command"] = () =>
      occupancy({ ...settled, sensitivity: "low" });
    await act(async () => inDialog("Low").click());
    await act(async () => finishFirst(pendingAnswer({ sensitivity: "high" })));
    expect(pressed()).toEqual(["Low"]);
    expect(dialog().textContent).not.toContain("It didn't take");
  });

  it("says when a change couldn't be sent", async () => {
    answers["/api/devices/command"] = () => {
      throw new CoreError(503, "unavailable");
    };
    await show();
    await openSettings();
    await act(async () =>
      dialog().querySelector<HTMLElement>("[role=switch]")!.click(),
    );
    expect(requests.at(-1)?.json).toMatchObject({
      command: { indicator: false },
    });
    expect(dialog().textContent).toContain("Zigbee isn't running.");
    expect(announced()).toBe("Zigbee isn't running.");
    expect(
      dialog().querySelector("[role=switch]")!.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("offers only what a sensor has, within its range", async () => {
    answers["/api/devices/command"] = () => pendingAnswer({ clearAfter: 120 });
    devices = [
      sensor(
        occupancy(
          { occupied: false, clearAfter: 90 },
          {},
          {
            senses: "motion",
            sensitivity: null,
            clearAfter: { min: 60, max: 65_535 },
            indicator: false,
          },
        ),
        { driverName: "Aqara motion sensor" },
      ),
    ];
    await show();
    const settings = await openSettings();
    expect(settings.textContent).toContain(
      "Office motion sensor. Each change is sent to it at once.",
    );
    expect(settings.textContent).not.toContain("Sensitivity");
    expect(settings.textContent).not.toContain("Blink on motion");
    expect(settings.textContent).toContain(
      "It can't say no motion sooner than 1 minute.",
    );

    const choice = inDialog("90 seconds");
    await act(async () =>
      choice.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const options = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitemradio]"),
    ];
    expect(options.map((each) => each.textContent)).toEqual([
      "1 minute",
      "90 seconds",
      "2 minutes",
      "5 minutes",
      "10 minutes",
      "15 minutes",
      "30 minutes",
    ]);
    await act(async () =>
      options.find((each) => each.textContent === "2 minutes")!.click(),
    );
    expect(requests.at(-1)?.json).toMatchObject({
      command: { clearAfter: 120 },
    });
    expect(inDialog("2 minutes")).toBeDefined();

    await act(async () => inDialog("Done").click());
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
