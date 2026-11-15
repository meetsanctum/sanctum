import type { WorkflowNode } from "@meetsanctum/app-sdk";
import { quietAfterMs } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";
import {
  addWorkflow,
  runByHand,
  runsOf,
  trigger,
} from "./workflows-support.js";

// Contact sensors in automations: a workflow starts when one opens or
// closes, on a change the core saw and never on a first reading, and may
// ask whether one is open or closed, which neither is while nothing is
// known of it.

const lightsOn: WorkflowNode = {
  id: "on",
  kind: "step",
  piece: "lights",
  config: { place: { kind: "home" }, to: "on" },
};

async function sensorOf(core: TestCore, token: string, key: string) {
  const devices = (await get(core, "/api/devices", { token })).json();
  return devices.find((each: { driverName: string }) => each.driverName === key)
    .id as string;
}

async function home() {
  const context = await lampsCore();
  return { ...context, token: context.maya.token };
}

// A workflow that starts on one of the device trigger's contact presets.
async function startsWhen(
  core: TestCore,
  token: string,
  device: string,
  operator: "is_on" | "is_off",
) {
  const { id } = await addWorkflow(core, token, {
    name: "Hall light",
    graph: {
      version: 1,
      nodes: [
        trigger("door", "device", {
          device,
          capability: "contact",
          kind: "contact",
          field: "open",
          operator,
          fromKnown: true,
        }),
        lightsOn,
      ],
      edges: [{ from: "door", to: "on" }],
    },
  });
  return id;
}

async function say(key: string, state: Record<string, unknown>) {
  await radio.press(key, state);
  await settled();
}

describe("the device pieces' words for a contact sensor", () => {
  it("offer Opens and Closes to start on, and Is open and Is closed to ask", async () => {
    const { core, token } = await home();
    const pieces = (await get(core, "/api/workflows/pieces", { token })).json();
    const presets = (kind: string) =>
      pieces
        .find(
          (each: { kind: string; app: string | null; id: string }) =>
            each.kind === kind && each.app === null && each.id === "device",
        )
        .presets.map((preset: { title: string; config: object }) => [
          preset.title,
          preset.config,
        ]);

    expect(presets("trigger")).toEqual(
      expect.arrayContaining([
        [
          "Opens",
          {
            kind: "contact",
            field: "open",
            operator: "is_on",
            fromKnown: true,
          },
        ],
        [
          "Closes",
          {
            kind: "contact",
            field: "open",
            operator: "is_off",
            fromKnown: true,
          },
        ],
      ]),
    );
    expect(presets("condition")).toEqual(
      expect.arrayContaining([
        ["Is open", { field: "open", operator: "is_on" }],
        ["Is closed", { field: "open", operator: "is_off" }],
      ]),
    );
  });
});

describe("a workflow that starts when a contact sensor opens", () => {
  it("runs each time it goes from closed to open, and not while it says the same again", async () => {
    const { core, token } = await home();
    await radio.add("door-1", "contact", "Door 1");
    await settled();
    const id = await startsWhen(
      core,
      token,
      await sensorOf(core, token, "Door 1"),
      "is_on",
    );

    await say("door-1", { open: true });
    await say("door-1", { open: true, battery: 90 });
    await say("door-1", { open: false });
    await say("door-1", { open: true });
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(2);
  });

  it("does not run on a first reading that finds it open", async () => {
    const { core, token } = await home();
    // It joins and is registered before it has said anything.
    core.devices.register("test.lamps", {
      key: "door-2",
      name: "Door 2",
      capabilities: [{ id: "contact", kind: "contact" }],
    });
    const sensor = await sensorOf(core, token, "Door 2");
    const id = await startsWhen(core, token, sensor, "is_on");
    const says = (open: boolean) => {
      core.devices.report("test.lamps", {
        key: "door-2",
        availability: "online",
        states: { contact: { open } },
      });
      return settled();
    };

    // Found open: that is how it is, not something that just happened.
    await says(true);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(0);

    await says(false);
    await says(true);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(1);
  });

  it("closes likewise", async () => {
    const { core, token } = await home();
    await radio.add("door-3", "contact", "Door 3");
    await settled();
    const id = await startsWhen(
      core,
      token,
      await sensorOf(core, token, "Door 3"),
      "is_off",
    );

    await say("door-3", { open: true });
    await say("door-3", { open: false });
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(1);
  });

  it("is named in Activity by the sensor and which way it went", async () => {
    const { core, token } = await home();
    await radio.add("door-4", "contact", "Door 4");
    await settled();
    const sensor = await sensorOf(core, token, "Door 4");
    await post(
      core,
      "/api/devices/update",
      { id: sensor, name: "Front door" },
      { token },
    );
    await startsWhen(core, token, sensor, "is_on");

    await say("door-4", { open: true });
    await core.workflows.settled();
    await settled();
    const { entries } = (
      await get(core, "/api/activity?limit=50", { token })
    ).json() as {
      entries: { action: string; detail: { trigger?: object } | null }[];
    };
    const run = entries.find((each) => each.action === "workflow.run");
    expect(run?.detail?.trigger).toMatchObject({
      piece: "device",
      device: "Front door",
      opened: true,
    });
  });
});

