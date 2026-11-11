// @vitest-environment jsdom
import type { AppInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import {
  createLiveFeed,
  DeviceSections,
  useAppClient,
  type AppClient,
  type DevicePageProps,
  type Tile,
} from "@meetsanctum/ui-sdk";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostedApp } from "../src/apps";
import { alex, entry } from "./activity-fixtures";
import { coreJson } from "../src/core-fetch";
import { useDashboards } from "../src/dashboards";
import { DeviceDetail } from "../src/device-detail";
import { timeText } from "../src/device-history-data";
import { sectionsByRoom } from "../src/device-tiles";
import { useDevices } from "../src/use-devices";
import {
  places,
  lampState,
  lamp,
  kettle,
  remote,
} from "./device-detail-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// A device's detail: opened from its tile's body, its controls send through
// core Devices as the tiles do.

// An app that adds a page to remotes' details, drawn in its own scope.
function PressesPage(props: DevicePageProps) {
  const client = useAppClient();
  return (
    <p>
      {client.app.id} for {props.device.name}:{" "}
      {props.device.capabilities.map((each) => each.kind).join(", ")}
    </p>
  );
}
function pressesApp(permissions: string[]): HostedApp {
  const info: AppInfo = {
    id: "test.presses",
    name: "Presses",
    version: "0.1.0",
    icon: null,
    pages: [],
    permissions,
    requests: [],
    state: "running",
    settings: null,
    provides: {
      entities: [],
      widgets: [],
      roomSections: [],
      devicePages: [
        { id: "test.presses", title: "Presses", kinds: ["button"] },
      ],
    },
  };
  return {
    info,
    ui: {
      id: "test.presses",
      version: "1.0.0",
      pages: {},
      devicePages: { "test.presses": PressesPage },
    },
    client: { app: info } as AppClient,
  };
}
let apps: HostedApp[] = [];

// Core History's answers: the lamp came on at 40% three hours ago, and
// whether it is kept.
let kept = true;
function historyAnswer(path: string) {
  const query = new URL(path, "http://core").searchParams;
  const common = {
    device: query.get("device"),
    capability: query.get("capability"),
    kind: "light",
    from: query.get("from"),
    to: query.get("to"),
    kept,
  };
  if (path.startsWith("/api/history/states")) {
    return {
      ...common,
      states: kept
        ? [
            {
              at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
              availability: "online",
              state: lampState,
            },
          ]
        : [],
    };
  }
  return { ...common, period: "hour", fields: { on: [], brightness: [] } };
}

// The lamp turned on by Alex; the remote pressed once, which Moods
// answered.
function activityAnswer(path: string) {
  const device = new URL(path, "http://core").searchParams.get("device");
  const entries =
    device === "remote"
      ? [
          entry({
            id: "press",
            action: "device.press",
            subject: {
              type: "device",
              id: "remote",
              name: "Office button",
              gone: false,
            },
            detail: { capability: "button", action: "double", captured: false },
            who: {
              kind: "press",
              device: "remote",
              name: "Office button",
              action: "double",
            },
            caused: {
              runs: [],
              apps: [{ id: "sanctum.moods", name: "Moods" }],
              devices: [
                { type: "device", id: "lamp", name: "Lamp", gone: false },
              ],
              failed: 0,
            },
          }),
        ]
      : [entry({ at: new Date().toISOString(), who: alex })];
  return { entries, more: false };
}

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];
// Home's devices, as the core keeps them.
let onHome: string[];
let showActivity: (device: string) => void;

function Harness() {
  const shown = useDevices(live);
  const { home } = useDashboards(live);
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
        apps={apps}
        live={live}
        home={home}
        onClose={() => setDetail((current) => ({ ...current, open: false }))}
        onCovering={() => {}}
        onShowActivity={showActivity}
        onOpenAppSettings={() => {}}
        onOpenStatus={() => {}}
      />
    </>
  );
}

const dialog = () => container.querySelector('[role="dialog"]');
const button = (label: string, within: ParentNode = container) => {
  const found = [...within.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === label || each.textContent === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
};
const posted = () =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([path]) => path === "/api/devices/command")
    .map(([, init]) => init?.json);

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

