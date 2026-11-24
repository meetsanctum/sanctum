// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed, icons } from "@meetsanctum/ui-sdk";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { HomeStatus } from "../src/place-pages";
import { useDevices } from "../src/use-devices";
import {
  contactSensor,
  copyWithoutScreenReaderText,
  hallLight,
  lamp,
  light,
  loose,
  places,
  plug,
  sensor,
} from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));
vi.mock("@meetsanctum/ui-sdk", async (original) => {
  const actual = await original<typeof import("@meetsanctum/ui-sdk")>();
  const { Lightbulb, Thermometer } = actual.icons;
  return {
    ...actual,
    icons: {
      ...actual.icons,
      Lightbulb: vi.fn((props: ComponentProps<typeof Lightbulb>) => (
        <Lightbulb {...props} />
      )),
      Thermometer: vi.fn((props: ComponentProps<typeof Thermometer>) => (
        <Thermometer {...props} />
      )),
    },
  };
});

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  devices = [lamp, plug, hallLight, loose];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
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

describe("the home's status", () => {
  const openCategory = vi.fn();
  const openAttention = vi.fn();
  const openMaintenance = vi.fn();

  function Status() {
    const shown = useDevices(live);
    return (
      <HomeStatus
        devices={shown}
        apps={[]}
        openCategory={openCategory}
        openAttention={openAttention}
        openMaintenance={openMaintenance}
      />
    );
  }

  async function showStatus() {
    await act(async () => {
      root.render(<Status />);
    });
    await act(async () => {
      live.refresh();
    });
  }

  // Each tile, Lights' being its card with a switch (lights-card.tsx).
  const tiles = () =>
    [
      ...container.querySelector("section[aria-label='Home status']")!.children,
    ] as HTMLElement[];
  const shown = (each: Element) =>
    copyWithoutScreenReaderText(each).textContent;

  it("says what the sensors read and how many lights and switches are on, each opening its category", async () => {
    openCategory.mockReset();
    devices = [
      lamp,
      hallLight,
      plug,
      sensor("desk", "office", 21.5, 48),
      sensor("hall", "hall", 19.5, 58),
    ];
    await showStatus();

    // Lights first, the one with something to press.
    expect(tiles().map(shown)).toEqual([
      "Lights1 on",
      "Environment19.5–21.5°",
      "Switches1 on",
    ]);
    expect(tiles()[1]?.getAttribute("aria-label")).toBe(
      "Environment, 19.5 to 21.5°",
    );
    await click(tiles()[1] as HTMLElement);
    expect(openCategory).toHaveBeenCalledWith("environment");
  });

  it("redraws the Environment status and skips unchanged Lights contents", async () => {
    const thermometer = sensor("desk", "office", 21.5, 48);
    devices = [lamp, thermometer];
    const lightbulb = vi.mocked(icons.Lightbulb);
    const temperature = vi.mocked(icons.Thermometer);
    lightbulb.mockClear();
    temperature.mockClear();
    await showStatus();
    expect(tiles().map(shown)).toEqual(["Lights1 on", "Environment21.5°"]);
    expect(lightbulb).toHaveBeenCalled();
    expect(temperature).toHaveBeenCalled();
    lightbulb.mockClear();
    temperature.mockClear();

    await act(async () => {
      live.publish({
        type: "device",
        id: thermometer.id,
        device: sensor(thermometer.id, "office", 22, 48),
      });
    });
    expect(tiles().map(shown)).toEqual(["Lights1 on", "Environment22°"]);
    expect(temperature).toHaveBeenCalledOnce();
    expect(lightbulb).not.toHaveBeenCalled();
  });

  it("has Lights' card, with a switch that turns the home's lights off, which opens Lights' page", async () => {
    openCategory.mockReset();
    devices = [lamp, hallLight];
    const coreAnswers = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) =>
      path === "/api/devices/lights"
        ? { on: false, switched: 1, failed: [] }
        : coreAnswers(path, init),
    );
    await showStatus();

    const card = tiles()[0]!;
    expect(card.getAttribute("role")).toBe("group");
    expect(shown(card)).toBe("Lights1 on");
    const [opens, off] = [...card.querySelectorAll("button")];
    expect(off?.getAttribute("aria-label")).toBe("Turn off 1 light");
    expect(off?.dataset.on).toBe("");

    await click(off!);
    expect(
      vi
        .mocked(coreJson)
        .mock.calls.filter(([path]) => path === "/api/devices/lights")
        .map(([, request]) => request?.json),
    ).toEqual([{ place: { kind: "home" }, to: "off" }]);
    expect(openCategory).not.toHaveBeenCalled();

    await click(opens!);
    expect(openCategory).toHaveBeenCalledWith("lights");
  });

  it("counts the contact sensors that are open before Presence, and opens Security", async () => {
    openCategory.mockReset();
    devices = [
      lamp,
      contactSensor("front", "Front door", "hall", true),
      contactSensor("letterbox", "Letterbox", "hall", false),
    ];
    await showStatus();

    expect(tiles().map(shown)).toEqual(["Lights1 on", "Security1 open"]);
    expect(tiles()[1]?.getAttribute("aria-label")).toBe("Security, 1 open");
    await click(tiles()[1] as HTMLElement);
    expect(openCategory).toHaveBeenCalledWith("security");
  });

  it("says all are closed only when each contact sensor has said so", async () => {
    devices = [
      contactSensor("front", "Front door", "hall", false),
      contactSensor("letterbox", "Letterbox", "hall", false),
    ];
    await showStatus();
    expect(shown(tiles()[0]!)).toBe("SecurityAll closed");

    devices = [
      contactSensor("front", "Front door", "hall", false),
      contactSensor("letterbox", "Letterbox", "hall", null),
    ];
    await act(async () => {
      live.refresh();
    });
    expect(shown(tiles()[0]!)).toBe("Security1 closed");
  });

  it("ends with Batteries while a battery is to replace, which opens Maintenance", async () => {
    openMaintenance.mockReset();
    devices = [
      lamp,
      { ...sensor("hall", "hall", 19.5, 58), battery: 8 },
      { ...sensor("desk", "office", 21.5, 48), battery: 4 },
    ];
    await showStatus();

    expect(tiles().map(shown)).toEqual([
      "Lights1 on",
      "Environment19.5–21.5°",
      "BatteriesReplace 2",
    ]);
    expect(tiles().at(-1)?.getAttribute("aria-label")).toBe(
      "Batteries, replace 2: desk sensor's battery is at 4%, hall sensor's battery is at 8%. Opens Maintenance",
    );
    await click(tiles().at(-1) as HTMLElement);
    expect(openMaintenance).toHaveBeenCalledOnce();

    // One battery says its device; at 10% or more, none does.
    devices = [lamp, { ...sensor("hall", "hall", 19.5, 58), battery: 8 }];
    await showStatus();
    expect(shown(tiles().at(-1)!)).toBe("hall sensorBattery 8%");
    devices = [lamp, { ...sensor("hall", "hall", 19.5, 58), battery: 10 }];
    await showStatus();
    expect(tiles().map(shown)).toEqual(["Lights1 on", "Environment19.5°"]);
  });

  it("has only the categories the home has, and says when no sensor reads anything", async () => {
    devices = [lamp, sensor("hall", "hall", 19.5, 58, "offline")];
    await showStatus();

    expect(tiles().map(shown)).toEqual([
      "Lights1 on",
      "EnvironmentNo readings",
      // The sensor that doesn't answer needs attention.
      "hall sensorOffline",
    ]);
  });

  it("ends with what needs attention, by name for one device, opening Settings", async () => {
    openAttention.mockReset();
    devices = [lamp, { ...hallLight, availability: "offline" }];
    await showStatus();

    const attention = tiles().at(-1)!;
    expect(shown(attention)).toBe("CeilingOffline");
    expect(attention.getAttribute("aria-label")).toBe("Ceiling is offline");
    // A problem's sign is red.
    expect(attention.querySelector("svg")?.getAttribute("style")).toContain(
      "var(--danger)",
    );
    await click(attention as HTMLElement);
    expect(openAttention).toHaveBeenCalledOnce();
  });

  it("gives each tile its whole words, at least two cells", async () => {
    devices = [
      lamp,
      { ...hallLight, availability: "offline" },
      sensor("desk", "office", 21.5, 48),
    ];
    await showStatus();

    // Lights, Environment, then Attention, in one line that scrolls.
    expect(
      container.querySelector("section[aria-label='Home status']")?.classList,
    ).toContain("overflow-x-auto");
    expect(tiles().every((tile) => tile.classList.contains("w-max"))).toBe(
      true,
    );
    expect(tiles().every((tile) => tile.classList.contains("shrink-0"))).toBe(
      true,
    );
    expect(container.querySelector(".truncate")).toBeNull();
    expect(tiles()[1]?.className).toContain(
      "min-w-[calc(var(--cell)*2+var(--cell-gap))]",
    );
    expect(shown(tiles().at(-1)!)).toContain("Offline");
    // Attention too grows with its words from two cells.
    expect(tiles().at(-1)?.className).toContain(
      "min-w-[calc(var(--cell)*2+var(--cell-gap))]",
    );
  });

  it("counts several devices, the most pressing first, and is Graphite while there are only rooms to choose", async () => {
    devices = [
      lamp,
      {
        ...light("gone", "Hall plug", "hall", false),
        leftAt: "2026-10-31T12:00:00.000Z",
      },
      { ...lamp, id: "dark", name: "Desk lamp", availability: "offline" },
    ];
    await showStatus();
    expect(shown(tiles().at(-1)!)).toBe("Attention2 devices");
    expect(tiles().at(-1)?.getAttribute("aria-label")).toBe(
      "Attention, 2 devices: Hall plug isn't paired any more, Desk lamp is offline",
    );

    devices = [lamp, loose];
    await showStatus();
    expect(shown(tiles().at(-1)!)).toBe("LooseNo room");
    expect(
      tiles().at(-1)?.querySelector("svg")?.getAttribute("style"),
    ).toContain("var(--graphite-text)");
  });

  it("has no Attention while every device is fine, a low battery being Maintenance's", async () => {
    devices = [
      lamp,
      hallLight,
      { ...sensor("hall", "hall", 19.5, 58), battery: 8 },
    ];
    await showStatus();
    expect(tiles().map(shown)).toEqual([
      "Lights1 on",
      "Environment19.5°",
      "hall sensorBattery 8%",
    ]);
  });

  it("ends with Attention, then Batteries", async () => {
    devices = [
      lamp,
      { ...sensor("hall", "hall", 19.5, 58), battery: 8 },
      { ...hallLight, availability: "offline" },
    ];
    await showStatus();
    expect(tiles().map(shown).slice(-2)).toEqual([
      "CeilingOffline",
      "hall sensorBattery 8%",
    ]);
  });

  it("removes stale readings and shows Batteries when a quiet day passes without a live event", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date("2026-10-31T11:59:00Z"));
      devices = [
        {
          ...sensor("hall", "hall", 19.5, 58),
          availability: "unknown",
          battery: 64,
          lastSeenAt: "2026-10-30T12:00:00Z",
        },
      ];
      await showStatus();
      expect(tiles().map(shown)).toEqual(["Environment19.5°"]);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(tiles().map(shown)).toEqual([
        "EnvironmentNo readings",
        "hall sensorGone quiet",
      ]);
    } finally {
      await act(async () => root.render(null));
      vi.useRealTimers();
    }
  });
});
