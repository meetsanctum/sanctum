// @vitest-environment jsdom
import type {
  AppInfo,
  DeviceInfo,
  FoundDevice,
  PairingInfo,
} from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddDevices } from "../src/add-devices";
import { CoreError, coreJson } from "../src/core-fetch";
import { light, office, zigbee } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

// Add devices with what drivers found: an example driver's sensor that asks
// nothing and its plug that asks for its key, beside Zigbee letting devices
// join.

const example: AppInfo = { ...zigbee, id: "sanctum.example", name: "Example" };
const key = {
  id: "key",
  label: "Encryption key",
  kind: "secret" as const,
  help: "Under api: encryption: key in its configuration.",
  placeholder: null,
  refusals: { wrongKey: "That key doesn't match. Copy it again." },
};
const sensor: FoundDevice = {
  driver: "sanctum.example",
  key: "kitchen",
  name: "Kitchen sensor",
  description: "temperature, humidity, motion",
  type: "sensor",
  asks: [],
  refusals: {
    notWaiting:
      "It stopped waiting for a key. Turn it off and on again, then add it.",
  },
};
const plug: FoundDevice = {
  driver: "sanctum.example",
  key: "living-room",
  name: "Living room plug",
  description: "needs its encryption key",
  type: null,
  asks: [key],
  refusals: {},
};

