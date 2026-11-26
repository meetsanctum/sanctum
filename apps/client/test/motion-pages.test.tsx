// @vitest-environment jsdom
import type { DeviceHistory, DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import {
  CategoryPage,
  HomeStatus,
  RoomPage,
  SidebarPlaces,
} from "../src/place-pages";
import { useSectionEntities } from "../src/room-sections";
import { useDevices } from "../src/use-devices";
import {
  capability,
  climate,
  contactSensor,
  copyWithoutScreenReaderText,
  motionSensor,
} from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// Motion sensors and light levels on the shell's places: a room's line, the
// Presence category with its overview and the home's status.

const minute = 60_000;
const places: Places = {
  home: {
    name: "Home",
    timeZone: "UTC",
    temperatureUnit: "celsius",
    hourCycle: "24h",
  },
  floors: [],
  zones: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "hall", name: "Hall", floorId: null },
  ],
};

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];
// Each sensor's recorded changes, by its device: when, and whether it saw motion.
let recorded: Record<string, [number, boolean][]>;
const openCategory = vi.fn();
const openRoom = vi.fn();

function historyOf(path: string): DeviceHistory {
  const query = new URLSearchParams(path.split("?")[1]);
  const device = query.get("device")!;
  return {
    device,
    capability: query.get("capability")!,
    kind: "motion",
    from: query.get("from")!,
    to: query.get("to")!,
    kept: true,
    states: (recorded[device] ?? []).map(([at, motion]) => ({
      at: new Date(at).toISOString(),
      availability: "online",
      state: { motion },
    })),
  };
}

function Harness(props: { page: "room" | "category" | "status"; id: string }) {
  const shown = useDevices(live);
  const entities = useSectionEntities(live, [], shown.fail);
  if (props.page === "status") {
    return (
      <>
        <HomeStatus
          devices={shown}
          apps={[]}
          openCategory={openCategory}
          openAttention={() => undefined}
          openMaintenance={() => undefined}
        />
        <nav>
          <SidebarPlaces devices={shown} current={null} open={() => {}} />
        </nav>
      </>
    );
  }
  return props.page === "room" ? (
    <RoomPage
      roomId={props.id}
      devices={shown}
      apps={[]}
      entities={entities}
      openDevice={() => {}}
      back={() => {}}
    />
  ) : (
    <>
      <CategoryPage
        id={props.id}
        devices={shown}
        openDevice={() => {}}
        openRoom={openRoom}
        back={() => {}}
      />
      <nav>
        <SidebarPlaces
          devices={shown}
          current={{ page: "category", params: { id: props.id } }}
          open={() => {}}
        />
      </nav>
    </>
  );
}

async function show(page: "room" | "category" | "status", id = "") {
  await act(async () => {
    root.render(<Harness page={page} id={id} />);
  });
  await act(async () => {
    live.refresh();
  });
  // Presence's overview reads its sensors' history once they are known.
  await act(async () => {});
}

const readingsLine = () =>
  container.querySelector("header [data-slot=readings]")?.textContent;
const headings = () =>
  [...container.querySelectorAll("section > h2")].map(
    (each) => each.textContent,
  );
const overviewRows = () =>
  [...container.querySelectorAll("li > button")].map(
    (each) => each.textContent,
  );
const statusTiles = () =>
  [
    ...container.querySelectorAll("section[aria-label='Home status'] button"),
  ].map((each) => copyWithoutScreenReaderText(each).textContent);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  live = createLiveFeed();
  devices = [];
  recorded = {};
  openCategory.mockReset();
  openRoom.mockReset();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/history/states")) return historyOf(path);
    return [];
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a room's line", () => {
  it("says what its sensors read first and ends with its motion", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { motion: true, minutesAgo: 1 },
        { temperature: 21, illuminance: 318 },
      ),
      climate("desk", "office", 21.5, 48),
      contactSensor("door", "Door", "office", true),
    ];
    await show("room", "office");

    expect(readingsLine()).toBe(
      "Temperature 21–21.5°Humidity 48%Light level 320 lxContact Sensors 1 openMotion now",
    );
    // Its motion sensor under Environment and under Presence, after it.
    expect(headings()).toEqual(["Environment", "Presence", "Security"]);
  });

  it("is quiet since the last of its sensors went quiet, with light as a range, offline ones left out", async () => {
    devices = [
      motionSensor(
        "hall",
        "office",
        { motion: false, minutesAgo: 12 },
        { illuminance: 40 },
      ),
      motionSensor(
        "stairs",
        "office",
        { motion: false, minutesAgo: 3 },
        { illuminance: 320 },
      ),
      motionSensor(
        "door",
        "office",
        { motion: true, minutesAgo: 1 },
        { illuminance: 5_000 },
        "offline",
      ),
    ];
    await show("room", "office");

    expect(readingsLine()).toBe("Light level 40–320 lxQuiet for 3 min");
  });

  it("moves on each minute", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    devices = [
      motionSensor("hall", "office", { motion: false, minutesAgo: 12 }),
    ];
    await show("room", "office");
    expect(readingsLine()).toBe("Quiet for 12 min");
    expect(container.textContent).toContain(
      "hall motion sensorQuiet for 12 min",
    );

    await act(async () => vi.advanceTimersByTime(2 * minute));

    expect(readingsLine()).toBe("Quiet for 14 min");
    expect(container.textContent).toContain(
      "hall motion sensorQuiet for 14 min",
    );
  });
});

