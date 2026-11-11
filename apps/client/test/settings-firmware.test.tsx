// @vitest-environment jsdom
import type {
  AppInfo,
  DeviceInfo,
  FirmwareInfo,
  Places,
} from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import {
  answeredIn,
  firmwareStatus,
  timeLeft,
  updateButton,
  updatesHint,
  whyNot,
} from "../src/device-firmware";
import { SettingsPage } from "../src/settings";
import { unknownHome } from "./home-fixtures";

// Firmware updates and Check connection in Settings → Devices: what a
// device's line says, the dialog that asks before an update, and the checks in
// its menu.

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
const now = Date.parse("2026-10-30T12:00:00Z");

function firmware(extra: Partial<FirmwareInfo> = {}): FirmwareInfo {
  return {
    version: "1.126.9",
    updatable: true,
    sleeps: false,
    state: null,
    progress: null,
    remainingSeconds: null,
    problem: null,
    checkedAt: null,
    startedAt: null,
    endedAt: null,
    ...extra,
  };
}

function light(id: string, name: string, extra: Partial<DeviceInfo> = {}) {
  return {
    id,
    name,
    driverName: "Hue Essential White and Color Ambiance A60",
    driver: "sanctum.zigbee",
    manufacturer: "Philips",
    model: "LCA016",
    roomId: "office",
    availability: "online",
    lastSeenAt: null,
    firmware: firmware(),
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
    ...extra,
  } satisfies DeviceInfo;
}

