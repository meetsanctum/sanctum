// @vitest-environment jsdom
import type { CapabilityInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";
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
// Motion category and the home's status.

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
const openCategory = vi.fn();

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
}

const readingsLine = () =>
  container.querySelector("header [data-slot=readings]")?.textContent;
const headings = () =>
  [...container.querySelectorAll("section > h2")].map(
    (each) => each.textContent,
  );
const statusTiles = () =>
  [
    ...container.querySelectorAll("section[aria-label='Home status'] button"),
  ].map((each) => each.textContent);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  devices = [];
  openCategory.mockReset();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
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
    // Its motion sensor under Climate and under Motion, after it.
    expect(headings()).toEqual(["Climate", "Motion"]);
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

    expect(readingsLine()).toBe("No motion for 3 minLight level 40–320 lx");
  });

  it("moves on each minute", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    devices = [
      motionSensor("hall", "office", { occupied: false, minutesAgo: 12 }),
    ];
    await show("room", "office");
    expect(readingsLine()).toBe("No motion for 12 min");
    expect(container.textContent).toContain(
      "hall motion sensorNo motion for 12 min",
    );

    await act(async () => vi.advanceTimersByTime(2 * minute));

    expect(readingsLine()).toBe("No motion for 14 min");
    expect(container.textContent).toContain(
      "hall motion sensorNo motion for 14 min",
    );
  });
});

describe("the Motion category", () => {
  it("says where there is motion, after Climate in the sidebar", async () => {
    devices = [
      motionSensor(
        "office",
        "office",
        { occupied: true, minutesAgo: 1 },
        { temperature: 21 },
      ),
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 30 }),
      {
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
      },
    ];
    await show("category", "occupancy");

    expect(container.querySelector("h1")?.textContent).toBe("Motion");
    expect(container.querySelector("header p")?.textContent).toBe(
      "Motion in Office",
    );
    expect(headings()).toEqual(["Office", "Hall", "Not in a room"]);
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Climate", "Motion", "Office", "Hall"]);
  });

  it("says No motion while none sees it", async () => {
    devices = [
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 30 }),
    ];
    await show("category", "occupancy");
    expect(container.querySelector("header p")?.textContent).toBe("No motion");
  });

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
  it("has Motion after Climate, naming where there is motion, and opens its category", async () => {
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

    expect(statusTiles()).toEqual(["Climate21°", "MotionOffice and Hall"]);
    const tile = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Motion, Office and Hall']",
    )!;
    await act(async () => tile.click());
    expect(openCategory).toHaveBeenCalledWith("occupancy");
  });

  it("says No motion, or No readings while no motion sensor answers", async () => {
    devices = [
      motionSensor("hall", "hall", { occupied: false, minutesAgo: 2 }),
    ];
    await show("status");
    expect(statusTiles()).toEqual(["MotionNo motion"]);

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
      "MotionNo readings",
      // The sensor that doesn't answer needs attention.
      "hall motion sensorOffline",
    ]);
  });

  it("never ranges the light level across the home", async () => {
    devices = [motionSensor("hall", "hall", null, { illuminance: 40 })];
    await show("status");
    expect(statusTiles()).toEqual(["ClimateNo readings", "MotionNo readings"]);
  });
});
