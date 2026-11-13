// @vitest-environment jsdom
import type {
  DeviceInfo,
  JoinedDevice,
  PairingInfo,
} from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import { CoreError, coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import { pressShownMs } from "../src/settings-devices";
import type { OnHome } from "../src/dashboards";
import { unknownHome } from "./home-fixtures";
import {
  light,
  macbook,
  maya,
  office,
  places,
  remote,
  zigbee,
} from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

function pendingReply<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Settings → Devices", () => {
  let root: Root;
  let container: HTMLDivElement;
  let devices: DeviceInfo[];
  // What is on Home, and what Settings asked of it.
  let home: OnHome;
  let homeChanges: string[];
  // Whether the devices keep their history.
  let kept: boolean;
  let pairing: PairingInfo;
  let requests: { path: string; json?: unknown }[];
  let removal: (json: { force: boolean }) => void;
  const live = createLiveFeed();

  beforeEach(() => {
    homeChanges = [];
    home = {
      ...unknownHome,
      devices: ["desk"],
      add: async (device) => void homeChanges.push(`add ${device}`),
      remove: async (device) => void homeChanges.push(`remove ${device}`),
    };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    devices = [light("desk", "Light")];
    kept = true;
    pairing = { until: null, joined: [] };
    requests = [];
    removal = () => undefined;
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      requests.push({ path, json: init.json });
      // Settings shows the activity log's newest entries too.
      if (path.startsWith("/api/activity?"))
        return { entries: [], more: false };
      switch (path) {
        case "/api/devices":
          return devices;
        case "/api/places":
          return places;
        case "/api/devices/update": {
          const { id, ...changes } = init.json as { id: string };
          const device = { ...devices.find((each) => each.id === id)! };
          return Object.assign(device, changes);
        }
        case "/api/devices/remove":
          removal(init.json as { force: boolean });
          return { id: (init.json as { id: string }).id };
        case "/api/devices/pairing/open":
          pairing = { ...pairing, until: "2026-10-29T12:04:00.000Z" };
          return { ...pairing, since: "2026-10-29T12:00:00.000Z" };
        case "/api/devices/pairing/close":
          pairing = { ...pairing, until: null };
          return pairing;
        case "/api/devices/pairing":
          return pairing;
        case "/api/history/devices":
          return devices.map((each) => ({ device: each.id, kept }));
        case "/api/history/keep":
          kept = (init.json as { kept: boolean }).kept;
          return init.json;
        // What the rest of Settings asks for.
        case "/api/places/home":
          return { name: "Home", timeZone: null, coordinates: null };
        case "/api/auth/clients":
        case "/api/people":
        case "/api/entities":
          return [];
        default:
          return {};
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function show(me: Me) {
    await act(async () =>
      root.render(
        <SettingsPage
          page="main"
          params={{}}
          open={() => undefined}
          back={() => undefined}
          apps={[zigbee]}
          me={me}
          core={{ state: "online", version: "1.2.3" } as never}
          live={live}
          devices={{ devices: [], places: undefined }}
          home={home}
          onUpdating={() => undefined}
        />,
      ),
    );
  }

  const admin: Me = { client: macbook, person: maya };

  // Sets an input's value the way typing does, so React sees it.
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // A button in the open dialog, if there is one: other sections of
  // Settings have buttons of the same name, such as Household's Save.
  function button(name: string) {
    const scope = document.querySelector("[role=dialog]") ?? document;
    return [...scope.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
  }

  async function choose(menu: string, item: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${menu}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const found = [
      ...document.querySelectorAll<HTMLElement>(
        "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]",
      ),
    ].find((candidate) => candidate.textContent === item)!;
    await act(async () => found.click());
  }

  it("is for every client, shared ones too", async () => {
    await show(admin);
    expect(container.textContent).toContain("Devices");
    expect(container.textContent).toContain("Add devices");

    await show({
      client: { ...macbook, kind: "shared", personId: null },
      person: null,
    } as unknown as Me);
    expect(container.textContent).toContain("Add devices");
  });

  it("lists the devices and follows them live", async () => {
    await show(admin);
    expect(container.textContent).toContain("Light");
    expect(container.textContent).toContain(
      "No room · Hue Essential White and Color Ambiance A60",
    );

    await act(async () =>
      live.publish({
        type: "device",
        id: "desk",
        device: light("desk", "Office light", { roomId: "office" }),
      }),
    );
    expect(container.textContent).toContain("Office light");

    await act(async () =>
      live.publish({ type: "device", id: "desk", device: null }),
    );
    expect(container.textContent).toContain("No devices yet.");
  });

  it("lists a device with a part of a kind this build does not know", async () => {
    // As a core newer than this build might serve it.
    const valve = { ...light("x", "x").capabilities[0]!, kind: "valve" };
    const withValve = (device: DeviceInfo, own = device.capabilities) =>
      ({ ...device, capabilities: [...own, valve] }) as unknown as DeviceInfo;
    devices = [
      withValve(light("desk", "Light")),
      withValve(light("tap", "Garden tap"), []),
    ];
    await show(admin);
    expect(container.textContent).toContain("Light");
    expect(container.textContent).toContain("Garden tap");

    await act(async () =>
      live.publish({
        type: "device",
        id: "drain",
        device: withValve(light("drain", "Drain"), []),
      }),
    );
    expect(container.textContent).toContain("Drain");

    // The device a change answers with is taken the same way.
    await choose("Garden tap: more", "Rename");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    await type(dialog.querySelector("input")!, "Hose");
    await act(async () => button("Save").click());
    expect(container.textContent).toContain("Hose");
  });

  it("shows a remote's presses as they happen, for a few seconds", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    devices = [light("desk", "Light"), remote];
    await show(admin);
    const press = (action: string) =>
      act(async () =>
        live.publish({
          type: "press",
          device: "remote",
          capability: "button",
          action,
          at: "2026-10-29T12:00:00.000Z",
          isCaptured: false,
        }),
      );
    expect(container.textContent).toContain("Office · Wireless mini switch");
    expect(container.textContent).not.toContain("just now");

    await press("single");
    expect(container.textContent).toContain(
      "Office · Wireless mini switch · Single press just now",
    );
    await act(async () => vi.advanceTimersByTime(pressShownMs - 1_000));
    await press("double");
    await act(async () => vi.advanceTimersByTime(pressShownMs - 1_000));
    expect(container.textContent).toContain("Double press just now");

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.textContent).not.toContain("just now");
  });

  it("keeps what changed live while the list was being read", async () => {
    let answer!: (value: DeviceInfo[]) => void;
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) =>
      path === "/api/devices"
        ? new Promise((resolve) => (answer = resolve as typeof answer))
        : original(path, init),
    );
    await show(admin);

    await act(async () => {
      live.publish({
        type: "device",
        id: "desk",
        device: light("desk", "Office light", { roomId: "office" }),
      });
      live.publish({
        type: "places",
        places: { ...places, rooms: [{ ...office, name: "Study" }] },
      });
    });
    // The answer was read before both changes.
    await act(async () =>
      answer([light("desk", "Light"), light("lamp", "Light 2")]),
    );

    expect(container.textContent).toContain("Office light");
    expect(container.textContent).toContain("Study · Hue");
    expect(container.textContent).toContain("Light 2");
    expect(container.textContent).not.toMatch(/Light(?! 2)No room/);
  });

  it("renames a device, and an empty name names it after its room", async () => {
    await show(admin);
    await choose("Light: more", "Rename");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    await type(dialog.querySelector("input")!, "  ");
    await act(async () => button("Save").click());

    expect(requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "desk", name: null },
    });
  });

  it("shows a device on Home from its menu, or no longer", async () => {
    await show(admin);
    const item = async () => {
      await act(async () =>
        document
          .querySelector('button[aria-label="Light: more"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          ),
      );
      return [
        ...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]"),
      ].find((candidate) => candidate.textContent === "Show on Home")!;
    };

    expect((await item()).getAttribute("aria-checked")).toBe("true");
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await choose("Light: more", "Show on Home");
    expect(homeChanges).toEqual(["remove desk"]);

    home = { ...home, devices: [] };
    await show(admin);
    await choose("Light: more", "Show on Home");
    expect(homeChanges).toEqual(["remove desk", "add desk"]);
  });

  it("stops keeping a device's history once asked, which deletes it, and keeps it again", async () => {
    await show(admin);
    await choose("Light: more", "Keep history");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain("Stop keeping Light's history?");
    expect(dialog.textContent).toContain(
      "Sanctum deletes what it has kept of it",
    );
    await act(async () => button("Delete history").click());
    expect(requests).toContainEqual({
      path: "/api/history/keep",
      json: { device: "desk", kept: false },
    });

    await choose("Light: more", "Keep history");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(requests.at(-1)).toEqual({
      path: "/api/history/keep",
      json: { device: "desk", kept: true },
    });
  });

  it("offers history settings for a device added while Settings is open", async () => {
    await show(admin);
    const added = light("bulb", "Light 2");
    devices = [...devices, added];
    await act(async () => {
      live.publish({ type: "device", id: added.id, device: added });
    });
    await choose("Light 2: more", "Keep history");
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "Stop keeping Light 2's history?",
    );
  });

  it("keeps a history choice made while the list was being read", async () => {
    await show(admin);
    let answer!: (value: unknown) => void;
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) =>
      path === "/api/history/devices"
        ? new Promise((resolve) => (answer = resolve))
        : original(path, init),
    );
    await act(async () => live.refresh());

    await choose("Light: more", "Keep history");
    await act(async () => button("Delete history").click());
    // The answer was read before the choice.
    await act(async () => answer([{ device: "desk", kept: true }]));

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Light: more"]',
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(
      [...document.querySelectorAll("[role=menuitemcheckbox]")]
        .find((item) => item.textContent === "Keep history")
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("removes a device, and by force once its driver could not", async () => {
    await show(admin);
    removal = ({ force }) => {
      if (!force) throw new CoreError(500, "app_failed");
    };
    await choose("Light: more", "Remove");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain(
      "It leaves the Zigbee network and Sanctum forgets it",
    );

    await act(async () => button("Remove").click());
    expect(dialog.textContent).toContain("Light did not answer");
    await act(async () => button("Remove anyway").click());

    expect(
      requests.filter((each) => each.path === "/api/devices/remove"),
    ).toEqual([
      { path: "/api/devices/remove", json: { id: "desk", force: false } },
      { path: "/api/devices/remove", json: { id: "desk", force: true } },
    ]);
    expect(container.textContent).toContain("No devices yet.");
  });

  it("does not offer force for another device when an earlier removal fails late", async () => {
    devices.push(light("second", "Light 2"));
    await show(admin);
    await choose("Light: more", "Remove");
    const answer = pendingReply<never>();
    vi.mocked(coreJson).mockImplementationOnce(() => answer.promise);
    await act(async () => button("Remove").click());
    await act(async () => button("Cancel").click());
    await choose("Light 2: more", "Remove");
    await act(async () => answer.reject(new CoreError(500, "app_failed")));
    expect(button("Remove anyway")).toBeUndefined();
    expect(document.querySelector("[role=dialog]")!.textContent).toContain(
      "Remove Light 2?",
    );
    await act(async () => button("Remove").click());
    expect(requests).toContainEqual({
      path: "/api/devices/remove",
      json: { id: "second", force: false },
    });
  });

  it("does not close a later dialog when an earlier removal succeeds late", async () => {
    devices.push(light("second", "Light 2"));
    await show(admin);
    await choose("Light: more", "Remove");
    const answer = pendingReply<{ id: string }>();
    vi.mocked(coreJson).mockImplementationOnce(() => answer.promise);
    await act(async () => button("Remove").click());
    await act(async () => button("Cancel").click());
    await choose("Light 2: more", "Rename");
    await act(async () => answer.resolve({ id: "desk" }));
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "Rename this device",
    );
  });

  it("finishes an earlier pairing open and close before reopening", async () => {
    const render = (open: boolean) =>
      act(async () =>
        root.render(
          <AddDevices
            open={open}
            onOpenChange={() => undefined}
            devices={devices}
            rooms={[office]}
            live={live}
            onChanged={() => undefined}
          />,
        ),
      );
    const answer = pendingReply<PairingInfo & { since: string }>();
    vi.mocked(coreJson).mockImplementationOnce(() => answer.promise);
    await render(true);
    await render(false);
    await render(true);
    await act(async () =>
      answer.resolve({
        until: "2026-10-29T12:04:00.000Z",
        joined: [],
        since: "2026-10-29T12:00:00.000Z",
      }),
    );
    expect(
      requests
        .filter((each) => each.path.startsWith("/api/devices/pairing"))
        .map((each) => each.path),
    ).toEqual(["/api/devices/pairing/close", "/api/devices/pairing/open"]);
    expect(pairing.until).not.toBeNull();
  });

  it("says when Done cannot stop pairing, then closes anyway", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    vi.mocked(coreJson).mockRejectedValueOnce(new CoreError(500, "app_failed"));
    await act(async () => button("Done").click());
    expect(
      document.querySelector("[role=dialog] [role=alert]")?.textContent,
    ).toBe(
      "Sanctum could not stop new devices joining. They can until the time is up.",
    );
    expect(pairing.until).not.toBeNull();

    // Never stuck: the network closes by itself, and leaving tries once more.
    await act(async () => button("Close anyway").click());
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(pairing.until).toBeNull();
  });

  it("lets devices join while adding them, and names each as it is ready", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    expect(requests).toContainEqual({
      path: "/api/devices/pairing/open",
      json: {},
    });
    expect(dialog.textContent).toContain("New devices can join for 4:00.");
    expect(dialog.textContent).toContain("Looking for new devices…");
    await act(async () => vi.advanceTimersByTime(8_000));
    expect(dialog.textContent).toContain("New devices can join for 3:52.");

    const joining: JoinedDevice = {
      driver: "sanctum.zigbee",
      key: "0x0017880102b3c4d5",
      stage: "interviewing",
      description: null,
      deviceId: null,
      known: false,
      joinedAt: "2026-10-29T12:00:05.000Z",
    };
    // One that joined before this dialog opened is not this one's.
    const earlier = {
      ...joining,
      key: "0x2",
      joinedAt: "2026-10-29T11:30:00Z",
    };
    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: { ...pairing, joined: [earlier, joining] },
      }),
    );
    expect(dialog.textContent).toContain("New device");
    expect(dialog.textContent).toContain("Setting up…");
    expect(dialog.querySelectorAll("li")).toHaveLength(1);

    const added = light("bulb", "Light 2");
    devices = [...devices, added];
    await act(async () => {
      live.publish({ type: "device", id: "bulb", device: added });
      live.publish({
        type: "pairing",
        pairing: {
          ...pairing,
          joined: [
            {
              ...joining,
              stage: "ready",
              deviceId: "bulb",
              description: "Hue Essential White and Color Ambiance A60",
            },
          ],
        },
      });
    });
    const name = dialog.querySelector<HTMLInputElement>(
      'input[aria-label="Name for Hue Essential White and Color Ambiance A60"]',
    )!;
    expect(name.value).toBe("Light 2");
    expect(dialog.textContent).toContain("Ready");

    await type(name, "Desk lamp");
    await act(async () =>
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    // Saved, it goes by its new name.
    await choose("Desk lamp: room", "Office");
    expect(requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "bulb", name: "Desk lamp" },
    });
    expect(requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "bulb", roomId: "office" },
    });

    await act(async () => button("Stop").click());
    expect(dialog.textContent).toContain("New devices can no longer join.");
    expect(button("Look again")).toBeDefined();
    await act(async () => button("Done").click());
    expect(
      requests.filter((each) => each.path === "/api/devices/pairing/close"),
    ).toHaveLength(2);
  });

  it("names a device the home has while it is set up again", async () => {
    await show(admin);
    await act(async () => button("Add devices").click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;

    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: {
          ...pairing,
          joined: [
            {
              driver: "sanctum.zigbee",
              key: "0x0017880102b3c4d5",
              stage: "interviewing",
              description: "Hue Essential White and Color Ambiance A60",
              deviceId: "desk",
              known: true,
              joinedAt: "2026-10-29T12:00:05.000Z",
            },
          ],
        },
      }),
    );

    expect(dialog.querySelector("li")!.textContent).toBe(
      "LightHue Essential White and Color Ambiance A60 · Setting up…",
    );
  });

  it("says when nothing can let devices join", async () => {
    await show(admin);
    vi.mocked(coreJson).mockImplementationOnce(async () => {
      throw new CoreError(503, "unavailable");
    });

    await act(async () => button("Add devices").click());

    expect(
      document.querySelector("[role=dialog] [role=alert]")!.textContent,
    ).toBe("No app that adds devices is running.");
  });

  it("deducts the time spent waiting for the radio from the countdown", async () => {
    await show(admin);
    const answer = pendingReply<PairingInfo & { since: string }>();
    vi.mocked(coreJson).mockImplementationOnce(() => answer.promise);
    await act(async () => button("Add devices").click());
    await act(async () => vi.advanceTimersByTime(3000));
    await act(async () =>
      answer.resolve({
        until: "2026-10-29T12:04:00.000Z",
        joined: [],
        since: "2026-10-29T12:00:00.000Z",
      }),
    );
    expect(document.querySelector("[role=dialog]")!.textContent).toContain(
      "New devices can join for 3:57.",
    );
  });
});