// The glass under an overlay's header (src/overlay.tsx).
const glass = () =>
  dialog()!.querySelector<HTMLElement>("[data-slot=overlay-glass]")!;

// A press with a mouse: down on `from`, up on `to`, then the click, which
// goes to `on`.
async function press(
  on: Element,
  where: { from?: Element; to?: Element } = {},
) {
  await act(async () => {
    (where.from ?? on).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    (where.to ?? on).dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true }),
    );
    on.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function show() {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    live.refresh();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  apps = [];
  kept = true;
  live = createLiveFeed();
  devices = [lamp, kettle];
  onHome = ["lamp"];
  showActivity = vi.fn();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path === "/api/devices/command") {
      const asked = init?.json as { device: string };
      return devices.find((each) => each.id === asked.device)!.capabilities[0];
    }
    if (path === "/api/dashboards") {
      return [
        {
          id: "home",
          name: "Home",
          background: "mocha",
          kind: "home",
          devices: onHome,
        },
      ];
    }
    if (path === "/api/dashboards/home/add") {
      onHome = [...onHome, (init?.json as { device: string }).device];
      return {
        id: "home",
        name: "Home",
        background: "mocha",
        kind: "home",
        devices: onHome,
      };
    }
    if (path === "/api/dashboards/home/remove") {
      const { device } = init?.json as { device: string };
      onHome = onHome.filter((each) => each !== device);
      return {
        id: "home",
        name: "Home",
        background: "mocha",
        kind: "home",
        devices: onHome,
      };
    }
    if (path.startsWith("/api/history/")) return historyAnswer(path);
    if (path.startsWith("/api/activity?")) return activityAnswer(path);
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
});

