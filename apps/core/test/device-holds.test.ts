import type { WorkflowGraph } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { deviceCapabilities } from "../src/devices/schema.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";
import {
  addWorkflow,
  runByHand,
  runsOf,
  trigger,
} from "./workflows-support.js";

// A remote's held button brightening or dimming lights, and the lights step's
// brighter and dimmer: the step sets each light that can dim moving through its
// driver, tied to the press that ran its workflow, and the remote's release,
// another press of it, any other command to the light or the hold's limit ends
// it. Brighter and dimmer step a light a fifth of its range from the level last
// asked of it.

async function office(
  options: {
    holdLimitMs?: number;
    holdSettleMs?: number;
    confirmMs?: number;
  } = {},
) {
  const context = await lampsCore(options);
  const { core, maya, lamp } = context;
  const token = maya.token;
  await radio.add("desk-1", "light", "Desk lamp");
  await radio.add("remote-1", "button", "Office dimmer");
  await settled();
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    driverName: string;
  }[];
  const idOf = (name: string) =>
    devices.find((device) => device.driverName === name)!.id;
  const desk = idOf("Desk lamp");
  const remote = idOf("Office dimmer");
  const room = (
    await post(core, "/api/places/rooms/add", { name: "Office" }, { token })
  ).json().id as string;
  for (const id of [lamp, desk, remote]) {
    await post(core, "/api/devices/update", { id, roomId: room }, { token });
  }
  // The kitchen lamp is off; the desk lamp is on at 40%.
  await radio.press("desk-1", { on: true, brightness: 40 });
  await settled();
  radio.received.length = 0;
  radio.heard.length = 0;
  return { ...context, token, desk, remote, room };
}

type Office = Awaited<ReturnType<typeof office>>;

// A workflow from a press of the remote to the lights step.
function pressing(
  home: Office,
  action: string,
  to: string,
  place: unknown = { kind: "room", id: home.room },
): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      trigger("pressed", "press", { device: home.remote, action }),
      { id: "lights", kind: "step", piece: "lights", config: { place, to } },
    ],
    edges: [{ from: "pressed", to: "lights" }],
  };
}

async function press(core: TestCore, action: string) {
  await radio.pressButton("remote-1", action);
  await core.workflows.settled();
  await settled();
}

async function release() {
  await radio.releaseButton("remote-1");
  await settled();
  await settled();
}

const lightOf = (core: TestCore, id: string) =>
  core.devices.get(id)!.capabilities.find((each) => each.kind === "light")!;

const movesOf = (key: string) =>
  radio.moves
    .filter(({ move }) => move.key === key)
    .map(({ move }) => move.move);

afterEach(() => vi.restoreAllMocks());

