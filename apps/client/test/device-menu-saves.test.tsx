// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import type { OnHome } from "../src/dashboards";
import { DevicesSection } from "../src/settings-devices";
import { unknownHome } from "./home-fixtures";
import { light, places, zigbee } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

// What a device's menu in Settings → Devices saves: its room, what it is
// shown as, whether it shows on Home and whether its history is kept. One
// that could not be saved says so on the device's line, and a late answer
// never undoes what is newer.

// Shown as a contact sensor, so its menu has Show as, with a part whose
// history can be kept.
const sensor: DeviceInfo = {
  ...light("contact", "Hall contact sensor"),
  type: "contact",
};
const unreachable = "Can't reach Sanctum. Try again.";

describe("what a device's menu saves", () => {
  let root: Root;
  let container: HTMLDivElement;
  const live = createLiveFeed();
  // Each waiting save of the device, to answer or to fail.
  let saves: {
    json: Record<string, unknown>;
    answer: (device: DeviceInfo) => void;
    fail: (error: Error) => void;
  }[];
  // Whether Home and History refuse what they are asked.
  let refusing: boolean;
  let home: OnHome;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    saves = [];
    refusing = false;
    home = {
      ...unknownHome,
      devices: [],
      add: async () => {
        if (refusing) throw new TypeError("Failed to fetch");
      },
      remove: async () => undefined,
    };
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      switch (path) {
        case "/api/devices":
          return [sensor];
        case "/api/places":
          return places;
        case "/api/history/devices":
          return [{ device: sensor.id, kept: false }];
        case "/api/history/keep":
          if (refusing) throw new TypeError("Failed to fetch");
          return init.json;
        case "/api/devices/pairing":
          return { until: null, found: [], drivers: [], joined: [] };
        case "/api/devices/update":
          return new Promise<DeviceInfo>((answer, fail) =>
            saves.push({
              json: init.json as Record<string, unknown>,
              answer,
              fail,
            }),
          );
        default:
          throw new Error(`Unexpected request: ${path}`);
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

  const enter = (element: Element) =>
    act(async () => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

  async function show() {
    await act(async () => {
      root.render(<DevicesSection apps={[zigbee]} live={live} home={home} />);
    });
  }

  const items = (role: string) => [
    ...document.querySelectorAll<HTMLElement>(`[role=${role}]`),
  ];

  async function openMenu() {
    await enter(
      document.querySelector(`button[aria-label="${sensor.name}: more"]`)!,
    );
  }

  // An entry one level down, as a room and what it is shown as are.
  async function choose(entry: string, option: string) {
    await openMenu();
    await enter(items("menuitem").find((item) => item.textContent === entry)!);
    await act(async () => {
      items("menuitemradio")
        .find((item) => item.textContent === option)!
        .click();
    });
  }

  async function tick(entry: string) {
    await openMenu();
    await act(async () => {
      items("menuitemcheckbox")
        .find((item) => item.textContent === entry)!
        .click();
    });
  }

  const line = () => container.querySelector("li")!.textContent;
  const announced = () => container.querySelector("[role=status]")?.textContent;
  const office = places.rooms[0]!;

  it("says so on the device's line when its room could not be saved, until the next try", async () => {
    await show();
    await choose("Room", office.name);
    expect(saves[0]!.json).toEqual({ id: sensor.id, roomId: office.id });
    await act(async () => saves[0]!.fail(new TypeError("Failed to fetch")));
    expect(line()).toContain(unreachable);
    expect(announced()).toBe(unreachable);

    await choose("Room", office.name);
    expect(line()).not.toContain(unreachable);
    await act(async () => saves[1]!.answer({ ...sensor, roomId: office.id }));
    expect(line()).toContain(office.name);
  });

  it("keeps a newer device received live when its room's save answers late", async () => {
    await show();
    await choose("Room", office.name);
    await act(async () => {
      live.publish({
        type: "device",
        id: sensor.id,
        device: { ...sensor, name: "Hall door", roomId: office.id },
      });
    });
    await act(async () => saves[0]!.answer({ ...sensor, roomId: office.id }));
    expect(line()).toContain("Hall door");
  });

  it("says nothing of an earlier room that fails after a later one was saved", async () => {
    await show();
    await choose("Room", office.name);
    await choose("Room", "No room");
    await act(async () => saves[1]!.answer({ ...sensor, roomId: null }));
    await act(async () => saves[0]!.fail(new TypeError("Failed to fetch")));
    expect(line()).not.toContain(unreachable);
  });

  it("still says a choice of another kind failed after a later save of the device", async () => {
    await show();
    await choose("Show as", "Door");
    await choose("Room", office.name);
    await act(async () => saves[1]!.answer({ ...sensor, roomId: office.id }));
    await act(async () => saves[0]!.fail(new TypeError("Failed to fetch")));
    // The room was saved; what it is shown as was not, and says so.
    expect(line()).toContain(office.name);
    expect(line()).toContain(unreachable);
  });

  it("says so when it could not be shown on Home", async () => {
    await show();
    refusing = true;
    await tick("Show on Home");
    await act(async () => {});
    expect(line()).toContain(unreachable);
    expect(announced()).toBe(unreachable);
  });

  it("says so when its history could not be kept", async () => {
    await show();
    refusing = true;
    await tick("Keep history");
    await act(async () => {});
    expect(line()).toContain(unreachable);
    expect(announced()).toBe(unreachable);
  });
});
