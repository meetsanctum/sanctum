// @vitest-environment jsdom
import type { CapabilityInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { createLiveFeed, DeviceSections, type Tile } from "@meetsanctum/ui-sdk";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { DeviceDetail } from "../src/device-detail";
import { sectionsByRoom } from "../src/device-tiles";
import { useDevices } from "../src/use-devices";
import { unknownHome } from "./home-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// A motion sensor's detail: its Motion page first, from core History, then
// its Readings with the light level, then Activity; it opens on the page of
// the tile it was opened from.

const minute = 60_000;
const hour = 60 * minute;
// 15:00 where the tests run.
const now = new Date(2026, 9, 31, 15, 0).getTime();

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [{ id: "office", name: "Office", floorId: null }],
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

// A Hue motion sensor that last said something 2 minutes ago, quiet for
// 12 minutes now.
function motionSensor(
  readings: { temperature?: number; illuminance?: number } = {
    temperature: 21,
    illuminance: 318,
  },
): DeviceInfo {
  return {
    id: "hue",
    name: "Office motion sensor",
    driverName: "SML001",
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId: "office",
    availability: "online",
    lastSeenAt: new Date(now - 2 * minute).toISOString(),
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
        { occupied: false },
        new Date(now - 12 * minute).toISOString(),
      ),
      ...Object.entries(readings).map(([measure, value]) =>
        capability(measure, "sensor", { measures: measure }, { value }),
      ),
    ],
  };
}

// Its day: quiet, motion from 09:05 to 10:40, quiet, offline for half an
// hour, motion from 14:10 to 14:48, quiet since.
const at = (hours: number, minutes = 0) =>
  new Date(2026, 9, 31, hours, minutes).toISOString();
const states = [
  { at: at(-9), availability: "online", state: { occupied: false } },
  { at: at(9, 5), availability: "online", state: { occupied: true } },
  { at: at(10, 40), availability: "online", state: { occupied: false } },
  { at: at(12), availability: "offline", state: { occupied: false } },
  { at: at(12, 30), availability: "online", state: { occupied: false } },
  { at: at(14, 10), availability: "online", state: { occupied: true } },
  { at: at(14, 48), availability: "online", state: { occupied: false } },
];

function historyAnswer(path: string) {
  const query = new URL(path, "http://core").searchParams;
  const common = {
    device: query.get("device"),
    capability: query.get("capability"),
    kind: query.get("capability") === "occupancy" ? "occupancy" : "sensor",
    from: query.get("from"),
    to: query.get("to"),
    kept: true,
  };
  if (path.startsWith("/api/history/states")) return { ...common, states };
  if (query.get("period") === "hour" && common.kind === "occupancy") {
    // Yesterday, motion for 3 of its hours.
    const yesterday = new Date(2026, 9, 30, 8).getTime();
    return {
      ...common,
      period: "hour",
      fields: {
        occupied: [0, 1, 2].map((each) => ({
          start: new Date(yesterday + each * hour).toISOString(),
          mean: 1,
          min: 1,
          max: 1,
          seconds: 3600,
        })),
      },
    };
  }
  return { ...common, period: query.get("period"), fields: { value: [] } };
}

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];

function Harness() {
  const shown = useDevices(live);
  const [detail, setDetail] = useState<{ key: string | null; open: boolean }>({
    key: null,
    open: false,
  });
  return (
    <>
      <DeviceSections
        sections={sectionsByRoom(shown.tiles, shown.places)}
        onToggle={(tile) => void shown.toggle(tile).catch(() => undefined)}
        onDim={(tile, brightness) =>
          void shown.dim(tile, brightness).catch(() => undefined)
        }
        onOpen={(tile: Tile) => setDetail({ key: tile.key, open: true })}
      />
      <DeviceDetail
        container={container}
        tileKey={detail.key}
        open={detail.open}
        devices={shown}
        apps={[]}
        live={live}
        home={unknownHome}
        onClose={() => setDetail((current) => ({ ...current, open: false }))}
        onCovering={() => {}}
        onShowActivity={() => {}}
        onOpenAppSettings={() => {}}
        onOpenStatus={() => {}}
      />
    </>
  );
}

const dialog = () => container.querySelector('[role="dialog"]')!;
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
};
const tabs = () =>
  [...dialog().querySelectorAll('[role="tab"]')].map((each) => [
    each.getAttribute("aria-label"),
    each.getAttribute("aria-selected"),
  ]);
const panel = (id: string) =>
  dialog().querySelector<HTMLElement>(`[role="tabpanel"][id$="-${id}"]`)!;