describe("Add devices, with what drivers found", () => {
  let root: Root;
  let container: HTMLDivElement;
  let devices: DeviceInfo[];
  let adding: PairingInfo;
  let requests: { path: string; json?: unknown }[];
  // What adding a device answers, by its key.
  let answers: Record<string, (json: { answers: object }) => unknown>;
  const live = createLiveFeed();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    devices = [];
    adding = {
      until: null,
      joined: [],
      drivers: ["sanctum.zigbee"],
      finders: [],
      offers: [],
      found: [sensor, plug],
    };
    requests = [];
    answers = {};
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      requests.push({ path, json: init.json });
      switch (path) {
        case "/api/devices/pairing/open":
          adding = { ...adding, until: "2026-10-29T12:04:00.000Z" };
          return { ...adding, since: "2026-10-29T12:00:00.000Z" };
        case "/api/devices/pairing/close":
          adding = { ...adding, until: null };
          return adding;
        case "/api/devices/add": {
          const body = init.json as { key: string; answers: object };
          return answers[body.key]!(body);
        }
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

  async function show(
    onChanged: (device: DeviceInfo) => void = () => {},
    includeAdding = true,
  ) {
    await act(async () =>
      root.render(
        <AddDevices
          open
          onOpenChange={() => undefined}
          devices={devices}
          rooms={[office]}
          apps={[zigbee, example]}
          adding={includeAdding ? adding : undefined}
          live={live}
          onChanged={onChanged}
        />,
      ),
    );
    return document.querySelector<HTMLElement>("[role=dialog]")!;
  }

  // The overlay's page, under its title.
  const page = () =>
    document.querySelector<HTMLElement>(
      "[role=dialog] [data-slot=overlay-content]",
    )!;

  // Chooses a way to add devices on the first page, by its name.
  async function way(name: string) {
    const card = [
      ...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
    ].find((candidate) => candidate.textContent?.startsWith(name));
    await act(async () => card!.click());
  }

  it("asks what you are adding, with what was found and each radio", async () => {
    await show();

    expect(page().querySelector("h3")!.textContent).toBe(
      "What are you adding?",
    );
    expect(
      [...page().querySelectorAll("li")].map((card) => card.textContent),
    ).toEqual([
      "Devices foundAlready on your Wi‑Fi2 foundStart",
      "ZigbeeLights, sensors and remotesStart",
    ]);
    // Nothing joins until a radio is chosen.
    expect(requests).toEqual([]);
  });

  it("offers what was found while a driver finds devices, though nothing is found yet", async () => {
    adding = { ...adding, finders: ["sanctum.example"], found: [] };
    await show();

    expect(page().querySelector("li")!.textContent).toBe(
      "Devices foundAlready on your Wi‑FiNone foundStart",
    );
    await way("Devices found");
    expect(page().textContent).toContain(
      "Nothing found yet. Check your device is switched on and connected to your Wi‑Fi.",
    );
  });

  it("says what to plug in where the home never had a Zigbee adapter, and otherwise that nothing adds devices", async () => {
    // No app lets devices join: Zigbee waits for its adapter.
    adding = { ...adding, drivers: [], found: [] };
    const render = (notSetUp?: Parameters<typeof AddDevices>[0]["notSetUp"]) =>
      act(async () =>
        root.render(
          <AddDevices
            open
            onOpenChange={() => undefined}
            devices={[]}
            rooms={[office]}
            apps={[
              {
                ...zigbee,
                state: "waiting",
                run: {
                  since: "2026-10-29T12:00:00.000Z",
                  waitingFor: "Waiting for Zigbee2MQTT",
                  ownWait: true,
                },
              },
            ]}
            adding={adding}
            notSetUp={notSetUp}
            live={live}
            onChanged={() => {}}
          />,
        ),
      );

    await render([
      {
        service: "zigbee2mqtt",
        problem: "No Zigbee coordinator is plugged in",
        apps: ["sanctum.zigbee"],
      },
    ]);
    // Its card stays in place, dimmed, saying what to plug in.
    const card = page().querySelector("button")!;
    expect(card.textContent).toBe(
      "ZigbeePlug in a Zigbee adapter to add Zigbee devices.Not set upStart",
    );
    expect(card.disabled).toBe(true);
    expect(page().querySelector("[role=alert]")).toBeNull();

    await render();
    expect(page().querySelector("[role=alert]")?.textContent).toBe(
      "No app that adds devices is running.",
    );
    expect(page().textContent).not.toContain("Plug in a Zigbee adapter");
  });

  it.each(["off", "paused", "failed", "stopped", "waiting"] as const)(
    "does not suggest an adapter when the app is %s for a reason of the core's",
    async (state) => {
      adding = { ...adding, drivers: [], found: [] };
      await act(async () =>
        root.render(
          <AddDevices
            open
            onOpenChange={() => undefined}
            devices={[]}
            rooms={[office]}
            apps={[
              {
                ...zigbee,
                state,
                run: {
                  since: "2026-10-29T12:00:00.000Z",
                  waitingFor: "Waiting for its data to come back",
                },
              },
            ]}
            adding={adding}
            notSetUp={[
              {
                service: "zigbee2mqtt",
                problem: "No Zigbee coordinator is plugged in",
                apps: [zigbee.id],
              },
            ]}
            live={live}
            onChanged={() => {}}
          />,
        ),
      );

      expect(page().querySelector("[role=alert]")?.textContent).toBe(
        "No app that adds devices is running.",
      );
      expect(page().textContent).not.toContain("Plug in a Zigbee adapter");
    },
  );

  function named(label: string) {
    return document.querySelector<HTMLButtonElement>(
      `[role=dialog] button[aria-label="${label}"]`,
    )!;
  }

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const cards = () => [
    ...page().querySelectorAll('[aria-label="Devices found"] > li'),
  ];

  it("shows each found device as a card, saying what it has or what adding it needs", async () => {
    await show();
    await way("Devices found");

    expect(document.querySelector("[role=dialog] h2")!.textContent).toBe(
      "Devices found",
    );
    expect(document.querySelector("[role=dialog]")!.textContent).toContain(
      "2 found",
    );
    expect(cards().map((card) => card.textContent)).toEqual([
      "Kitchen sensortemperature, humidity, motionAdd",
      "Living room plugneeds its encryption keyEncryption keyAddUnder api: encryption: key in its configuration.",
    ]);
    expect(named("Add Kitchen sensor")).not.toBeNull();
  });

  it("adds one that asks nothing at once, and has it named and placed", async () => {
    const added = light("sensor-1", "Kitchen sensor", {
      driver: "sanctum.example",
      driverName: "Kitchen sensor",
    });
    answers.kitchen = () => ({ added });
    const changed = vi.fn();
    await show(changed);
    await way("Devices found");

    await act(async () => named("Add Kitchen sensor").click());

    expect(requests).toContainEqual({
      path: "/api/devices/add",
      json: { driver: "sanctum.example", key: "kitchen", answers: {} },
    });
    expect(changed).toHaveBeenCalledWith(added);
    // Gone from what was found, it keeps its place to be named.
    adding = { ...adding, found: [plug] };
    devices = [added];
    await act(async () => live.publish({ type: "pairing", pairing: adding }));
    await show(changed);
    expect(cards()).toHaveLength(2);
    expect(
      cards()[0]!.querySelector<HTMLInputElement>(
        'input[aria-label="Name for Kitchen sensor"]',
      )!.value,
    ).toBe("Kitchen sensor");
    expect(cards()[0]!.querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("asks a key on its card, says why one is refused and keeps it to correct", async () => {
    answers["living-room"] = ({ answers }) =>
      (answers as { key: string }).key === "the right key"
        ? {
            added: light("plug-1", "Living room plug", {
              driver: "sanctum.example",
              driverName: "Living room plug",
            }),
          }
        : { refused: { question: "key", refusal: "wrongKey" } };
    await show();
    await way("Devices found");

    const field = page().querySelector<HTMLInputElement>(
      "input[type=password]",
    )!;
    expect(field.labels![0]!.textContent).toBe("Encryption key");
    // Nothing goes until it's answered.
    const send = named("Add Living room plug");
    expect(send.disabled).toBe(true);

    await type(field, "a wrong key");
    await act(async () => send.click());
    expect(page().querySelector("[role=alert]")!.textContent).toBe(
      "That key doesn't match. Copy it again.",
    );
    expect(field.value).toBe("a wrong key");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    await type(field, "the right key");
    await act(async () => send.click());
    expect(requests.filter((each) => each.path === "/api/devices/add")).toEqual(
      [
        {
          path: "/api/devices/add",
          json: {
            driver: "sanctum.example",
            key: "living-room",
            answers: { key: "a wrong key" },
          },
        },
        {
          path: "/api/devices/add",
          json: {
            driver: "sanctum.example",
            key: "living-room",
            answers: { key: "the right key" },
          },
        },
      ],
    );
    expect(page().querySelector("input[type=password]")).toBeNull();
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("keeps an add in progress when registration removes it from discovery", async () => {
    const added = light("sensor-1", "Kitchen sensor", {
      driver: "sanctum.example",
      driverName: "Kitchen sensor",
    });
    let finish!: (result: { added: DeviceInfo }) => void;
    answers.kitchen = () => new Promise((resolve) => (finish = resolve));
    const changed = vi.fn();
    await show(changed);
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    // Registration reaches live clients before the add request finishes.
    adding = { ...adding, found: [plug] };
    devices = [added];
    await act(async () => live.publish({ type: "pairing", pairing: adding }));
    await show(changed);
    expect(named("Add Kitchen sensor")?.disabled).toBe(true);
    await act(async () => finish({ added }));

    expect(changed).toHaveBeenCalledWith(added);
    expect(
      page().querySelector('input[aria-label="Name for Kitchen sensor"]'),
    ).not.toBeNull();
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("sends only answers to the questions the driver currently asks", async () => {
    answers["living-room"] = () => ({
      refused: { question: "label", refusal: "wrongKey" },
    });
    await show();
    await way("Devices found");
    await type(
      page().querySelector<HTMLInputElement>("input[type=password]")!,
      "old key",
    );

    adding = {
      ...adding,
      found: [{ ...plug, asks: [{ ...key, id: "label", kind: "text" }] }],
    };
    await show();
    await type(
      page().querySelector<HTMLInputElement>("input[type=text]")!,
      "new answer",
    );
    await act(async () => named("Add Living room plug").click());

    expect(requests.at(-1)).toEqual({
      path: "/api/devices/add",
      json: {
        driver: "sanctum.example",
        key: "living-room",
        answers: { label: "new answer" },
      },
    });
  });

  it("can add after the driver stops asking questions", async () => {
    answers["living-room"] = () => ({
      added: light("plug-1", "Living room plug"),
    });
    await show();
    await way("Devices found");
    await type(
      page().querySelector<HTMLInputElement>("input[type=password]")!,
      "old key",
    );
    adding = { ...adding, found: [{ ...plug, asks: [] }] };
    await show();

    await act(async () => named("Add Living room plug").click());
    expect(requests.at(-1)).toEqual({
      path: "/api/devices/add",
      json: { driver: "sanctum.example", key: "living-room", answers: {} },
    });
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("follows found devices from its own pairing updates", async () => {
    await show(undefined, false);
    await act(async () =>
      live.publish({ type: "pairing", pairing: { ...adding, found: [plug] } }),
    );
    await way("Devices found");

    expect(page().textContent).not.toContain("Kitchen sensor");
    expect(page().textContent).toContain("Living room plug");
  });

  it("keeps a live update that arrives before an older read of its own", async () => {
    let finish!: (info: PairingInfo) => void;
    const answered = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/devices/pairing"
        ? new Promise((done) => (finish = done as never))
        : answered(path, init),
    );
    await show(undefined, false);

    await act(async () => live.refresh());
    await act(async () =>
      live.publish({ type: "pairing", pairing: { ...adding, found: [plug] } }),
    );
    await act(async () => finish({ ...adding, found: [] }));
    await way("Devices found");

    expect(page().textContent).toContain("Living room plug");
  });

  it("offers a radio once its app starts letting devices join", async () => {
    adding = { ...adding, drivers: [] };
    await show();
    expect(page().textContent).not.toContain("Zigbee");

    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: { ...adding, drivers: [zigbee.id] },
      }),
    );

    expect(page().textContent).toContain("ZigbeeLights, sensors and remotes");
  });

  it("says when adding didn't work", async () => {
    answers.kitchen = () => {
      throw new CoreError(504, "timeout");
    };
    await show();
    await way("Devices found");

    await act(async () => named("Add Kitchen sensor").click());

    expect(page().querySelector("[role=alert]")!.textContent).toBe(
      "It didn't answer in time. Check it's switched on, then try again.",
    );
    expect(named("Add Kitchen sensor").disabled).toBe(false);
  });

  it("says why its driver refused adding one that asks nothing", async () => {
    answers.kitchen = () => ({ refused: { refusal: "notWaiting" } });
    await show();
    await way("Devices found");

    await act(async () => named("Add Kitchen sensor").click());

    expect(page().querySelector("[role=alert]")!.textContent).toBe(
      "It stopped waiting for a key. Turn it off and on again, then add it.",
    );
    expect(named("Add Kitchen sensor").disabled).toBe(false);
  });

  it("offers only what was found when no app lets devices join", async () => {
    adding = { ...adding, drivers: [] };

    await show();

    expect(page().querySelectorAll("li")).toHaveLength(1);
    expect(page().querySelector("[role=alert]")).toBeNull();
  });

  it("lets a radio's devices join from its card, and stops them when its page is left", async () => {
    await show();
    await way("Zigbee");

    expect(requests).toContainEqual({
      path: "/api/devices/pairing/open",
      json: { seconds: 240, drivers: ["sanctum.zigbee"] },
    });
    expect(document.querySelector("[role=dialog] h2")!.textContent).toBe(
      "Zigbee",
    );
    expect(page().querySelector("h3")!.textContent).toBe(
      "4:00• left. Looking for devices…",
    );
    expect(page().querySelector("[role=status]")!.textContent).toBe(
      "Looking for devices",
    );

    await act(async () => named("Back to Add devices").click());
    expect(requests.at(-1)?.path).toBe("/api/devices/pairing/close");
    expect(page().querySelector("h3")!.textContent).toBe(
      "What are you adding?",
    );
  });

  it("says when the time is up, and starts again", async () => {
    await show();
    await way("Zigbee");

    await act(async () => vi.advanceTimersByTime(240_000));
    expect(page().querySelector("h3")!.textContent).toBe("Time's up");
    expect(page().textContent).toContain(
      "Zigbee devices can't join right now. Start again to give them another 4 minutes.",
    );

    const again = [...page().querySelectorAll("button")].find(
      (button) => button.textContent === "Start again",
    )!;
    await act(async () => again.click());
    expect(
      requests.filter((each) => each.path === "/api/devices/pairing/open"),
    ).toHaveLength(2);
  });

  async function chooseInMenu(menu: string, item: string) {
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
        "[role=menuitem], [role=menuitemradio]",
      ),
    ].find((candidate) => candidate.textContent === item)!;
    await act(async () => found.click());
  }

  const kitchenSensor = () =>
    light("sensor-1", "Kitchen sensor", {
      driver: "sanctum.example",
      driverName: "Kitchen sensor",
    });

  it("greets a device new to the home once, as its card turns green", async () => {
    const added = kitchenSensor();
    answers.kitchen = () => ({ added });
    devices = [added];
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    expect(page().querySelector(".add-devices-sweep")).not.toBeNull();
    // A light's round glows as a bulb switching on.
    expect(page().querySelector(".add-devices-glow")).not.toBeNull();

    await act(async () => named("Back to Add devices").click());
    await way("Devices found");
    expect(page().querySelector('[aria-label="Added"]')).not.toBeNull();
    expect(page().querySelector(".add-devices-sweep")).toBeNull();
  });

  it("makes a new room in place and puts the device in it", async () => {
    const added = kitchenSensor();
    answers.kitchen = () => ({ added });
    devices = [added];
    const hall = { ...office, id: "hall", name: "Hall" };
    const answered = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      if (path === "/api/places/rooms/add") {
        requests.push({ path, json: init.json });
        return hall;
      }
      const answer = await answered(path, init);
      return path === "/api/devices/update"
        ? { ...added, roomId: hall.id }
        : answer;
    });
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    await chooseInMenu("Kitchen sensor: room", "New room…");
    const field = page().querySelector<HTMLInputElement>("form input")!;
    expect(field.labels![0]!.textContent).toBe("New room");
    expect(document.activeElement).toBe(field);
    await type(field, "Hall");
    await act(async () =>
      [...page().querySelectorAll("button")]
        .find((button) => button.textContent === "Add room")!
        .click(),
    );

    expect(requests).toContainEqual({
      path: "/api/places/rooms/add",
      json: { name: "Hall" },
    });
    expect(requests).toContainEqual({
      path: "/api/devices/update",
      json: { id: "sensor-1", roomId: "hall" },
    });
    // Back to the menu.
    expect(
      [...page().querySelectorAll("label")].map((label) => label.textContent),
    ).not.toContain("New room");
  });

  it("removes a device Sanctum can't use, after asking", async () => {
    const unusable = light("odd", "Unknown Device", { capabilities: [] });
    devices = [unusable];
    adding = {
      ...adding,
      joined: [
        {
          driver: "sanctum.zigbee",
          key: "0x9",
          stage: "ready",
          description: null,
          deviceId: "odd",
          known: false,
          joinedAt: "2026-10-29T12:00:01.000Z",
        },
      ],
    };
    const removed = vi.fn();
    await act(async () =>
      root.render(
        <AddDevices
          open
          onOpenChange={() => undefined}
          devices={devices}
          rooms={[office]}
          apps={[zigbee, example]}
          adding={adding}
          live={live}
          onChanged={() => undefined}
          onRemoved={removed}
        />,
      ),
    );
    await way("Zigbee");

    expect(page().textContent).toContain(
      "Sanctum can't use this device. Keep it in a room, or remove it.",
    );
    await act(async () => named("Remove Unknown Device").click());
    const asking = [...document.querySelectorAll("[role=dialog]")].at(-1)!;
    expect(asking.textContent).toContain("Remove Unknown Device?");
    await act(async () =>
      [...asking.querySelectorAll("button")]
        .find((button) => button.textContent === "Remove")!
        .click(),
    );

    expect(requests).toContainEqual({
      path: "/api/devices/remove",
      json: { id: "odd", force: false },
    });
    expect(removed).toHaveBeenCalledWith("odd");
  });

  it("has a ready device blink to show which it is, and says when it couldn't", async () => {
    // Blinking… lasts as long as a device takes to blink.
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    const added = { ...kitchenSensor(), identify: true };
    answers.kitchen = () => ({ added });
    devices = [added];
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    const blink = named("Blink Kitchen sensor");
    await act(async () => blink.click());
    expect(requests).toContainEqual({
      path: "/api/devices/identify",
      json: { id: "sensor-1" },
    });
    expect(blink.textContent).toBe("Blinking…");
    expect(blink.disabled).toBe(true);

    const answered = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/devices/identify") {
        throw new CoreError(503, "unavailable");
      }
      return answered(path, init);
    });
    await act(async () => vi.advanceTimersByTime(2_500));
    expect(blink.textContent).toBe("Blink");
    await act(async () => blink.click());
    expect(page().querySelector("[role=alert]")).not.toBeNull();
    expect(blink.textContent).toBe("Blink");
  });

  it("offers no Blink for a device that can't show itself", async () => {
    const added = kitchenSensor();
    answers.kitchen = () => ({ added });
    devices = [added];
    await show();
    await way("Devices found");
    await act(async () => named("Add Kitchen sensor").click());

    expect(named("Blink Kitchen sensor")).toBeNull();
  });
});
