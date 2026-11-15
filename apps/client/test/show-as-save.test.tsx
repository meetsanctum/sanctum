// @vitest-environment jsdom
import type { DeviceInfo, PairingInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { DevicesSection } from "../src/settings-devices";
import { unknownHome } from "./home-fixtures";
import { light, places, zigbee } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const sensor = light("contact", "Hall contact sensor", {
  type: "contact",
  capabilities: [],
});
const door: DeviceInfo = {
  ...sensor,
  type: "door",
  shownAs: "door",
  name: "Hall door",
};
const windowDevice: DeviceInfo = {
  ...sensor,
  type: "window",
  shownAs: "window",
  name: "Hall window",
};

describe.each(["Settings", "Add devices"])("saving Show as in %s", (where) => {
  let root: Root;
  let container: HTMLDivElement;
  const live = createLiveFeed();
  let replies: ((device: DeviceInfo) => void)[];
  // Each waiting save's way to fail, beside its reply.
  let refusals: ((error: Error) => void)[];
  // What the next save fails with, if it is to fail.
  let failure: Error | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    replies = [];
    refusals = [];
    failure = undefined;
    const since = new Date().toISOString();
    const pairing: PairingInfo = {
      until: null,
      found: [],
      drivers: [zigbee.id],
      joined: [
        {
          driver: zigbee.id,
          key: sensor.id,
          stage: "ready",
          deviceId: sensor.id,
          known: false,
          description: null,
          joinedAt: since,
        },
      ],
    };
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path) => {
      switch (path) {
        case "/api/devices":
          return [sensor];
        case "/api/places":
          return places;
        case "/api/history/devices":
          return [];
        case "/api/devices/pairing":
        case "/api/devices/pairing/close":
          return pairing;
        case "/api/devices/pairing/open":
          return { ...pairing, since };
        case "/api/devices/update":
          if (failure) throw failure;
          return new Promise<DeviceInfo>((resolve, reject) => {
            replies.push(resolve);
            refusals.push(reject);
          });
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
      root.render(
        <DevicesSection apps={[zigbee]} live={live} home={unknownHome} />,
      );
    });
    if (where === "Add devices") {
      await act(async () => {
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Add devices")!
          .click();
      });
    }
  }

  async function choose(title: string) {
    const label = where === "Settings" ? "more" : "show as";
    await enter(
      document.querySelector(`button[aria-label="${sensor.name}: ${label}"]`)!,
    );
    if (where === "Settings") {
      await enter(
        [...document.querySelectorAll("[role=menuitem]")].find(
          (item) => item.textContent === "Show as",
        )!,
      );
    }
    await act(async () => {
      [...document.querySelectorAll<HTMLElement>("[role=menuitemradio]")]
        .find((item) => item.textContent === title)!
        .click();
    });
  }

  it("keeps a newer device received live when the save answers late", async () => {
    await show();
    await choose("Door");
    expect(coreJson).toHaveBeenCalledWith("/api/devices/update", {
      method: "POST",
      json: { id: sensor.id, shownAs: "door" },
    });
    await act(async () => {
      live.publish({ type: "device", id: sensor.id, device: windowDevice });
    });
    await act(async () => replies[0]!(door));
    expect(container.textContent).toContain("Hall window");
    expect(container.textContent).not.toContain("Hall door");
  });

  it("keeps a device removed while its save was waiting out of the list", async () => {
    await show();
    await choose("Door");
    await act(async () => {
      live.publish({ type: "device", id: sensor.id, device: null });
    });
    await act(async () => replies[0]!(door));
    expect(container.textContent).toContain("No devices yet.");
    expect(container.textContent).not.toContain("Hall door");
  });

  it("keeps the latest choice when an earlier save answers last", async () => {
    await show();
    await choose("Door");
    await choose("Window");
    await act(async () => replies[1]!(windowDevice));
    await act(async () => replies[0]!(door));
    expect(container.textContent).toContain("Hall window");
    expect(container.textContent).not.toContain("Hall door");
  });

  it("says so when a save fails, until the next try", async () => {
    await show();
    failure = new TypeError("Failed to fetch");
    await choose("Door");
    // On the device's line in Settings, and in the dialog while adding.
    const said = () =>
      (where === "Settings"
        ? container.querySelector("li")!
        : document.querySelector("[role=dialog]")!
      ).textContent;
    expect(said()).toContain("Can't reach Sanctum. Try again.");
    expect(container.textContent).not.toContain("Hall door");
    if (where === "Settings") {
      expect(container.querySelector("[role=status]")?.textContent).toBe(
        "Can't reach Sanctum. Try again.",
      );
    }

    failure = undefined;
    await choose("Door");
    expect(said()).not.toContain("Can't reach Sanctum. Try again.");
    await act(async () => replies[0]!(door));
    expect(container.textContent).toContain("Hall door");
  });

  it("says nothing of an earlier save that fails after a later one was saved", async () => {
    await show();
    await choose("Door");
    await choose("Window");
    await act(async () => replies[1]!(windowDevice));
    await act(async () => refusals[0]!(new TypeError("Failed to fetch")));
    expect(document.body.textContent).toContain("Hall window");
    expect(document.body.textContent).not.toContain(
      "Can't reach Sanctum. Try again.",
    );
  });

  if (where === "Add devices") {
    it.each([false, true])(
      "finishes a save after closing the dialog unless a live update overtook it (%s)",
      async (hasLiveUpdate) => {
        await show();
        await choose("Door");
        await act(async () => {
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              "[role=dialog] button",
            ),
          ]
            .find((button) => button.textContent === "Done")!
            .click();
        });
        expect(document.querySelector("[role=dialog]")).toBeNull();
        if (hasLiveUpdate) {
          await act(async () => {
            live.publish({
              type: "device",
              id: sensor.id,
              device: windowDevice,
            });
          });
        }
        await act(async () => replies[0]!(door));
        expect(container.textContent).toContain(
          hasLiveUpdate ? "Hall window" : "Hall door",
        );
      },
    );
  }
});