describe("the Presence category", () => {
  const loose = (): DeviceInfo => ({
    ...motionSensor("loose", null, null),
    capabilities: [
      capability(
        "occupancy",
        "motion",
        {
          sensitivity: null,
          clearAfter: null,
          indicator: false,
        },
        null,
      ),
    ],
  });

  it("opens with each room's last 24 hours above its sensors by room, after Environment and Security in the sidebar", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { motion: true, minutesAgo: 1 },
        { temperature: 21 },
      ),
      motionSensor("hall", "hall", { motion: false, minutesAgo: 30 }),
      contactSensor("door", "Door", "office", true),
      loose(),
    ];
    await show("category", "presence");

    expect(container.querySelector("h1")?.textContent).toBe("Presence");
    // Nothing under its name: the overview says where there is motion.
    expect(container.querySelector("header p")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Last 24 hours");
    // A sensor in no room has no row, only its tile.
    expect(overviewRows()).toEqual([
      "OfficeMotion now",
      "HallQuiet for 30 min",
    ]);
    expect(headings()).toEqual(["Office", "Hall", "No room"]);
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual([
      "Environment21°",
      "Security1 open",
      "PresenceOffice",
      "Office",
      "Hall",
      "No room",
    ]);
  });

  it("leaves out rooms without a motion sensor", async () => {
    devices = [
      climate("desk", "office", 21.5, 48),
      motionSensor("hall", "hall", { motion: false, minutesAgo: 30 }),
    ];
    await show("category", "presence");
    expect(overviewRows()).toEqual(["HallQuiet for 30 min"]);
  });

  it("runs the overview timers only while a sensor is assigned to a room", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sensor = loose();
    devices = [sensor];
    await show("category", "presence");
    expect(overviewRows()).toEqual([]);
    // The motion tile has its own clock, even without an overview.
    expect(vi.getTimerCount()).toBe(1);

    devices = [{ ...sensor, roomId: "hall" }];
    await act(async () => live.refresh());
    expect(overviewRows()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(3);

    devices = [sensor];
    await act(async () => live.refresh());
    expect(overviewRows()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("pauses the overview chart clock while hidden and catches up on show", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12, 17));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const showWindow = (state: DocumentVisibilityState) =>
      act(async () => {
        visibility.mockReturnValue(state);
        document.dispatchEvent(new Event("visibilitychange"));
      });
    devices = [motionSensor("hall", "hall", { motion: false, minutesAgo: 30 })];
    await show("category", "presence");
    const tick = () =>
      container.querySelector<HTMLElement>(
        'section[aria-labelledby] div[aria-hidden="true"] > span[style*="left"]',
      )!.style.left;
    const beforeHiding = tick();
    const history = vi.mocked(coreJson);
    history.mockClear();
    history.mockImplementation(() => new Promise(() => {}));

    await showWindow("hidden");
    await act(async () => vi.advanceTimersByTime(6 * minute));
    expect(tick()).toBe(beforeHiding);
    expect(history).not.toHaveBeenCalled();

    await showWindow("visible");
    expect(tick()).not.toBe(beforeHiding);
    expect(history).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/history\/states\?/),
    );
  });

  it("measures the times when rooms arrive after the page mounts", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
    devices = [motionSensor("hall", "hall", { motion: false, minutesAgo: 30 })];
    await show("category", "presence");

    const ticks = container.querySelector<HTMLElement>(
      "section[aria-labelledby] [aria-hidden='true']",
    )!;
    expect(ticks.textContent).toContain("Now");
    expect(ticks.style.width).toBe("480px");
  });

  it("leaves a sensor's band empty when its history is not kept", async () => {
    const request = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) =>
      path.startsWith("/api/history/states")
        ? { ...historyOf(path), kept: false }
        : request(path, init),
    );
    devices = [motionSensor("hall", "hall", { motion: true, minutesAgo: 120 })];
    await show("category", "presence");

    expect(overviewRows()).toEqual(["HallMotion now"]);
    expect(container.querySelectorAll("li > button rect")).toHaveLength(0);
  });

  it("shows live motion while its history request is still pending", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    recorded = { hall: [[Date.now() - 60 * minute, false]] };
    devices = [motionSensor("hall", "hall", { motion: false, minutesAgo: 60 })];
    await show("category", "presence");
    vi.mocked(coreJson).mockImplementation(() => new Promise(() => {}));
    vi.setSystemTime(Date.now() + 30_000);
    const moving = motionSensor("hall", "hall", {
      motion: true,
      minutesAgo: 10 / 60,
    });
    await act(async () => {
      live.publish({ type: "device", id: moving.id, device: moving });
    });

    expect(
      container.querySelector("li > button")?.getAttribute("aria-label"),
    ).toBe("Hall, Motion now. Under a minute of motion, this time since 12:00");
  });

  it("keeps live offline and recovery spans when history cannot be refreshed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    const moving = motionSensor("hall", "hall", {
      motion: true,
      minutesAgo: 10,
    });
    recorded = { hall: [[Date.now() - 10 * minute, true]] };
    devices = [moving];
    await show("category", "presence");
    vi.mocked(coreJson).mockRejectedValue(new Error("History unavailable"));
    await act(async () => vi.advanceTimersByTime(minute));
    await act(async () => {
      live.publish({
        type: "device",
        id: moving.id,
        device: { ...moving, availability: "offline" },
      });
    });
    await act(async () => vi.advanceTimersByTime(minute));
    expect(
      container.querySelector("li > button")?.getAttribute("aria-label"),
    ).toBe("Hall, Offline. 11 min of motion, the last at 12:01");

    await act(async () => vi.advanceTimersByTime(minute));
    await act(async () => {
      live.publish({ type: "device", id: moving.id, device: moving });
    });
    await act(async () => vi.advanceTimersByTime(minute));
    expect(
      container.querySelector("li > button")?.getAttribute("aria-label"),
    ).toBe("Hall, Motion now. 12 min of motion, this time since 12:03");
  });

  it("shows each room's history without waiting for another room's request", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    recorded = {
      hall: [
        [Date.now() - 60 * minute, true],
        [Date.now() - 30 * minute, false],
      ],
    };
    devices = [
      motionSensor("office", "office", { motion: false, minutesAgo: 60 }),
      motionSensor("hall", "hall", { motion: false, minutesAgo: 30 }),
    ];
    const request = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path.startsWith("/api/history/states?device=office&")
        ? new Promise(() => {})
        : request(path, init),
    );
    await show("category", "presence");

    expect(
      container.querySelectorAll("li > button")[1]?.getAttribute("aria-label"),
    ).toBe("Hall, Quiet for 30 min. 30 min of motion, the last at 11:30");
  });

  it("keeps the newer history when periodic responses arrive out of order", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    devices = [motionSensor("hall", "hall", { motion: false, minutesAgo: 60 })];
    await show("category", "presence");
    let answerOlder!: (history: DeviceHistory) => void;
    let answerNewer!: (history: DeviceHistory) => void;
    const older = historyOf("?device=hall&capability=occupancy");
    const newer: DeviceHistory = {
      ...older,
      states: [
        {
          at: new Date(Date.now() - 60 * minute).toISOString(),
          availability: "online",
          state: { motion: true },
        },
        {
          at: new Date(Date.now() - 30 * minute).toISOString(),
          availability: "online",
          state: { motion: false },
        },
      ],
    };
    vi.mocked(coreJson)
      .mockImplementationOnce(
        () => new Promise<DeviceHistory>((resolve) => (answerOlder = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<DeviceHistory>((resolve) => (answerNewer = resolve)),
      );
    await act(async () => vi.advanceTimersByTime(5 * minute));
    await act(async () => vi.advanceTimersByTime(5 * minute));
    await act(async () => answerNewer(newer));
    expect(
      container.querySelector("li > button")?.getAttribute("aria-label"),
    ).toContain("30 min of motion, the last at 11:30");
    await act(async () => answerOlder(older));
    expect(
      container.querySelector("li > button")?.getAttribute("aria-label"),
    ).toContain("30 min of motion, the last at 11:30");
  });

  it("refreshes every sensor each five minutes while another sensor changes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    devices = [
      motionSensor("office", "office", { motion: false, minutesAgo: 60 }),
      motionSensor("hall", "hall", { motion: false, minutesAgo: 60 }),
    ];
    await show("category", "presence");
    vi.mocked(coreJson).mockClear();
    await act(async () => vi.advanceTimersByTime(4 * minute));
    const moving = motionSensor("office", "office", {
      motion: true,
      minutesAgo: 0,
    });
    await act(async () => {
      live.publish({ type: "device", id: moving.id, device: moving });
    });
    await act(async () => vi.advanceTimersByTime(minute));

    expect(
      vi
        .mocked(coreJson)
        .mock.calls.some(([path]) =>
          path.startsWith("/api/history/states?device=hall&"),
        ),
    ).toBe(true);
  });

  it("draws a room's day from all its sensors, and a row opens its room", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const today = (hours: number, minutes = 0) =>
      new Date(2026, 9, 31, hours, minutes).getTime();
    vi.setSystemTime(today(15));
    recorded = {
      door: [
        [today(9), true],
        [today(10), false],
      ],
      desk: [
        [today(10, 30), true],
        [today(11), false],
      ],
    };
    devices = [
      motionSensor("door", "office", { motion: false, minutesAgo: 300 }),
      motionSensor("desk", "office", { motion: false, minutesAgo: 240 }),
    ];
    await show("category", "presence");

    const row = container.querySelector<HTMLButtonElement>("li > button")!;
    expect(row.getAttribute("aria-label")).toBe(
      "Office, Quiet since 11:00. 1 h 30 min of motion, the last at 11:00",
    );
    await act(async () => row.click());
    expect(openRoom).toHaveBeenCalledWith("office");
  });

  it("says what its sensors say while none of them answers", async () => {
    devices = [
      motionSensor(
        "hall",
        "hall",
        { motion: true, minutesAgo: 2 },
        {},
        "offline",
      ),
    ];
    await show("category", "presence");
    expect(overviewRows()).toEqual(["HallOffline"]);
  });
});