describe("holding a remote's button", () => {
  it("takes a button stored before holds as holding nothing until its driver says", async () => {
    const home = await office();
    const { core, token, remote } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "hold", "brightenWhileHeld"),
    });
    // As the core kept a remote's button before holds were declared.
    core.db
      .update(deviceCapabilities)
      .set({ features: { actions: ["single", "double", "hold"] } })
      .where(eq(deviceCapabilities.deviceId, remote))
      .run();

    expect(core.devices.get(remote)!.capabilities[0]!.features).toEqual({
      actions: ["single", "double", "hold"],
      holds: [],
    });
    await press(core, "hold");
    expect(radio.moves).toEqual([]);
  });

  it("brightens the lights while held, from off at the lowest, until it is let go", async () => {
    const home = await office();
    const { core, token, lamp, desk } = home;
    const { id } = await addWorkflow(core, token, {
      graph: pressing(home, "hold", "brightenWhileHeld"),
    });

    await press(core, "hold");

    expect(radio.received.map(({ command }) => command)).toEqual([
      expect.objectContaining({
        key: "lamp-1",
        command: { on: true, brightness: 1 },
      }),
    ]);
    expect(movesOf("lamp-1")).toEqual([{ move: "up", percentPerSecond: 25 }]);
    expect(movesOf("desk-1")).toEqual([{ move: "up", percentPerSecond: 25 }]);
    expect(radio.moves.map(({ actor }) => actor)).toEqual([
      { kind: "workflow", id },
      { kind: "workflow", id },
    ]);
    expect(core.holds.isMoving(desk, "light")).toBe(true);

    core.advance(2_000);
    await release();

    expect(movesOf("desk-1").at(-1)).toEqual({ move: "stop" });
    expect(core.holds.isMoving(desk, "light")).toBe(false);
    // Where each got to, as the lamps said once stopped.
    expect(lightOf(core, lamp).state).toMatchObject({
      on: true,
      brightness: 51,
    });
    expect(lightOf(core, desk).state).toMatchObject({
      on: true,
      brightness: 90,
    });
    expect(lightOf(core, desk).setBy).toMatchObject({
      app: null,
      actor: { kind: "workflow", id },
      asked: { brightness: 100 },
    });
    // The activity log has the desk lamp's hold once, with which way it
    // went, and no entry for its stop.
    expect(
      core.activity
        .recent()
        .filter(
          (entry) =>
            entry.action === "device.command" && entry.subjectId === desk,
        )
        .map((entry) => [entry.outcome, entry.actor, entry.detail]),
    ).toEqual([["ok", `workflow:${id}`, { capability: "light", move: "up" }]]);
    const [run] = await runsOf(core, token, id);
    expect(run!.steps[0]!.output).toEqual({
      on: true,
      switched: 2,
      failed: [],
    });
  });

  it("does not send a light its wake again once the hold has it moving", async () => {
    const home = await office({ confirmMs: 20 });
    const { core, token, lamp } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "hold", "brightenWhileHeld"),
    });
    // The kitchen lamp never says it woke.
    radio.confirms = false;

    await press(core, "hold");
    // The wake's time to be confirmed runs out on the real clock: the test
    // waits for it to have, however long a slow runner takes.
    await expect.poll(() => lightOf(core, lamp).sync).toBe("conflict");

    expect(movesOf("lamp-1")).toEqual([{ move: "up", percentPerSecond: 25 }]);
    expect(
      radio.received
        .filter(({ command }) => command.key === "lamp-1")
        .map(({ command }) => command.command),
    ).toEqual([{ on: true, brightness: 1 }]);
    await release();
  });

  it("does not start a hold that was released before its workflow reached the step", async () => {
    const home = await office();
    await addWorkflow(home.core, home.token, {
      graph: pressing(home, "hold", "dimWhileHeld"),
    });
    const pressingButton = radio.pressButton("remote-1", "hold");
    await radio.releaseButton("remote-1");
    await pressingButton;
    await home.core.workflows.settled();
    expect(radio.moves).toEqual([]);
  });

  it.each(["release", "press", "command"])(
    "stops an in-flight move before a later %s takes over",
    async (ending) => {
      const home = await office();
      await addWorkflow(home.core, home.token, {
        graph: pressing(home, "hold", "dimWhileHeld"),
      });
      let resume!: () => void;
      let enter!: () => void;
      const waiting = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const moveLight = radio.moveLight.bind(radio);
      vi.spyOn(radio, "moveLight").mockImplementationOnce(async (...args) => {
        enter();
        await waiting;
        await moveLight(...args);
      });
      await radio.pressButton("remote-1", "hold");
      await entered;
      const endingMove =
        ending === "release"
          ? radio.releaseButton("remote-1")
          : ending === "press"
            ? radio.pressButton("remote-1", "single")
            : home.core.devices.command(
                { kind: "workflow", id: "another" },
                {
                  device: home.desk,
                  capability: "light",
                  command: { on: false },
                },
                {},
                null,
              );
      resume();
      await endingMove;
      await home.core.workflows.settled();
      await settled();
      expect(movesOf("desk-1")).toEqual([
        { move: "down", percentPerSecond: 25 },
        { move: "stop" },
      ]);
      expect(home.core.holds.isMoving(home.desk, "light")).toBe(false);
      if (ending === "command") {
        expect(radio.heard).toEqual([
          "desk-1 down",
          "desk-1 stop",
          "desk-1 command",
        ]);
        expect(lightOf(home.core, home.desk).setBy).toMatchObject({
          actor: { kind: "workflow", id: "another" },
          asked: { on: false },
        });
      }
    },
  );

  it("stops moving lights before closing their driver", async () => {
    const home = await office();
    await addWorkflow(home.core, home.token, {
      graph: pressing(home, "hold", "dimWhileHeld"),
    });
    await press(home.core, "hold");
    await home.core.close();
    expect(movesOf("desk-1").at(-1)).toEqual({ move: "stop" });
    expect(radio.moving.size).toBe(0);
  });

  it("keeps the hold's attribution when a later command fails", async () => {
    const home = await office();
    await home.core.devices.command(
      { kind: "workflow", id: "earlier" },
      {
        device: home.desk,
        capability: "light",
        command: { brightness: 60 },
      },
      {},
      null,
    );
    await settled();
    await addWorkflow(home.core, home.token, {
      graph: pressing(home, "hold", "dimWhileHeld"),
    });
    await press(home.core, "hold");
    await release();
    const before = lightOf(home.core, home.desk).setBy;
    vi.spyOn(radio, "carryOut").mockRejectedValueOnce(new Error("offline"));

    await expect(
      home.core.devices.command(
        { kind: "workflow", id: "later" },
        {
          device: home.desk,
          capability: "light",
          command: { brightness: 80 },
        },
        {},
        null,
      ),
    ).rejects.toMatchObject({ code: "app_failed" });
    expect(lightOf(home.core, home.desk).setBy).toEqual(before);
  });

  it("dims down to the lowest and leaves lights that are off alone", async () => {
    const home = await office();
    const { core, token, desk } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "hold", "dimWhileHeld"),
    });

    await press(core, "hold");
    core.advance(4_000);
    await release();

    expect(movesOf("lamp-1")).toEqual([]);
    expect(radio.received).toEqual([]);
    expect(movesOf("desk-1")).toEqual([
      { move: "down", percentPerSecond: 25 },
      { move: "stop" },
    ]);
    expect(lightOf(core, desk).state).toMatchObject({
      on: true,
      brightness: 1,
    });
  });

  it("goes the other way each hold by turns, from how bright the lights are", async () => {
    const home = await office();
    const { core, token } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "hold", "brightenOrDimWhileHeld"),
    });

    // Nothing brighter than 50% is on, so the first hold brightens.
    await press(core, "hold");
    core.advance(1_000);
    await release();
    await press(core, "hold");
    core.advance(1_000);
    await release();
    await press(core, "hold");
    await release();

    expect(
      movesOf("desk-1")
        .filter((move) => move.move !== "stop")
        .map((move) => move.move),
    ).toEqual(["up", "down", "up"]);
  });

  it("alternates quick holds before the stopped light reports its level", async () => {
    const home = await office();
    await addWorkflow(home.core, home.token, {
      graph: pressing(home, "hold", "brightenOrDimWhileHeld", {
        kind: "lights",
        lights: [{ device: home.lamp, capability: "light" }],
      }),
    });
    await press(home.core, "hold");
    home.core.advance(1_000);
    await radio.releaseButton("remote-1");
    await radio.pressButton("remote-1", "hold");
    await home.core.workflows.settled();
    expect(
      movesOf("lamp-1")
        .filter((move) => move.move !== "stop")
        .map((move) => move.move),
    ).toEqual(["up", "down"]);
  });

  it("ends the dim once the remote is pressed again or the light is commanded", async () => {
    const home = await office();
    const { core, token, desk } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "hold", "dimWhileHeld"),
    });

    await press(core, "hold");
    await press(core, "single");
    expect(radio.heard).toEqual(["desk-1 down", "desk-1 stop"]);

    await press(core, "hold");
    radio.heard.length = 0;
    await post(
      core,
      "/api/devices/command",
      { device: desk, capability: "light", command: { on: false } },
      { token },
    );
    await settled();

    // The stop goes out before the command.
    expect(radio.heard).toEqual(["desk-1 stop", "desk-1 command"]);
    expect(core.holds.isMoving(desk, "light")).toBe(false);
  });

  it("lets another remote reverse a moving light before its next brightness report", async () => {
    const home = await office();
    await radio.add("remote-2", "button", "Second remote");
    const remote = home.core.devices
      .list()
      .find((device) => device.driverName === "Second remote")!.id;
    await addWorkflow(home.core, home.token, {
      graph: pressing(home, "hold", "brightenWhileHeld"),
    });
    await addWorkflow(home.core, home.token, {
      graph: pressing({ ...home, remote }, "hold", "dimWhileHeld"),
    });
    await press(home.core, "hold");
    // The off lamp was switched on at 1%. Its next report only comes on stop.
    home.core.advance(1_000);
    await radio.pressButton("remote-2", "hold");
    await home.core.workflows.settled();
    await settled();
    expect(movesOf("lamp-1")).toEqual([
      { move: "up", percentPerSecond: 25 },
      { move: "stop" },
      { move: "down", percentPerSecond: 25 },
    ]);
  });

  it("ends the dim at its limit when the release is lost", async () => {
    const home = await office({ holdLimitMs: 20 });
    const { core, token, desk } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "hold", "dimWhileHeld"),
    });
    // The limit runs on the test's clock, so it cannot end the dim while
    // a slow runner is still setting the lamp moving.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });

    await press(core, "hold");
    expect(core.holds.isMoving(desk, "light")).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    await settled();

    expect(movesOf("desk-1").at(-1)).toEqual({ move: "stop" });
    expect(core.holds.isMoving(desk, "light")).toBe(false);
  });

  it("takes a release only from a device with a button, and starts nothing", async () => {
    const home = await office();
    const { core, token } = home;
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("pressed", "press", { device: home.remote }),
          {
            id: "lights",
            kind: "step",
            piece: "lights",
            config: { place: { kind: "room", id: home.room }, to: "off" },
          },
        ],
        edges: [{ from: "pressed", to: "lights" }],
      },
    });

    await release();
    await core.workflows.settled();
    await expect(radio.releaseButton("lamp-1")).rejects.toMatchObject({
      name: "ActionError",
      code: "not_found",
    });

    expect(await runsOf(core, token, id)).toEqual([]);
  });

  it("fails a step while held with no press behind its run", async () => {
    const home = await office();
    const { core, token } = home;
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("by-hand", "manual"),
          {
            id: "lights",
            kind: "step",
            piece: "lights",
            config: {
              place: { kind: "room", id: home.room },
              to: "brightenWhileHeld",
            },
          },
        ],
        edges: [{ from: "by-hand", to: "lights" }],
      },
    });

    await runByHand(core, token, id);
    await core.workflows.settled();

    const [run] = await runsOf(core, token, id);
    expect(run!.steps[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Nothing is held/),
    });
    expect(radio.moves).toEqual([]);
  });
});