async function open(label: string) {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    live.refresh();
  });
  await act(async () => {
    button(label).click();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  live = createLiveFeed();
  devices = [motionSensor()];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/history/")) return historyAnswer(path);
    if (path.startsWith("/api/activity?")) return { entries: [], more: false };
    throw new Error(`Unexpected ${path}`);
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

describe("a motion sensor's detail", () => {
  it("opens from its motion's tile on Motion, then Readings and Activity, saying when it last said something", async () => {
    await open("Office motion sensor, Quiet for 12 min");

    expect(dialog().querySelector("h2")?.textContent).toBe(
      "Office motion sensor",
    );
    expect(dialog().textContent).toContain("Office · Updated 2 minutes ago");
    expect(tabs()).toEqual([
      ["Motion", "true"],
      ["Readings", "false"],
      ["Activity", "false"],
    ]);
  });

  it("says on Motion what it says now, the day in a sentence, the week and its battery", async () => {
    await open("Office motion sensor, Quiet for 12 min");
    const motion = panel("motion");

    const parts = [...motion.querySelectorAll("section")].map((each) => [
      each.querySelector("h3")?.textContent,
      each.querySelector("h3 + p")?.textContent,
    ]);
    expect(parts).toEqual([
      ["Last 24 hours", "Quiet for 12 min"],
      // Yesterday's 3 hours, the one day that has ended.
      ["Last 7 days", "About 3 h a day"],
    ]);
    expect(motion.textContent).toContain(
      "2 h 13 min of motion, the last at 14:48",
    );
    expect(motion.textContent).toContain("Battery 87%");
    // Its readings leave the battery to Motion.
    expect(panel("readings").textContent).not.toContain("Battery");
  });

  it("gives screen readers each span, and the readout steps through them by key", async () => {
    await open("Office motion sensor, Quiet for 12 min");
    const band = panel("motion").querySelector<HTMLElement>(
      '[aria-label="Motion over the last 24 hours"]',
    )!;
    const spoken = [...band.parentElement!.querySelectorAll("ul li")].map(
      (each) => each.textContent,
    );
    expect(spoken).toEqual([
      "15:00 to 09:05: Quiet",
      "09:05 to 10:40: Motion",
      "10:40 to 12:00: Quiet",
      "12:00 to 12:30: Offline",
      "12:30 to 14:10: Quiet",
      "14:10 to 14:48: Motion",
      "14:48 to 15:00: Quiet",
    ]);

    await act(async () => band.focus());
    expect(band.textContent).toBe("Quiet14:48–now");
    const key = (name: string) =>
      act(async () => {
        band.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
      });
    await key("ArrowLeft");
    expect(band.textContent).toBe("Motion14:10–14:48");
    await key("Home");
    await key("ArrowRight");
    expect(band.textContent).toBe("Motion09:05–10:40");
  });

  it("has a light level column on Readings, and opens there from its readings' tile", async () => {
    await open("Office motion sensor, 21° · 320 lx");

    expect(tabs()).toEqual([
      ["Motion", "false"],
      ["Readings", "true"],
      ["Activity", "false"],
    ]);
    const columns = [...panel("readings").querySelectorAll("section h3")]
      .filter((each) => each.textContent !== "Last 7 days")
      .map((each) => [each.textContent, each.nextElementSibling?.textContent]);
    expect(columns).toEqual([
      ["Temperature", "21°"],
      ["Light level", "320 lx"],
    ]);
  });

  it("shows the light level's sun on Readings when it reads only the light level", async () => {
    const readingsIcon = () =>
      [...dialog().querySelectorAll('[role="tab"]')]
        .find((each) => each.getAttribute("aria-label") === "Readings")!
        .querySelector("svg")!
        .getAttribute("class");
    await open("Office motion sensor, 21° · 320 lx");
    expect(readingsIcon()).toContain("lucide-thermometer");
    await act(async () => root.unmount());
    devices = [motionSensor({ illuminance: 320 })];
    root = createRoot(container);
    await open("Office motion sensor, 320 lx");
    expect(readingsIcon()).toContain("lucide-sun");
  });

  it("shows the motion whose tile opened it, on a sensor with two", async () => {
    const sensor = motionSensor({});
    devices = [
      {
        ...sensor,
        capabilities: [
          ...sensor.capabilities,
          capability(
            "occupancy_2",
            "occupancy",
            {
              senses: "motion",
              sensitivity: null,
              clearAfter: null,
              indicator: false,
            },
            { occupied: true },
            new Date(now - 3 * minute).toISOString(),
          ),
        ],
      },
    ];
    // A device that senses in several places names each tile.
    await open("Office motion sensor occupancy_2, Motion now");
    expect(panel("motion").querySelector("section h3 + p")?.textContent).toBe(
      "Motion now",
    );
  });

  it("has Motion and Activity only when it reads nothing else", async () => {
    devices = [motionSensor({})];
    await open("Office motion sensor, Quiet for 12 min");
    expect(tabs().map(([label]) => label)).toEqual(["Motion", "Activity"]);
  });
});
