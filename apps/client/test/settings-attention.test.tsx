// @vitest-environment jsdom
import type { AppInfo, DeviceInfo, Room } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { NeedsAttentionSection } from "../src/settings-attention";

// Settings' Needs attention: every device that needs someone, the most
// pressing first, each with its fix in its row, and a row fixed from here kept
// with a check until Settings closes.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const rooms: Room[] = [
  { id: "office", name: "Office", floorId: null },
  { id: "hall", name: "Hall", floorId: null },
];
const zigbee: AppInfo = {
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

function device(id: string, name: string, extra: Partial<DeviceInfo> = {}) {
  return {
    id,
    name,
    driverName: name,
    type: "unknown",
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId: "office",
    availability: "online",
    lastSeenAt: null,
    firmware: null,
    probe: true,
    battery: null,
    leftAt: null,
    problem: null,
    capabilities: [],
    ...extra,
  } satisfies DeviceInfo;
}

const plug = device("plug", "Hall plug", {
  roomId: "hall",
  driverName: "TRADFRI control outlet",
  availability: "offline",
  leftAt: "2026-10-31T12:00:00.000Z",
});
const lamp = device("lamp", "Office lamp", {
  driverName: "Hue White ambiance",
  availability: "offline",
});
// A low battery is upkeep, not something that needs attention.
const sensor = device("sensor", "Hall sensor", {
  roomId: "hall",
  probe: false,
  battery: 8,
});
// One that can't be asked how it is.
const heater = device("heater", "Hall heater", {
  roomId: "hall",
  probe: false,
  availability: "offline",
});
const button = device("button", "Button", {
  roomId: null,
  probe: false,
  driverName: "Aqara wireless mini switch",
});
const desk = device("desk", "Desk light");

let container: HTMLDivElement;
let root: Root;
let devices: DeviceInfo[];
const requests: { path: string; json: unknown }[] = [];
let answer: (path: string, json: unknown) => unknown;

beforeEach(() => {
  requests.length = 0;
  answer = () => ({});
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    requests.push({ path, json: init.json });
    return answer(path, init.json) as never;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function show(next: DeviceInfo[]) {
  devices = next;
  await act(async () =>
    root.render(
      <NeedsAttentionSection devices={devices} rooms={rooms} apps={[zigbee]} />,
    ),
  );
}

const rows = () =>
  [...container.querySelectorAll("li")].map((each) => each.textContent);
const rowOf = (name: string) =>
  [...container.querySelectorAll("li")].find((each) =>
    each.textContent?.startsWith(name),
  )!;
const buttonIn = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find(
    (each) => each.textContent === name,
  )!;
const status = () =>
  container.querySelector("[role=status]")?.textContent ?? "";

describe("Needs attention", () => {
  it("lists each app that isn't running before the devices, with where to fix it", async () => {
    const moods = {
      ...zigbee,
      id: "sanctum.moods",
      name: "Moods",
      icon: { glyph: "sparkles", color: "ember" },
      requests: [
        {
          id: "devices.control:light",
          reason: "To set them.",
          needed: true,
          asked: null,
          startsOn: false,
        },
      ],
      permissions: [],
      state: "paused",
    } satisfies AppInfo;
    const opened: string[] = [];
    await act(async () =>
      root.render(
        <NeedsAttentionSection
          devices={[lamp]}
          rooms={rooms}
          apps={[zigbee, moods, { ...zigbee, state: "stopped" }]}
          onOpenStatus={() => opened.push("status")}
          onOpenApp={(id) => opened.push(id)}
        />,
      ),
    );

    expect(container.textContent).toContain("2 apps and 1 device");
    expect(rows()).toEqual([
      "ZigbeeNot running: restart Sanctum to start itOpen Status",
      "MoodsPaused: it needs “Control your lights”Open settings",
      "Office lampOffline: check it's switched on and in range · Office · Hue White ambianceCheck connection",
    ]);
    // A stopped app is a problem; a paused one is not.
    expect(rowOf("Zigbee").querySelector(".text-destructive")).not.toBeNull();
    expect(rowOf("Moods").querySelector(".text-destructive")).toBeNull();

    await act(async () => buttonIn(rowOf("Zigbee"), "Open Status").click());
    await act(async () => buttonIn(rowOf("Moods"), "Open settings").click());
    expect(opened).toEqual(["status", "sanctum.moods"]);
  });

  it("lists what needs someone, the most pressing first, each with its fix", async () => {
    await show([desk, sensor, heater, button, lamp, plug]);

    expect(container.querySelector("h2")?.textContent).toBe("Needs attention");
    expect(container.textContent).toContain("4 devices");
    expect(rows()).toEqual([
      "Hall plugNot paired any more: add it again or remove it · Hall · TRADFRI control outletRemove",
      "Hall heaterOffline: check it's switched on and in range · Hall",
      "Office lampOffline: check it's switched on and in range · Office · Hue White ambianceCheck connection",
      "ButtonNo room yet: choose one · Aqara wireless mini switchChoose a room",
    ]);
  });

  it("shows nothing while every device is fine, and asks for rooms only once the home has them", async () => {
    await show([desk]);
    expect(container.innerHTML).toBe("");

    await act(async () =>
      root.render(
        <NeedsAttentionSection devices={[button]} rooms={[]} apps={[zigbee]} />,
      ),
    );
    expect(container.innerHTML).toBe("");
  });

  it("puts a fix after a reason that has none", async () => {
    await show([{ ...heater, roomId: null }]);
    expect(rows()).toEqual([
      "Hall heaterOffline: check it's switched on and in range · No room yetChoose a room",
    ]);
  });

  it("checks the connection, says when it didn't answer, and keeps the row checked once it does", async () => {
    let answeredInMs: number | null = null;
    answer = (path) =>
      path === "/api/devices/probe" ? { answeredInMs } : ({} as never);
    await show([lamp]);

    await act(async () =>
      buttonIn(rowOf("Office lamp"), "Check connection").click(),
    );
    expect(requests.at(-1)).toEqual({
      path: "/api/devices/probe",
      json: { id: "lamp" },
    });
    expect(rowOf("Office lamp").textContent).toContain(
      "No connection: it didn't answer. Check it's switched on and in range.",
    );
    expect(status()).toBe("Office lamp didn't answer.");

    answeredInMs = 180;
    await act(async () =>
      buttonIn(rowOf("Office lamp"), "Check again").click(),
    );
    // The device answers, so it is online again.
    await show([{ ...lamp, availability: "online" }]);
    expect(rows()).toEqual([
      "Office lampConnected, answered in 0.2 seconds · Office · Hue White ambiance",
    ]);
    expect(status()).toBe("Office lamp is connected.");
    expect(container.textContent).not.toContain("1 device");
  });

  it("moves a device to the room chosen, and says so where it was asked", async () => {
    answer = (path, json) =>
      path === "/api/devices/update"
        ? { ...button, ...(json as object), name: "Hall button" }
        : {};
    await show([button]);

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Button: room"]',
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const hall = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitemradio]"),
    ].find((each) => each.textContent === "Hall")!;
    await act(async () => hall.click());

    expect(requests.at(-1)).toEqual({
      path: "/api/devices/update",
      json: { id: "button", roomId: "hall" },
    });
    // The core names it after its room, and the live feed brings it.
    await show([{ ...button, roomId: "hall", name: "Hall button" }]);
    expect(rows()).toEqual([
      "Hall buttonMoved to Hall · Aqara wireless mini switch",
    ]);
    expect(status()).toBe("Hall button is in Hall now.");
  });

  it("keeps a room fix in place through the live rename and a delayed response", async () => {
    let finish!: (value: DeviceInfo) => void;
    answer = () =>
      new Promise<DeviceInfo>((resolve) => {
        finish = resolve;
      });
    const other = device("other", "Desk button", { roomId: null });
    await show([button, other]);

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Button: room"]',
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const hall = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitemradio]"),
    ].find((each) => each.textContent === "Hall")!;
    await act(async () => hall.click());

    const moved = { ...button, roomId: "hall", name: "Hall button" };
    await show([moved, other]);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain("Hall button");

    await act(async () => finish(moved));
    expect(rows()[0]).toContain("Hall buttonMoved to Hall");
    expect(rows()[1]).toContain("Desk buttonNo room yet");
    expect(status()).toBe("Hall button is in Hall now.");
  });

  it("keeps a connection check visible when its live update arrives before its response", async () => {
    let finish!: (value: { answeredInMs: number }) => void;
    answer = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await show([lamp]);
    await act(async () =>
      buttonIn(rowOf("Office lamp"), "Check connection").click(),
    );

    await show([{ ...lamp, availability: "online" }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("Checking connection…");

    await act(async () => finish({ answeredInMs: 180 }));
    expect(rows()[0]).toContain("Connected, answered in 0.2 seconds");
  });

  it("answers a check that leaves only a room to choose, keeping the room menu", async () => {
    answer = (path) =>
      path === "/api/devices/probe" ? { answeredInMs: 180 } : ({} as never);
    const roomless = { ...lamp, roomId: null };
    await show([roomless]);

    await act(async () =>
      buttonIn(rowOf("Office lamp"), "Check connection").click(),
    );
    await show([{ ...roomless, availability: "online" }]);
    expect(rows()).toEqual([
      "Office lampConnected, answered in 0.2 seconds · No room yet · Hue White ambianceChoose a room",
    ]);
    expect(container.textContent).toContain("1 device");

    // Offline again, it says so again.
    await show([roomless]);
    expect(rows()[0]).toContain(
      "Office lampOffline: check it's switched on and in range",
    );
  });

  it("keeps a problem leading once a room is chosen, with the room on its line", async () => {
    answer = (path, json) =>
      path === "/api/devices/update" ? { ...heater, ...(json as object) } : {};
    await show([{ ...heater, roomId: null }]);

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hall heater: room"]',
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const office = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitemradio]"),
    ].find((each) => each.textContent === "Office")!;
    await act(async () => office.click());
    await show([{ ...heater, roomId: "office" }]);

    expect(rows()).toEqual([
      "Hall heaterOffline: check it's switched on and in range · Office",
    ]);
  });

  it("removes a device its network no longer has, after saying what that does", async () => {
    await show([plug, heater]);

    await act(async () => buttonIn(rowOf("Hall plug"), "Remove").click());
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Remove Hall plug?");
    expect(dialog.textContent).toContain(
      "It isn't paired with the Zigbee network any more, as after a reset, so nothing reaches it.",
    );
    await act(async () => buttonIn(dialog, "Remove").click());

    expect(requests.at(-1)).toEqual({
      path: "/api/devices/remove",
      json: { id: "plug", force: false },
    });
    await show([heater]);
    expect(rows()).toEqual([
      "Hall heaterOffline: check it's switched on and in range · Hall",
    ]);
    expect(status()).toBe("Hall plug is removed.");
  });

  it("repairs a device in its driver's words, showing a refused answer under its field", async () => {
    const problem = {
      id: "keyMismatch",
      words: "Its encryption key doesn't match",
      repair: {
        help: "Enter the key from its configuration.",
        asks: [
          {
            id: "key",
            label: "Encryption key",
            kind: "secret" as const,
            help: null,
            placeholder: "44 characters, ending in =",
            refusals: { wrongKey: "That key doesn't match." },
          },
        ],
      },
    };
    const kettle = device("kettle", "Kettle plug", {
      roomId: "hall",
      problem,
    });
    await show([kettle, heater]);
    expect(rows()[0]).toBe(
      "Kettle plugIts encryption key doesn't match · HallRepair",
    );

    await act(async () => buttonIn(rowOf("Kettle plug"), "Repair").click());
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Repair Kettle plug");
    expect(dialog.textContent).toContain(
      "Enter the key from its configuration.",
    );
    const field = dialog.querySelector("input")!;
    expect(buttonIn(dialog, "Repair").disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, "a wrong key");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    answer = () => ({ refused: { question: "key", refusal: "wrongKey" } });
    await act(async () => buttonIn(dialog, "Repair").click());
    expect(requests.at(-1)).toEqual({
      path: "/api/devices/repair",
      json: { id: "kettle", answers: { key: "a wrong key" } },
    });
    expect(dialog.querySelector("[role=alert]")?.textContent).toBe(
      "That key doesn't match.",
    );
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.value).toBe("a wrong key");

    const repaired = { ...kettle, problem: null };
    answer = () => ({ repaired });
    await act(async () => buttonIn(dialog, "Repair").click());
    await show([repaired, heater]);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(rowOf("Kettle plug").textContent).toContain("Repaired");
    expect(status()).toBe("Kettle plug is repaired.");
  });

  it("lets a row go when it clears by itself, as a light switched back on at the wall", async () => {
    await show([heater, lamp]);
    await show([{ ...heater, availability: "online" }, lamp]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("Office lamp");
  });
});