describe("the lights step", () => {
  it("steps the lights brighter by a fifth, from off as from nothing", async () => {
    const home = await office();
    const { core, token, lamp, desk } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "single", "brighter"),
    });

    await press(core, "single");

    expect(
      Object.fromEntries(
        radio.received.map(({ command }) => [command.key, command.command]),
      ),
    ).toEqual({
      "lamp-1": { on: true, brightness: 20, transitionSeconds: 0.4 },
      "desk-1": { on: true, brightness: 60, transitionSeconds: 0.4 },
    });
    expect(lightOf(core, lamp).state).toMatchObject({
      on: true,
      brightness: 20,
    });
    expect(lightOf(core, desk).state).toMatchObject({
      on: true,
      brightness: 60,
    });
  });

  it("steps from where a hold left the lights once they say so", async () => {
    const home = await office({ holdSettleMs: 300 });
    const { core, token } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "hold", "brightenWhileHeld"),
    });
    await addWorkflow(core, token, {
      graph: pressing(home, "single", "brighter"),
    });
    // The lamps say where they got to a moment after their stop.
    radio.stopReportMs = 100;

    await press(core, "hold");
    core.advance(1_000);
    await release();
    radio.received.length = 0;
    await press(core, "single");

    // The desk lamp got from 40% to 65% while held, and steps on from there.
    expect(
      radio.received.find(({ command }) => command.key === "desk-1")?.command,
    ).toMatchObject({
      key: "desk-1",
      command: { on: true, brightness: 85, transitionSeconds: 0.4 },
    });
  });

  it("steps them dimmer down to the lowest, never off, from what was last asked", async () => {
    const home = await office();
    const { core, token, desk } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "double", "dimmer"),
    });

    await press(core, "double");
    await press(core, "double");
    await press(core, "double");

    expect(
      radio.received.map(({ command }) => [command.key, command.command]),
    ).toEqual([
      ["desk-1", { on: true, brightness: 20, transitionSeconds: 0.4 }],
      ["desk-1", { on: true, brightness: 1, transitionSeconds: 0.4 }],
    ]);
    expect(lightOf(core, desk).state).toMatchObject({
      on: true,
      brightness: 1,
    });
  });

  it("switches only the chosen lights", async () => {
    const home = await office();
    const { core, token, lamp, desk } = home;
    await addWorkflow(core, token, {
      graph: pressing(home, "single", "toggle", {
        kind: "lights",
        lights: [{ device: desk, capability: "light" }],
      }),
    });

    await press(core, "single");

    expect(radio.received.map(({ command }) => command.key)).toEqual([
      "desk-1",
    ]);
    expect(lightOf(core, desk).state).toMatchObject({ on: false });
    expect(lightOf(core, lamp).state).toMatchObject({ on: false });
  });
});
