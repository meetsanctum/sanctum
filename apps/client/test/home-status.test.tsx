// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { HomeStatus } from "../src/place-pages";
import { useDevices } from "../src/use-devices";
import {
  hallLight,
  lamp,
  light,
  loose,
  places,
  plug,
  sensor,
} from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

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

  const tiles = () => [
    ...container.querySelectorAll("section[aria-label='Home status'] button"),
  ];

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

    expect(tiles().map((each) => each.textContent)).toEqual([
      "Environment19.5–21.5°",
      "Lights1 on",
      "Switches1 on",
    ]);
    expect(tiles()[0]?.getAttribute("aria-label")).toBe(
      "Environment, 19.5 to 21.5°",
    );
    await click(tiles()[0] as HTMLElement);
    expect(openCategory).toHaveBeenCalledWith("environment");
  });

  it("ends with Batteries while a battery is to replace, which opens Maintenance", async () => {
    openMaintenance.mockReset();
    devices = [
      lamp,
      { ...sensor("hall", "hall", 19.5, 58), battery: 8 },
      { ...sensor("desk", "office", 21.5, 48), battery: 4 },
    ];
    await showStatus();

    expect(tiles().map((each) => each.textContent)).toEqual([
      "Environment19.5–21.5°",
      "Lights1 on",
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
    expect(tiles().at(-1)?.textContent).toBe("hall sensorBattery 8%");
    devices = [lamp, { ...sensor("hall", "hall", 19.5, 58), battery: 10 }];
    await showStatus();
    expect(tiles().map((each) => each.textContent)).toEqual([
      "Environment19.5°",
      "Lights1 on",
    ]);
  });

  it("has only the categories the home has, and says when no sensor reads anything", async () => {
    devices = [lamp, sensor("hall", "hall", 19.5, 58, "offline")];
    await showStatus();

    expect(tiles().map((each) => each.textContent)).toEqual([
      "EnvironmentNo readings",
      "Lights1 on",
      // The sensor that doesn't answer needs attention.
      "hall sensorOffline",
    ]);
  });

  it("ends with what needs attention, by name for one device, opening Settings", async () => {
    openAttention.mockReset();
    devices = [lamp, { ...hallLight, availability: "offline" }];
    await showStatus();

    const attention = tiles().at(-1)!;
    expect(attention.textContent).toBe("CeilingOffline");
    expect(attention.getAttribute("aria-label")).toBe("Ceiling is offline");
    // A problem's sign is red.
    expect(attention.querySelector("svg")?.getAttribute("style")).toContain(
      "var(--danger)",
    );
    await click(attention as HTMLElement);
    expect(openAttention).toHaveBeenCalledOnce();
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
    expect(tiles().at(-1)?.textContent).toBe("Attention2 devices");
    expect(tiles().at(-1)?.getAttribute("aria-label")).toBe(
      "Attention, 2 devices: Hall plug isn't paired any more, Desk lamp is offline",
    );

    devices = [lamp, loose];
    await showStatus();
    expect(tiles().at(-1)?.textContent).toBe("LooseNo room");
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
    expect(tiles().map((each) => each.textContent)).toEqual([
      "Environment19.5°",
      "Lights1 on",
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
    expect(
      tiles()
        .map((each) => each.textContent)
        .slice(-2),
    ).toEqual(["CeilingOffline", "hall sensorBattery 8%"]);
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
      expect(tiles().map((each) => each.textContent)).toEqual([
        "Environment19.5°",
      ]);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(tiles().map((each) => each.textContent)).toEqual([
        "EnvironmentNo readings",
        "hall sensorGone quiet",
      ]);
    } finally {
      await act(async () => root.render(null));
      vi.useRealTimers();
    }
  });
});
