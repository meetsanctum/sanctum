// @vitest-environment jsdom
import type {
  CapabilityInfo,
  DeviceHistory,
  DeviceInfo,
  Places,
} from "@meetsanctum/app-sdk";
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

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// Motion sensors and light levels on the shell's places: a room's line, the
// Presence category with its overview and the home's status.

const minute = 60_000;
const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "hall", name: "Hall", floorId: null },
  ],
};

const capability = (
  id: string,
  kind: "sensor" | "occupancy",
  features: object,
  state: object | null,
  changedAt: string | null = null,
) =>
  ({
    id,
    kind,
    features,
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt,
  }) as CapabilityInfo;

// A Hue motion sensor: motion, temperature and light level.
function motionSensor(
  id: string,
  roomId: string | null,
  motion: { occupied: boolean; minutesAgo: number } | null,
  readings: { temperature?: number; illuminance?: number } = {},
  availability: DeviceInfo["availability"] = "online",
): DeviceInfo {
  return {
    id,
    name: `${id} motion sensor`,
    driverName: "SML001",
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId,
    availability,
    lastSeenAt: null,
    firmware: null,
    probe: false,
    battery: 87,
    leftAt: null,
    capabilities: [
      capability(
        "occupancy",
        "occupancy",
        {
          senses: "motion",
          sensitivity: null,
          clearAfter: null,
          indicator: false,
        },
        motion && { occupied: motion.occupied },
        motion &&
          new Date(Date.now() - motion.minutesAgo * minute).toISOString(),
      ),
      ...Object.entries(readings).map(([measure, value]) =>
        capability(measure, "sensor", { measures: measure }, { value }),
      ),
    ],
  };
}

function climate(
  id: string,
  roomId: string,
  temperature: number,
  humidity: number,
) {
  return {
    ...motionSensor(id, roomId, null),
    name: `${id} sensor`,
    capabilities: [
      capability(
        "temperature",
        "sensor",
        { measures: "temperature" },
        { value: temperature },
      ),
      capability(
        "humidity",
        "sensor",
        { measures: "humidity" },
        { value: humidity },
      ),
    ],
  };
}

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
    kind: "occupancy",
    from: query.get("from")!,
    to: query.get("to")!,
    kept: true,
    states: (recorded[device] ?? []).map(([at, occupied]) => ({
      at: new Date(at).toISOString(),
      availability: "online",
      state: { occupied },
    })),
  };
}