describe("a device's detail", () => {
  it("opens from a tile's body with the light's name, room and status", async () => {
    await show();
    expect(dialog()).toBeNull();
    await click(button("Lamp, 40%"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Lamp");
    expect(dialog()?.textContent).toContain("Office · 40%");
    expect(
      [...dialog()!.querySelectorAll('[role="tab"]')].map((each) =>
        each.getAttribute("aria-label"),
      ),
    ).toEqual(["Colour", "Brightness", "History", "Activity"]);
  });

  it("says who did what to it on its Activity page, and opens the home's Activity", async () => {
    await show();
    await click(button("Lamp, 40%"));
    await click(button("Activity", dialog()!));

    expect(vi.mocked(coreJson).mock.calls.map(([path]) => path)).toContain(
      "/api/activity?limit=8&device=lamp",
    );
    expect(dialog()?.textContent).toContain("Last change");
    expect(dialog()?.textContent).toMatch(/Alex turned it on at \d\d:\d\d/);
    expect(dialog()?.textContent).toContain("Today");
    expect(dialog()?.textContent).toContain("Turned on at 80%");

    await click(button("Show all in Activity", dialog()!));
    expect(showActivity).toHaveBeenCalledWith("lamp");
  });

  it("shows the device's history from core History", async () => {
    await show();
    await click(button("Lamp, 40%"));
    await click(button("History", dialog()!));
    const asked = vi
      .mocked(coreJson)
      .mock.calls.map(([path]) => path)
      .filter((path) => path.startsWith("/api/history/"));
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(
      /^\/api\/history\/states\?device=lamp&capability=light&to=/,
    );
    expect(asked[1]).toContain("period=hour");
    expect(dialog()?.textContent).toContain("Last 24 hours");
    expect(dialog()?.textContent).toContain("On for 3 h");
    // Today's alone until a day has ended, however the 3 hours fall either
    // side of midnight.
    expect(dialog()?.textContent).toMatch(
      /Last 7 days(On for 3 h today|.* a day)/,
    );
  });

  it("says when the household doesn't keep a device's history", async () => {
    kept = false;
    await show();
    await click(button("Kettle, On"));
    expect(
      [...dialog()!.querySelectorAll('[role="tab"]')].map((each) =>
        each.getAttribute("aria-label"),
      ),
    ).toEqual(["Power", "History", "Activity"]);
    expect(dialog()?.textContent).toContain(
      "doesn't keep this device's history",
    );
  });

  it("keeps every live transition between history refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
      await show();
      await click(button("Lamp, 40%"));
      await click(button("History", dialog()!));
      const capability = lamp.capabilities[0]!;
      if (capability.kind !== "light") throw new Error("Expected a light");
      const report = async (on: boolean) => {
        await act(async () => {
          live.publish({
            type: "device",
            id: lamp.id,
            device: {
              ...lamp,
              lastSeenAt: new Date().toISOString(),
              capabilities: [{ ...capability, observed: { ...lampState, on } }],
            },
          });
        });
      };
      await report(false);
      await act(async () => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      await report(true);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(dialog()?.textContent).toContain("On for 3 h 1 min");
      expect(dialog()?.textContent).toContain(
        `${timeText(Date.parse("2026-10-30T12:00:00Z"))} to ${timeText(Date.parse("2026-10-30T12:02:00Z"))}: Off`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a colour through core Devices, turning the light on", async () => {
    await show();
    await click(button("Lamp, 40%"));
    await click(button("Red", dialog()!));
    expect(posted()).toEqual([
      {
        device: "lamp",
        capability: "light",
        command: { on: true, hue: 0, saturation: 100 },
      },
    ]);
  });

  it.each([
    ["light", "Lamp, 40%", "Lamp"],
    ["switch", "Kettle, On", "Kettle"],
  ] as const)(
    "shows app pages as a page after the shell's %s controls",
    async (kind, tileLabel, name) => {
      const app = pressesApp([`devices.read:${kind}`]);
      app.info.provides.devicePages[0]!.kinds = [kind];
      apps = [app];
      await show();
      await click(button(tileLabel));
      expect(dialog()?.textContent).toContain(
        `test.presses for ${name}: ${kind}`,
      );
      expect(button(kind === "light" ? "Red" : name, dialog()!)).toBeTruthy();
      expect(
        [...dialog()!.querySelectorAll('[role="tab"]')].map((each) =>
          each.getAttribute("aria-label"),
        ),
      ).toEqual([
        ...(kind === "light" ? ["Colour", "Brightness"] : ["Power"]),
        "Presses, from Presses",
        "History",
        "Activity",
      ]);
    },
  );

  it("closes with Done", async () => {
    await show();
    await click(button("Lamp, 40%"));
    await click(button("Done", dialog()!));
    expect(dialog()).toBeNull();
  });

  it("closes with a click on the glass around its controls, focusing the tile", async () => {
    await show();
    // A real click focuses the tile; jsdom's does not.
    button("Lamp, 40%").focus();
    await click(button("Lamp, 40%"));
    await press(glass());
    expect(dialog()).toBeNull();
    // Radix gives focus back a task after the overlay goes.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(button("Lamp, 40%"));
  });

  it("closes with a click on its page around its controls", async () => {
    await show();
    await click(button("Lamp, 40%"));
    // The pages span the glass; the page on show is the one not inert.
    await press(dialog()!.querySelector("[role=tabpanel]:not([inert])")!);
    expect(dialog()).toBeNull();
  });

  it("stays open after a click in its header, its controls or its tabs", async () => {
    await show();
    await click(button("Lamp, 40%"));
    await press(dialog()!.querySelector("header")!);
    await press(
      dialog()!.querySelector(
        "[role=tabpanel]:not([inert]) [data-slot=swipe-page-content]",
      )!,
    );
    await press(dialog()!.querySelector("[role=tablist]")!);
    expect(dialog()).not.toBeNull();
  });

  it("stays open after a press that starts or ends in its controls", async () => {
    await show();
    await click(button("Lamp, 40%"));
    const slider = dialog()!.querySelector<HTMLElement>(
      '[aria-label="Lamp brightness"]',
    )!;
    // A drag on the slider let go on the glass, whose click the browser
    // then gives to the glass, their common ancestor.
    await press(glass(), { from: slider });
    expect(dialog()).not.toBeNull();
    await press(glass(), { to: slider });
    expect(dialog()).not.toBeNull();
  });

  it("stays open after a touch that lifts over its controls, though the glass keeps it", async () => {
    await show();
    await click(button("Lamp, 40%"));
    // A touch's events all go to where it began, the glass, wherever it
    // lifts; what is under the finger then is the control. jsdom has no
    // elementFromPoint of its own.
    const under = vi.fn(() => button("Red", dialog()!));
    Object.assign(document, { elementFromPoint: under });
    try {
      await press(glass());
      expect(under).toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("gives a switch one power button, which switches it", async () => {
    await show();
    await click(button("Kettle, On"));
    await click(button("Kettle", dialog()!));
    expect(posted()).toEqual([
      { device: "kettle", capability: "power", command: { on: false } },
    ]);
  });

  it("says when an offline device was last seen", async () => {
    devices = [
      {
        ...lamp,
        availability: "offline",
        lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ];
    await show();
    await click(button("Lamp, Offline"));
    expect(dialog()?.textContent).toContain(
      "Office · Offline · Seen 5 minutes ago",
    );
    expect(button("Red", dialog()!).disabled).toBe(true);
  });

  it("puts its device on Home from its header, and takes it off again", async () => {
    await show();
    await click(button("Kettle, On"));
    const add = button("Add to Home", dialog()!);
    await click(add);

    expect(vi.mocked(coreJson)).toHaveBeenCalledWith(
      "/api/dashboards/home/add",
      { method: "POST", json: { device: "kettle" } },
    );
    expect(onHome).toEqual(["lamp", "kettle"]);
    expect(add.textContent).toBe("On Home, remove from Home");

    await click(add);
    expect(onHome).toEqual(["lamp"]);
    expect(add.textContent).toBe("Add to Home");
  });

  it("closes when its device is removed", async () => {
    await show();
    await click(button("Lamp, 40%"));
    await act(async () => {
      live.publish({ type: "device", id: "lamp", device: null });
    });
    expect(dialog()).toBeNull();
  });
});

describe("a remote's detail", () => {
  it("opens from anywhere on its tile and shows the pages apps add for remotes", async () => {
    devices = [lamp, remote];
    apps = [pressesApp(["devices.read:button"])];
    await show();

    await click(button("Office button, Idle"));

    expect(dialog()?.querySelector("h2")?.textContent).toBe("Office button");
    expect(dialog()?.textContent).toContain("Office · Idle");
    expect(dialog()?.textContent).toContain(
      "test.presses for Office button: button",
    );
    // Then its Activity: its presses and what each did.
    await click(button("Activity", dialog()!));
    expect(dialog()?.textContent).toContain("Last press");
    expect(dialog()?.textContent).toContain("Double press");
    expect(dialog()?.textContent).toContain("Moods changed Lamp");
  });

  it("shows its press on its tile for a few seconds", async () => {
    vi.useFakeTimers();
    try {
      devices = [remote];
      await show();
      await act(async () => {
        live.publish({
          type: "press",
          device: "remote",
          capability: "button",
          action: "double",
          at: "2026-10-30T12:00:00.000Z",
          isCaptured: false,
        });
      });
      expect(button("Office button, Double press")).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(button("Office button, Idle")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a remote no app adds a page for on its Activity", async () => {
    devices = [remote];
    await show();

    await click(button("Office button, Idle"));

    expect(dialog()?.textContent).toContain("Last press");
    expect(dialog()?.textContent).not.toContain("From apps");
    expect(dialog()!.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });
});

// A climate sensor on a battery, which last said something 3 minutes ago.
const reading = (measure: "temperature" | "humidity", value: number) => ({
  id: measure,
  kind: "sensor" as const,
  features: { measures: measure },
  state: { value },
  observed: { value },
  desired: null,
  sync: "synced" as const,
  setBy: null,
  changedAt: null,
});
const climateSensor = (battery: number): DeviceInfo => ({
  ...lamp,
  id: "climate",
  name: "Office sensor",
  lastSeenAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  battery,
  capabilities: [reading("temperature", 21.5), reading("humidity", 48)],
});

describe("a sensor's detail", () => {
  it("keeps the age of its last report current while open", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
      devices = [climateSensor(87)];
      await show();
      await click(button("Office sensor, 21.5° · 48%"));
      expect(dialog()?.textContent).toContain("Updated 3 minutes ago");

      await act(async () => vi.advanceTimersByTime(2 * 60_000));

      expect(dialog()?.textContent).toContain("Updated 5 minutes ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the first partial five-minute period in its day request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-31T12:02:00Z"));
      devices = [climateSensor(87)];
      await show();
      await click(button("Office sensor, 21.5° · 48%"));
      const queries = vi
        .mocked(coreJson)
        .mock.calls.filter(([path]) => path.includes("period=5m"))
        .map(([path]) => new URL(path, "http://core").searchParams);
      expect(queries).toHaveLength(2);
      expect(queries.map((query) => query.get("from"))).toEqual([
        "2026-10-30T12:00:00.000Z",
        "2026-10-30T12:00:00.000Z",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says Not known when its chart cursor is in a missing period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
      devices = [climateSensor(87)];
      const original = vi.mocked(coreJson).getMockImplementation()!;
      vi.mocked(coreJson).mockImplementation(async (path, init) => {
        if (path.includes("period=5m")) {
          return {
            ...historyAnswer(path),
            fields: {
              value: [
                {
                  start: "2026-10-31T11:45:00.000Z",
                  mean: 20,
                  min: 20,
                  max: 20,
                  seconds: 300,
                },
              ],
            },
          };
        }
        return original(path, init);
      });
      await show();
      await click(button("Office sensor, 21.5° · 48%"));
      const chart = dialog()!.querySelector<HTMLElement>(
        '[aria-label="Temperature over the last 24 hours"]',
      )!;
      await act(async () => {
        chart.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
        );
      });
      // 11:52:30 is the missing 11:50–11:55 period, not the 11:45 mean.
      expect(chart.textContent).toContain("Not known");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens from anywhere on its tile with what it reads, when it last said so, and its battery", async () => {
    devices = [climateSensor(87)];
    await show();

    await click(button("Office sensor, 21.5° · 48%"));

    expect(dialog()?.querySelector("h2")?.textContent).toBe("Office sensor");
    expect(dialog()?.textContent).toContain("Office · Updated 3 minutes ago");
    // Its readings first, then its Activity.
    expect(
      [...dialog()!.querySelectorAll('[role="tab"]')].map((each) =>
        each.getAttribute("aria-label"),
      ),
    ).toEqual(["Readings", "Activity"]);
    // Each reading's section on Readings, each with its week inside.
    const page = dialog()!.querySelector('[role="tabpanel"][id$="-readings"]')!;
    const readings = [...page.querySelectorAll("section h3")]
      .filter((each) => each.textContent !== "Last 7 days")
      .map((each) => each.parentElement!);
    expect(
      readings.map((each) => each.querySelector("h3")?.textContent),
    ).toEqual(["Temperature", "Humidity"]);
    expect(readings[0]?.textContent).toContain("21.5°");
    expect(readings[1]?.textContent).toContain("48%");
    expect(dialog()?.textContent).toContain("Battery 87%");
    // Its day from the 5-minute roll-ups and its week from the hourly ones,
    // for each reading.
    const asked = vi
      .mocked(coreJson)
      .mock.calls.map(([path]) => path)
      .filter((path) => path.startsWith("/api/history/statistics"));
    expect(asked).toHaveLength(4);
    expect(asked.filter((path) => path.includes("period=5m"))).toHaveLength(2);
    expect(asked.some((path) => path.includes("capability=humidity"))).toBe(
      true,
    );
  });

  it("says a low battery in red with a sign, and shows the home's unit", async () => {
    devices = [climateSensor(8)];
    await show();
    await act(async () =>
      live.publish({
        type: "places",
        places: {
          ...places,
          home: { ...places.home, temperatureUnit: "fahrenheit" },
        },
      }),
    );

    await click(button("Office sensor, 70.7° · 48%"));

    expect(dialog()?.textContent).toContain("Battery low, 8%: replace it soon");
    expect(dialog()?.textContent).toContain("70.7°");
  });
});