describe("asking whether a contact sensor is open or closed", () => {
  // A workflow run by hand that reaches its step only if the sensor is so.
  async function passes(
    core: TestCore,
    token: string,
    device: string,
    operator: "is_on" | "is_off",
  ) {
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("hand", "manual"),
          {
            id: "if",
            kind: "condition",
            piece: "device",
            config: { device, capability: "contact", field: "open", operator },
          },
          lightsOn,
        ],
        edges: [
          { from: "hand", to: "if" },
          { from: "if", to: "on" },
        ],
      },
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    return run!.status === "succeeded";
  }

  it("goes by what it says while it answers", async () => {
    const { core, token } = await home();
    await radio.add("window-1", "contact", "Window 1");
    await settled();
    const sensor = await sensorOf(core, token, "Window 1");

    expect(await passes(core, token, sensor, "is_off")).toBe(true);
    expect(await passes(core, token, sensor, "is_on")).toBe(false);
    await say("window-1", { open: true });
    expect(await passes(core, token, sensor, "is_on")).toBe(true);
    expect(await passes(core, token, sensor, "is_off")).toBe(false);
  });

  it("is neither while it is offline", async () => {
    const { core, token } = await home();
    await radio.add("window-2", "contact", "Window 2");
    await settled();
    const sensor = await sensorOf(core, token, "Window 2");
    await radio.unplug("window-2");
    await settled();

    expect(await passes(core, token, sensor, "is_off")).toBe(false);
    expect(await passes(core, token, sensor, "is_on")).toBe(false);
  });

  it("is neither once it has not been heard from for a day", async () => {
    const { core, token } = await home();
    await radio.add("window-3", "contact", "Window 3");
    await settled();
    const sensor = await sensorOf(core, token, "Window 3");
    // Its driver no longer knows whether it answers, as of one that sleeps.
    core.devices.report("test.lamps", {
      key: "window-3",
      availability: "unknown",
    });
    await settled();
    expect(await passes(core, token, sensor, "is_off")).toBe(true);

    core.advance(quietAfterMs);
    expect(await passes(core, token, sensor, "is_off")).toBe(false);
    expect(await passes(core, token, sensor, "is_on")).toBe(false);
  });

  it("leaves a light's condition reading its last state while it is offline", async () => {
    const { core, token, lamp } = await home();
    await radio.unplug("lamp-1");
    await settled();
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("hand", "manual"),
          {
            id: "if",
            kind: "condition",
            piece: "device",
            config: {
              device: lamp,
              capability: "light",
              field: "on",
              operator: "is_off",
            },
          },
          lightsOn,
        ],
        edges: [
          { from: "hand", to: "if" },
          { from: "if", to: "on" },
        ],
      },
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    expect(run!.status).toBe("succeeded");
  });
});