function Harness(props: { page: "room" | "category" | "status"; id: string }) {
  const shown = useDevices(live);
  const entities = useSectionEntities(live, [], shown.fail);
  if (props.page === "status") {
    return (
      <HomeStatus
        devices={shown}
        apps={[]}
        openCategory={openCategory}
        openAttention={() => undefined}
        openMaintenance={() => undefined}
      />
    );
  }
  return props.page === "room" ? (
    <RoomPage
      roomId={props.id}
      devices={shown}
      apps={[]}
      entities={entities}
      openApp={() => {}}
      canOpen={() => false}
      openDevice={() => {}}
      back={() => {}}
    />
  ) : (
    <>
      <CategoryPage
        kind={props.id}
        devices={shown}
        openDevice={() => {}}
        openRoom={openRoom}
        back={() => {}}
      />
      <nav>
        <SidebarPlaces
          devices={shown}
          current={{ page: "category", params: { kind: props.id } }}
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
  ].map((each) => each.textContent);

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
  it("starts with its motion and ends with its light level", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { occupied: true, minutesAgo: 1 },
        { temperature: 21, illuminance: 318 },
      ),
      climate("desk", "office", 21.5, 48),
    ];
    await show("room", "office");

    expect(readingsLine()).toBe(
      "Motion nowTemperature 21–21.5°Humidity 48%Light level 320 lx",
    );
    // Its motion sensor under Climate and under Presence, after it.
    expect(headings()).toEqual(["Climate", "Presence"]);
  });

  it("is quiet since the last of its sensors went quiet, with light as a range, offline ones left out", async () => {
    devices = [
      motionSensor(
        "hall",
        "office",
        { occupied: false, minutesAgo: 12 },
        { illuminance: 40 },
      ),
      motionSensor(
        "stairs",
        "office",
        { occupied: false, minutesAgo: 3 },
        { illuminance: 320 },
      ),
      motionSensor(
        "door",
        "office",
        { occupied: true, minutesAgo: 1 },
        { illuminance: 5_000 },
        "offline",
      ),
    ];
    await show("room", "office");

    expect(readingsLine()).toBe("Quiet for 3 minLight level 40–320 lx");
  });

  it("moves on each minute", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    devices = [
      motionSensor("hall", "office", { occupied: false, minutesAgo: 12 }),
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
        "occupancy",
        {
          senses: "motion",
          sensitivity: null,
          clearAfter: null,
          indicator: false,
        },
        null,
      ),
    ],
  });

  it("opens with each room's last 24 hours above its sensors by room, after Climate in the sidebar", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { occupied: true, minutesAgo: 1 },
        { temperature: 21 },
      ),
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 30 }),
      loose(),
    ];
    await show("category", "occupancy");

    expect(container.querySelector("h1")?.textContent).toBe("Presence");
    // Nothing under its name: the overview says where there is motion.
    expect(container.querySelector("header p")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Last 24 hours");
    // A sensor in no room has no row, only its tile.
    expect(overviewRows()).toEqual([
      "OfficeMotion now",
      "HallQuiet for 30 min",
    ]);
    expect(headings()).toEqual(["Office", "Hall", "Not in a room"]);
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Climate", "Presence", "Office", "Hall"]);
  });

  it("leaves out rooms without a motion sensor", async () => {
    devices = [
      climate("desk", "office", 21.5, 48),
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 30 }),
    ];
    await show("category", "occupancy");
    expect(overviewRows()).toEqual(["HallQuiet for 30 min"]);
  });

  it("measures the times when rooms arrive after the page mounts", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
    devices = [
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 30 }),
    ];
    await show("category", "occupancy");

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
    devices = [
      motionSensor("hall", "hall", { occupied: true, minutesAgo: 120 }),
    ];
    await show("category", "occupancy");

    expect(overviewRows()).toEqual(["HallMotion now"]);
    expect(container.querySelectorAll("li > button rect")).toHaveLength(0);
  });

  it("shows live motion while its history request is still pending", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    recorded = { hall: [[Date.now() - 60 * minute, false]] };
    devices = [
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 60 }),
    ];
    await show("category", "occupancy");
    vi.mocked(coreJson).mockImplementation(() => new Promise(() => {}));
    vi.setSystemTime(Date.now() + 30_000);
    const moving = motionSensor("hall", "hall", {
      occupied: true,
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
      occupied: true,
      minutesAgo: 10,
    });
    recorded = { hall: [[Date.now() - 10 * minute, true]] };
    devices = [moving];
    await show("category", "occupancy");
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
      motionSensor("office", "office", { occupied: false, minutesAgo: 60 }),
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 30 }),
    ];
    const request = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path.startsWith("/api/history/states?device=office&")
        ? new Promise(() => {})
        : request(path, init),
    );
    await show("category", "occupancy");

    expect(
      container.querySelectorAll("li > button")[1]?.getAttribute("aria-label"),
    ).toBe("Hall, Quiet for 30 min. 30 min of motion, the last at 11:30");
  });

  it("keeps the newer history when periodic responses arrive out of order", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    devices = [
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 60 }),
    ];
    await show("category", "occupancy");
    let answerOlder!: (history: DeviceHistory) => void;
    let answerNewer!: (history: DeviceHistory) => void;
    const older = historyOf("?device=hall&capability=occupancy");
    const newer: DeviceHistory = {
      ...older,
      states: [
        {
          at: new Date(Date.now() - 60 * minute).toISOString(),
          availability: "online",
          state: { occupied: true },
        },
        {
          at: new Date(Date.now() - 30 * minute).toISOString(),
          availability: "online",
          state: { occupied: false },
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
      motionSensor("office", "office", { occupied: false, minutesAgo: 60 }),
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 60 }),
    ];
    await show("category", "occupancy");
    vi.mocked(coreJson).mockClear();
    await act(async () => vi.advanceTimersByTime(4 * minute));
    const moving = motionSensor("office", "office", {
      occupied: true,
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
      motionSensor("door", "office", { occupied: false, minutesAgo: 300 }),
      motionSensor("desk", "office", { occupied: false, minutesAgo: 240 }),
    ];
    await show("category", "occupancy");

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
        { occupied: true, minutesAgo: 2 },
        {},
        "offline",
      ),
    ];
    await show("category", "occupancy");
    expect(overviewRows()).toEqual(["HallOffline"]);
  });
});

describe("the Climate category", () => {
  it("leaves the light level out of Climate's range", async () => {
    devices = [
      motionSensor("office", "office", null, {
        temperature: 21,
        illuminance: 320,
      }),
      climate("desk", "hall", 19.5, 58),
    ];
    await show("category", "sensor");
    expect(container.querySelector("header p")?.textContent).toBe(
      "19.5–21° · 58%",
    );
  });
});

describe("the home's status", () => {
  it("has Presence after Climate, naming where there is motion, and opens its category", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { occupied: true, minutesAgo: 1 },
        { temperature: 21, illuminance: 900 },
      ),
      motionSensor("hall", "hall", { occupied: true, minutesAgo: 2 }),
    ];
    await show("status");

    expect(statusTiles()).toEqual(["Climate21°", "PresenceOffice and Hall"]);
    const tile = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Presence, Office and Hall']",
    )!;
    await act(async () => tile.click());
    expect(openCategory).toHaveBeenCalledWith("occupancy");
  });

  it("says Quiet, or No readings while no motion sensor answers", async () => {
    devices = [
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 2 }),
    ];
    await show("status");
    expect(statusTiles()).toEqual(["PresenceQuiet"]);

    devices = [
      motionSensor(
        "hall",
        "hall",
        { occupied: true, minutesAgo: 2 },
        {},
        "offline",
      ),
    ];
    await show("status");
    expect(statusTiles()).toEqual([
      "PresenceNo readings",
      // The sensor that doesn't answer needs attention.
      "hall motion sensorOffline",
    ]);
  });

  it("never ranges the light level across the home", async () => {
    devices = [motionSensor("hall", "hall", null, { illuminance: 40 })];
    await show("status");
    expect(statusTiles()).toEqual([
      "ClimateNo readings",
      "PresenceNo readings",
    ]);
  });
});