// The office's Aqara mini switch: its firmware cannot be updated, and it
// sleeps between presses.
const button = {
  ...light("button", "Office button", {
    firmware: firmware({ version: null, updatable: false, sleeps: true }),
    probe: false,
    battery: null,
    leftAt: null,
  }),
  driverName: "Wireless mini switch",
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

describe("a device's line", () => {
  const available = light("office", "Office light", {
    firmware: firmware({ state: "available" }),
  });

  it("starts with an update's state", () => {
    expect(firmwareStatus(available, [available], undefined, now)).toEqual({
      text: "Update available",
      tone: "plain",
    });
    const updating = light("office", "Office light", {
      firmware: firmware({
        state: "updating",
        progress: 34.6,
        remainingSeconds: 3000,
      }),
    });
    expect(firmwareStatus(updating, [updating], undefined, now)).toEqual({
      text: "Updating · 34% · about 50 minutes left",
      tone: "plain",
      progress: 34.6,
    });
    expect(
      firmwareStatus(
        light("a", "A", { firmware: firmware({ state: "updating" }) }),
        [],
        undefined,
        now,
      ),
    ).toMatchObject({ text: "Updating · starting", progress: 0 });
    expect(
      firmwareStatus(
        light("a", "A", { firmware: firmware({ state: "waiting" }) }),
        [],
        undefined,
        now,
      ),
    ).toMatchObject({ text: "Updates when it wakes" });
    expect(
      firmwareStatus(
        light("a", "A", {
          firmware: firmware({
            state: "failed",
            problem: "It stopped answering.",
          }),
        }),
        [],
        undefined,
        now,
      ),
    ).toEqual({
      text: "The update didn't finish: it stopped answering.",
      tone: "problem",
    });
  });

  it("says an update waits for another device's to finish", () => {
    const updating = light("desk", "Desk lamp", {
      firmware: firmware({ state: "updating", progress: 10 }),
    });
    expect(
      firmwareStatus(available, [available, updating], undefined, now),
    ).toMatchObject({
      text: "Update available once Desk lamp has finished",
    });
    expect(updateButton(available, [available, updating])).toEqual({
      label: "Update",
      disabled: true,
    });
    expect(updateButton(available, [available])).toEqual({
      label: "Update",
      disabled: false,
    });
  });

  it("says a device was updated, for a day", () => {
    const updated = (endedAt: string) =>
      light("a", "A", {
        firmware: firmware({
          state: "current",
          startedAt: "2026-10-30T10:00:00Z",
          endedAt,
          checkedAt: endedAt,
        }),
      });
    expect(
      firmwareStatus(updated("2026-10-30T11:59:40Z"), [], undefined, now),
    ).toEqual({ text: "Updated just now", tone: "done" });
    expect(
      firmwareStatus(updated("2026-10-30T09:00:00Z"), [], undefined, now)?.text,
    ).toBe("Updated 3 hours ago");
    expect(
      firmwareStatus(updated("2026-10-29T09:00:00Z"), [], undefined, now),
    ).toBeNull();
  });

  it("says what a check from here found, until the next one", () => {
    const current = light("a", "A", {
      firmware: firmware({
        state: "current",
        checkedAt: "2026-10-30T11:59:59Z",
      }),
    });
    expect(
      firmwareStatus(current, [], { kind: "checking" }, now),
    ).toMatchObject({ text: "Checking for an update…", tone: "busy" });
    expect(firmwareStatus(current, [], { kind: "checked" }, now)).toEqual({
      text: "Up to date, checked just now",
      tone: "plain",
    });
    expect(firmwareStatus(current, [], undefined, now)).toBeNull();
    expect(
      firmwareStatus(current, [], { kind: "probed", answeredInMs: 180 }, now),
    ).toEqual({ text: "Connected, answered in 0.2 seconds", tone: "plain" });
    expect(
      firmwareStatus(current, [], { kind: "probed", answeredInMs: null }, now),
    ).toEqual({
      text: "No connection: it didn't answer. Check it's switched on and in range.",
      tone: "problem",
    });
  });

  it("answers a check where it was asked, even while it updates", () => {
    const updating = light("a", "A", {
      firmware: firmware({
        state: "updating",
        progress: 40,
        remainingSeconds: 1800,
      }),
    });
    expect(
      firmwareStatus(updating, [], { kind: "probed", answeredInMs: 200 }, now),
    ).toEqual({
      text: "Connected, answered in 0.2 seconds",
      tone: "plain",
      then: "Updating · 40% · about 30 minutes left",
      progress: 40,
    });
  });

  it("puts the words in order", () => {
    expect(timeLeft(20)).toBe("less than a minute left");
    expect(timeLeft(60)).toBe("about 1 minute left");
    expect(timeLeft(80 * 60)).toBe("about 80 minutes left");
    expect(timeLeft(3 * 3600)).toBe("about 3 hours left");
    expect(answeredIn(40)).toBe("0.1 seconds");
    expect(answeredIn(1000)).toBe("1 second");
    expect(answeredIn(2345)).toBe("2.3 seconds");
  });

  it("counts the updates to start, and says why a check cannot run", () => {
    const failed = light("b", "B", {
      firmware: firmware({ state: "failed" }),
    });
    expect(updatesHint([available, failed, button])).toBe("2 updates");
    expect(updatesHint([button])).toBeUndefined();
    expect(whyNot(button, "update")).toBe("No updates are offered for it");
    expect(whyNot(button, "probe")).toBe("It sleeps between presses");
    // A sensor on a battery, before it has said how full it is.
    const sensor = {
      ...button,
      capabilities: [
        {
          id: "temperature",
          kind: "sensor" as const,
          features: { measures: "temperature" as const },
          state: { value: 21.5 },
          observed: { value: 21.5 },
          desired: null,
          sync: "synced" as const,
          setBy: null,
          changedAt: null,
        },
      ],
    };
    expect(whyNot(sensor, "probe")).toBe("It sleeps between readings");
    expect(whyNot(available, "update")).toBeNull();
    expect(whyNot(available, "probe")).toBeNull();
  });
});

describe("Settings → Devices' firmware", () => {
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
  const admin = {
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
    person: {
      id: "maya",
      name: "Maya",
      avatar: null,
      colour: "#c5cdac",
    },
  } as Me;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(now));
    devices = [
      button,
      light("office", "Office light", {
        firmware: firmware({ state: "available" }),
      }),
    ];
    requests = [];
    answers = {};
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      requests.push({ path, json: init.json });
      if (answers[path]) return answers[path]();
      // Settings shows the activity log's newest entries too.
      if (path.startsWith("/api/activity?"))
        return { entries: [], more: false };
      switch (path) {
        case "/api/devices":
          return devices;
        case "/api/places":
          return places;
        case "/api/places/home":
          return { name: "Home", timeZone: null, coordinates: null };
        case "/api/auth/clients":
        case "/api/people":
        case "/api/entities":
        case "/api/history/devices":
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

  async function show() {
    await act(async () =>
      root.render(
        <SettingsPage
          page="main"
          params={{}}
          open={() => undefined}
          back={() => undefined}
          apps={[zigbee]}
          me={admin}
          core={{ state: "online", version: "1.2.3" } as never}
          live={live}
          devices={{ devices: [], places: undefined }}
          home={unknownHome}
          onUpdating={() => undefined}
        />,
      ),
    );
  }

  function buttonNamed(name: string) {
    const scope = document.querySelector("[role=dialog]") ?? document;
    return [...scope.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
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
    return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
  }

  async function choose(menu: string, item: string) {
    const found = (await openMenu(menu)).find((candidate) =>
      candidate.textContent?.startsWith(item),
    )!;
    await act(async () => found.click());
  }

  // The last request to a path: other parts of Settings ask too.
  const lastRequest = (path: string) =>
    requests.filter((each) => each.path === path).at(-1);

  const lineOf = (name: string) =>
    [...container.querySelectorAll("li")].find((item) =>
      item.textContent?.includes(name),
    )!.textContent;

  it("says an update is available, and asks before starting it", async () => {
    await show();
    expect(container.textContent).toContain("Devices1 update");
    expect(lineOf("Office light")).toContain(
      "Update available · Office · Hue Essential",
    );

    await act(async () => buttonNamed("Update").click());
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Update Office light?");
    expect(dialog.textContent).toContain("it can take an hour or more");
    expect(dialog.textContent).toContain("it keeps its current firmware");
    expect(requests.map((each) => each.path)).not.toContain(
      "/api/devices/firmware/update",
    );

    answers["/api/devices/firmware/update"] = () =>
      light("office", "Office light", {
        firmware: firmware({ state: "updating", progress: 0 }),
      });
    await act(async () => buttonNamed("Update").click());

    expect(lastRequest("/api/devices/firmware/update")).toEqual({
      path: "/api/devices/firmware/update",
      json: { id: "office" },
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(lineOf("Office light")).toContain("Updating · starting · Office");
    expect(
      container.querySelector('[aria-label="Office light\'s update"]'),
    ).not.toBeNull();
  });

  it("follows an update live until it ends, and announces how", async () => {
    await show();
    const updating = (progress: number) =>
      light("office", "Office light", {
        firmware: firmware({
          state: "updating",
          progress,
          remainingSeconds: 3000,
          startedAt: "2026-10-30T11:00:00Z",
        }),
      });
    await act(async () =>
      live.publish({ type: "device", id: "office", device: updating(34) }),
    );
    expect(lineOf("Office light")).toContain(
      "Updating · 34% · about 50 minutes left",
    );
    // Stopping is in its menu, not where Update was.
    expect(buttonNamed("Stop update")).toBeUndefined();
    expect(
      (await openMenu("Office light: more")).map((item) => item.textContent),
    ).toContain("Stop update");
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    await act(async () =>
      live.publish({
        type: "device",
        id: "office",
        device: light("office", "Office light", {
          firmware: firmware({
            state: "current",
            startedAt: "2026-10-30T11:00:00Z",
            endedAt: "2026-10-30T11:59:50Z",
            checkedAt: "2026-10-30T11:59:50Z",
          }),
        }),
      }),
    );
    expect(lineOf("Office light")).toContain("Updated just now · Office");
    expect(container.querySelector("[role=status]")!.textContent).toBe(
      "Office light is updated.",
    );
  });

  it.each(["updating", "waiting"] as const)(
    "puts how a %s update ended in place of an earlier check",
    async (state) => {
      answers["/api/devices/probe"] = () => ({ answeredInMs: 200 });
      devices[1] = light("office", "Office light", {
        firmware: firmware({
          state,
          progress: state === "updating" ? 50 : null,
        }),
      });
      await show();
      await choose("Office light: more", "Check connection");
      expect(lineOf("Office light")).toContain(
        `Connected, answered in 0.2 seconds · ${state === "updating" ? "Updating · 50%" : "Updates when it wakes"}`,
      );

      await act(async () =>
        live.publish({
          type: "device",
          id: "office",
          device: light("office", "Office light", {
            firmware: firmware({
              state: "failed",
              problem: "It stopped answering.",
            }),
          }),
        }),
      );

      expect(lineOf("Office light")).toContain(
        "The update didn't finish: it stopped answering.",
      );
      expect(buttonNamed("Try again")).toBeDefined();
    },
  );

  it("clears an earlier check once an update starts", async () => {
    answers["/api/devices/probe"] = () => ({ answeredInMs: 200 });
    answers["/api/devices/firmware/update"] = () =>
      light("office", "Office light", {
        firmware: firmware({ state: "updating", progress: 0 }),
      });
    await show();
    await choose("Office light: more", "Check connection");
    await act(async () => buttonNamed("Update").click());
    await act(async () => buttonNamed("Update").click());

    expect(lineOf("Office light")).toContain("Updating · starting · Office");
    expect(lineOf("Office light")).not.toContain("Connected");
  });

  it("keeps newer live firmware when the start response arrives late", async () => {
    let finish!: (device: DeviceInfo) => void;
    answers["/api/devices/firmware/update"] = () =>
      new Promise<DeviceInfo>((resolve) => {
        finish = resolve;
      });
    await show();
    await act(async () => buttonNamed("Update").click());
    await act(async () => buttonNamed("Update").click());
    const started = light("office", "Office light", {
      firmware: firmware({ state: "updating", progress: 0 }),
    });
    await act(async () =>
      live.publish({ type: "device", id: "office", device: started }),
    );
    await act(async () =>
      live.publish({
        type: "device",
        id: "office",
        device: light("office", "Office light", {
          firmware: firmware({
            state: "failed",
            problem: "It stopped answering.",
          }),
        }),
      }),
    );
    await act(async () => finish(started));

    expect(lineOf("Office light")).toContain(
      "The update didn't finish: it stopped answering.",
    );
    expect(buttonNamed("Try again")).toBeDefined();
  });

  it("does not announce a failed update as up to date after checking again", async () => {
    devices[1] = light("office", "Office light", {
      firmware: firmware({ state: "failed", problem: "It stopped answering." }),
    });
    answers["/api/devices/firmware/check"] = () => devices[1];
    await show();
    await choose("Office light: more", "Check for update");

    expect(container.querySelector("[role=status]")!.textContent).toBe(
      "An update is available for Office light.",
    );
  });

  it("checks for an update and the connection from a device's menu", async () => {
    devices[1] = light("office", "Office light");
    answers["/api/devices/firmware/check"] = () =>
      light("office", "Office light", {
        firmware: firmware({
          state: "current",
          checkedAt: "2026-10-30T12:00:00Z",
        }),
      });
    answers["/api/devices/probe"] = () => ({ answeredInMs: 210 });
    await show();

    await choose("Office light: more", "Check for update");
    expect(lastRequest("/api/devices/firmware/check")).toEqual({
      path: "/api/devices/firmware/check",
      json: { id: "office" },
    });
    expect(lineOf("Office light")).toContain("Up to date, checked just now");

    await choose("Office light: more", "Check connection");
    expect(lastRequest("/api/devices/probe")).toEqual({
      path: "/api/devices/probe",
      json: { id: "office" },
    });
    expect(lineOf("Office light")).toContain(
      "Connected, answered in 0.2 seconds",
    );
  });

  it("says when a check fails, next to the device", async () => {
    answers["/api/devices/probe"] = () => ({ answeredInMs: null });
    answers["/api/devices/firmware/check"] = () => {
      throw new CoreError(500, "app_failed");
    };
    await show();

    await choose("Office light: more", "Check connection");
    expect(lineOf("Office light")).toContain(
      "No connection: it didn't answer. Check it's switched on and in range.",
    );
    await choose("Office light: more", "Check for update");
    expect(lineOf("Office light")).toContain(
      "Couldn't check for an update: it didn't answer. Check it's switched on.",
    );
  });

  it("dims the checks a device cannot have, with why", async () => {
    await show();

    const items = await openMenu("Office button: more");
    const named = (label: string) =>
      items.find((item) => item.textContent?.startsWith(label))!;

    expect(named("Check for update").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(named("Check for update").textContent).toContain(
      "No updates are offered for it",
    );
    expect(named("Check connection").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(named("Check connection").textContent).toContain(
      "It sleeps between presses",
    );
    expect(document.body.textContent).not.toContain("Firmware ");
  });

  it("shows the firmware a device runs in its menu", async () => {
    await show();

    await openMenu("Office light: more");

    expect(document.body.textContent).toContain("Firmware 1.126.9");
  });
});