describe("the Environment category", () => {
  it("leaves the light level out of Environment's cards", async () => {
    devices = [
      motionSensor("office", "office", null, {
        temperature: 21,
        illuminance: 320,
      }),
      climate("desk", "hall", 19.5, 58),
    ];
    await show("category", "environment");
    // A card for the temperature and one for the humidity, none for the
    // light level.
    const cards = [
      ...container.querySelectorAll(
        "ul[aria-label='Environment summary'] > li",
      ),
    ].map((card) =>
      [...card.querySelectorAll(":scope > span > span:not(.sr-only)")].map(
        (line) => line.textContent,
      ),
    );
    expect(cards).toEqual([
      ["Temperature", "19.5–21°"],
      ["Humidity", "58%"],
    ]);
  });
});

describe("the home's status", () => {
  it("has Presence after Environment, naming where there is motion, and opens its category", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { motion: true, minutesAgo: 1 },
        { temperature: 21, illuminance: 900 },
      ),
      motionSensor("hall", "hall", { motion: true, minutesAgo: 2 }),
    ];
    await show("status");

    expect(statusTiles()).toEqual([
      "Environment21°",
      "PresenceOffice and Hall",
    ]);
    const tile = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Presence, Office and Hall']",
    )!;
    await act(async () => tile.click());
    expect(openCategory).toHaveBeenCalledWith("presence");
  });

  it("is what the sidebar's categories say, which count two rooms with motion", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { motion: true, minutesAgo: 1 },
        { temperature: 21 },
      ),
      motionSensor("hall", "hall", { motion: false, minutesAgo: 30 }),
    ];
    await show("status");
    const categories = () =>
      [...container.querySelectorAll("nav button")]
        .slice(0, 2)
        .map((each) => each.textContent);
    expect(categories()).toEqual(statusTiles());
    expect(categories()).toEqual(["Environment21°", "PresenceOffice"]);

    // Two rooms are counted, where Home's tile names them.
    devices = devices.map((each) =>
      each.id === "hall"
        ? motionSensor("hall", "hall", { motion: true, minutesAgo: 1 })
        : each,
    );
    await show("status");
    expect(statusTiles()).toContain("PresenceOffice and Hall");
    expect(categories()).toContain("Presence2 rooms");

    devices = [motionSensor("hall", "hall", { motion: false, minutesAgo: 2 })];
    await show("status");
    expect([...container.querySelectorAll("nav button")][0]?.textContent).toBe(
      "PresenceQuiet",
    );
  });

  it("says Quiet, or No readings while no motion sensor answers", async () => {
    devices = [motionSensor("hall", "hall", { motion: false, minutesAgo: 2 })];
    await show("status");
    expect(statusTiles()).toEqual(["PresenceQuiet"]);

    devices = [
      motionSensor(
        "hall",
        "hall",
        { motion: true, minutesAgo: 2 },
        {},
        "offline",
      ),
    ];
    await show("status");
    expect(statusTiles()).toEqual([
      // The sensor that doesn't answer needs attention, first.
      "hall motion sensorOffline",
      "PresenceNo readings",
    ]);
  });

  it("never ranges the light level across the home", async () => {
    devices = [motionSensor("hall", "hall", null, { illuminance: 40 })];
    await show("status");
    expect(statusTiles()).toEqual([
      "EnvironmentNo readings",
      "PresenceNo readings",
    ]);
  });
});
