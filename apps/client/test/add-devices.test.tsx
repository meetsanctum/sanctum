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

  it("says what to plug in where the home never had a Zigbee adapter, and otherwise that nothing adds devices", async () => {
    // No app lets devices join: Zigbee waits for its adapter.
    adding = { until: null, joined: [], drivers: [], found: [] };
    const dialog = (notSetUp?: Parameters<typeof AddDevices>[0]["notSetUp"]) =>
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

    await dialog([
      {
        service: "zigbee2mqtt",
        problem: "No Zigbee coordinator is plugged in",
        apps: ["sanctum.zigbee"],
      },
    ]);
    const shown = () => document.querySelector("[role=dialog]")!;
    expect(shown().textContent).toContain(
      "Plug in a Zigbee adapter to add Zigbee devices.",
    );
    // A hint, not something that went wrong, and heard as it appears.
    expect(shown().querySelector("[role=alert]")).toBeNull();
    expect(shown().querySelector("[role=status]")?.textContent).toBe(
      "Plug in a Zigbee adapter to add Zigbee devices.",
    );

    await dialog();
    expect(shown().querySelector("[role=alert]")?.textContent).toBe(
      "No app that adds devices is running.",
    );
    expect(shown().textContent).not.toContain("Plug in a Zigbee adapter");
    expect(shown().querySelector("[role=status]")?.textContent).toBe("");
  });

  it.each(["off", "paused", "failed", "stopped", "waiting"] as const)(
    "does not suggest an adapter when the app is %s for a reason of the core's",
    async (state) => {
      adding = { until: null, joined: [], drivers: [], found: [] };
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

      const shown = document.querySelector("[role=dialog]")!;
      expect(shown.querySelector("[role=alert]")?.textContent).toBe(
        "No app that adds devices is running.",
      );
      expect(shown.textContent).not.toContain("Plug in a Zigbee adapter");
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

  it("lists them first, each saying what it has or what adding it needs", async () => {
    const dialog = await show();

    const [found, joining] = [...dialog.querySelectorAll("section")];
    expect(found!.querySelector("h3")!.textContent).toBe(
      "Found on your network",
    );
    expect(found!.textContent).toContain("2 devices");
    expect(
      [...found!.querySelectorAll("li")].map((row) => row.textContent),
    ).toEqual([
      "Kitchen sensorExample · temperature, humidity, motionAdd",
      "Living room plugExample · needs its encryption keyAdd",
    ]);
    expect(joining!.querySelector("h3")!.textContent).toBe("Zigbee");
    expect(named("Add Kitchen sensor")).not.toBeNull();
  });

  it("adds one that asks nothing at once, and has it named and placed", async () => {
    const added = light("sensor-1", "Kitchen sensor", {
      driver: "sanctum.example",
      driverName: "Kitchen sensor",
    });
    answers.kitchen = () => ({ added });
    const changed = vi.fn();
    const dialog = await show(changed);

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
    const rows = [
      ...dialog.querySelectorAll("section")[0]!.querySelectorAll("li"),
    ];
    expect(rows).toHaveLength(2);
    expect(
      rows[0]!.querySelector<HTMLInputElement>(
        'input[aria-label="Name for Kitchen sensor"]',
      )!.value,
    ).toBe("Kitchen sensor");
    expect(rows[0]!.textContent).toContain("Ready");
  });

  it("asks a key in place, says why one is refused and keeps it to correct", async () => {
    answers["living-room"] = ({ answers }) =>
      (answers as { key: string }).key === "the right key"
        ? {
            added: light("plug-1", "Living room plug", {
              driver: "sanctum.example",
              driverName: "Living room plug",
            }),
          }
        : { refused: { question: "key", refusal: "wrongKey" } };
    const dialog = await show();

    await act(async () => named("Add Living room plug").click());
    const field = dialog.querySelector<HTMLInputElement>(
      "input[type=password]",
    )!;
    expect(field.labels![0]!.textContent).toBe("Encryption key");
    expect(document.activeElement).toBe(field);
    // Nothing goes until it's answered.
    const send = named("Add Living room plug");
    expect(send.disabled).toBe(true);

    await type(field, "a wrong key");
    await act(async () => send.click());
    expect(dialog.querySelector("[role=alert]")!.textContent).toBe(
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
    expect(dialog.querySelector("input[type=password]")).toBeNull();
    expect(dialog.textContent).toContain("Ready");
  });

  it("keeps an add in progress when registration removes it from discovery", async () => {
    const added = light("sensor-1", "Kitchen sensor", {
      driver: "sanctum.example",
      driverName: "Kitchen sensor",
    });
    let finish!: (result: { added: DeviceInfo }) => void;
    answers.kitchen = () => new Promise((resolve) => (finish = resolve));
    const changed = vi.fn();
    const dialog = await show(changed);
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
      dialog.querySelector('input[aria-label="Name for Kitchen sensor"]'),
    ).not.toBeNull();
    expect(dialog.textContent).toContain("Ready");
  });

  it("sends only answers to the questions the driver currently asks", async () => {
    answers["living-room"] = () => ({
      refused: { question: "label", refusal: "wrongKey" },
    });
    const dialog = await show();
    await act(async () => named("Add Living room plug").click());
    await type(
      dialog.querySelector<HTMLInputElement>("input[type=password]")!,
      "old key",
    );

    adding = {
      ...adding,
      found: [{ ...plug, asks: [{ ...key, id: "label", kind: "text" }] }],
    };
    await show();
    await type(
      dialog.querySelector<HTMLInputElement>("input[type=text]")!,
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
    const dialog = await show();
    await act(async () => named("Add Living room plug").click());
    await type(
      dialog.querySelector<HTMLInputElement>("input[type=password]")!,
      "old key",
    );
    adding = { ...adding, found: [{ ...plug, asks: [] }] };
    await show();

    expect(named("Add Living room plug")).not.toBeNull();
    await act(async () => named("Add Living room plug").click());
    expect(requests.at(-1)).toEqual({
      path: "/api/devices/add",
      json: { driver: "sanctum.example", key: "living-room", answers: {} },
    });
    expect(dialog.textContent).toContain("Ready");
  });

  it("follows found devices from its own pairing updates", async () => {
    const dialog = await show(undefined, false);
    await act(async () =>
      live.publish({ type: "pairing", pairing: { ...adding, found: [plug] } }),
    );

    expect(dialog.textContent).not.toContain("Kitchen sensor");
    expect(dialog.textContent).toContain("Living room plug");
  });

  it("keeps a live update that arrives before an older read of its own", async () => {
    let finish!: (info: PairingInfo) => void;
    const answered = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/devices/pairing"
        ? new Promise((done) => (finish = done as never))
        : answered(path, init),
    );
    const dialog = await show(undefined, false);

    await act(async () => live.refresh());
    await act(async () =>
      live.publish({ type: "pairing", pairing: { ...adding, found: [plug] } }),
    );
    await act(async () => finish({ ...adding, found: [] }));

    expect(dialog.textContent).toContain("Living room plug");
  });

  it("offers Look again when a radio starts after opening without one", async () => {
    adding = { ...adding, drivers: [] };
    vi.mocked(coreJson).mockImplementationOnce(async () => {
      throw new CoreError(503, "unavailable");
    });
    const dialog = await show();
    await act(async () =>
      live.publish({
        type: "pairing",
        pairing: { ...adding, drivers: [zigbee.id] },
      }),
    );

    expect(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Look again",
      ),
    ).toBeDefined();
  });

  it("says when adding didn't work", async () => {
    answers.kitchen = () => {
      throw new CoreError(504, "timeout");
    };
    const dialog = await show();

    await act(async () => named("Add Kitchen sensor").click());

    expect(dialog.querySelector("[role=alert]")!.textContent).toBe(
      "It didn't answer in time. Check it's switched on, then try again.",
    );
    expect(named("Add Kitchen sensor").disabled).toBe(false);
  });

  it("says why its driver refused adding one that asks nothing", async () => {
    answers.kitchen = () => ({ refused: { refusal: "notWaiting" } });
    const dialog = await show();

    await act(async () => named("Add Kitchen sensor").click());

    expect(dialog.querySelector("[role=alert]")!.textContent).toBe(
      "It stopped waiting for a key. Turn it off and on again, then add it.",
    );
    expect(named("Add Kitchen sensor").disabled).toBe(false);
  });

  it("shows only what was found when no app lets devices join", async () => {
    adding = { ...adding, drivers: [] };
    vi.mocked(coreJson).mockImplementationOnce(async () => {
      throw new CoreError(503, "unavailable");
    });

    const dialog = await show();

    expect(dialog.querySelectorAll("section")).toHaveLength(1);
    expect(dialog.querySelector("[role=alert]")).toBeNull();
  });
});
