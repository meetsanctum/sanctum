import {
  defineAction,
  defineApp,
  turnOnType,
  type TurnOn,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, sharedClient, type TestCore } from "./support.js";
import {
  addWorkflow,
  runByHand,
  runsOf,
  trigger,
} from "./workflows-support.js";

// The lights of a room, a zone or the whole home together: the route a room's
// and Lights' button use, and the core's lights condition and step. Turning a
// place on follows each room's lights.turnOn, which an app such as Moods
// publishes.

// Publishes a room's lights.turnOn as a test asks, as Moods would.
const rule = defineAction({
  id: "rules.publish",
  title: "Publish",
  tier: "write",
  input: z.object({ key: z.string(), state: z.unknown() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.entities.publish({
      type: turnOnType.id,
      key: input.key,
      name: input.key,
      state: input.state,
    });
    return {};
  },
});
const rules = defineApp({
  id: "test.rules",
  name: "Rules",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  actions: [rule],
  events: [],
  provides: { entities: [turnOnType] },
});

async function home() {
  const context = await lampsCore({
    apps: [{ app: rules, origin: "official" }],
  });
  const { core, maya, lamp, plug } = context;
  const token = maya.token;
  const room = async (name: string) =>
    (await post(core, "/api/places/rooms/add", { name }, { token })).json()
      .id as string;
  const living = await room("Living room");
  const kitchen = await room("Kitchen");
  const hall = await room("Hall");
  const downstairs = (
    await post(
      core,
      "/api/places/zones/add",
      { name: "Downstairs", roomIds: [living, kitchen] },
      { token },
    )
  ).json().id as string;
  for (const [key, name] of [
    ["ceiling-1", "Ceiling"],
    ["counter-1", "Counter"],
    ["hall-1", "Hall light"],
    ["away-1", "Away"],
    ["loose-1", "Loose"],
  ]) {
    await radio.add(key!, "light", name);
  }
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    driverName: string;
  }[];
  const idOf = (name: string) =>
    devices.find((device) => device.driverName === name)!.id;
  const ids = {
    lamp,
    plug,
    ceiling: idOf("Ceiling"),
    counter: idOf("Counter"),
    hall: idOf("Hall light"),
    away: idOf("Away"),
    loose: idOf("Loose"),
  };
  for (const [id, roomId] of [
    [ids.lamp, living],
    [ids.plug, living],
    [ids.ceiling, living],
    [ids.away, living],
    [ids.counter, kitchen],
    [ids.hall, hall],
  ]) {
    await post(core, "/api/devices/update", { id, roomId }, { token });
  }
  // The lamp and the hall light are on, the plug too; Away is unplugged.
  await radio.press("lamp-1", { on: true });
  await radio.press("hall-1", { on: true });
  await radio.press("plug-1", { on: true });
  await radio.unplug("away-1");
  await settled();
  return { ...context, token, ids, living, kitchen, hall, downstairs };
}

function lights(core: TestCore, token: string, body: unknown) {
  return post(core, "/api/devices/lights", body, { token });
}

async function publishRule(
  core: TestCore,
  token: string,
  key: string,
  state: TurnOn,
) {
  const response = await post(
    core,
    `/api/apps/${rules.id}/actions/${rule.id}`,
    { key, state },
    { token },
  );
  expect(response.statusCode).toBe(200);
}

// What the radio was told, light by light, as the core asked for it.
const asked = () =>
  Object.fromEntries(
    radio.received.map(({ command }) => [command.key, command.command]),
  );

// The lights the radio was told to switch, by what it calls them, and whether
// on or off: turning one on, the core adds the look it comes back at.
const switched = () =>
  radio.received.map(({ command }) => [
    command.key,
    { on: (command.command as { on: boolean }).on },
  ]);

describe("POST /api/devices/lights", () => {
  it("toggles a room's lights off while any is on, leaving switches and offline lights alone", async () => {
    const { core, token, living, ids } = await home();
    const response = await lights(core, token, {
      place: { kind: "room", id: living },
      to: "toggle",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ on: false, switched: 1, failed: [] });
    expect(switched()).toEqual([["lamp-1", { on: false }]]);
    const lamp = (await get(core, "/api/devices", { token }))
      .json()
      .find((device: { id: string }) => device.id === ids.lamp);
    expect(lamp.capabilities[0].setBy.actor).toMatchObject({ kind: "user" });
  });

  it("toggles them on when all are off", async () => {
    const { core, token, kitchen } = await home();
    const response = await lights(core, token, {
      place: { kind: "room", id: kitchen },
      to: "toggle",
    });
    expect(response.json()).toEqual({ on: true, switched: 1, failed: [] });
    expect(switched()).toEqual([["counter-1", { on: true }]]);
  });

  it("switches a zone's rooms, or the whole home with lights in no room", async () => {
    const { core, token, downstairs } = await home();
    await lights(core, token, {
      place: { kind: "zone", id: downstairs },
      to: "on",
    });
    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: true }],
      ["counter-1", { on: true }],
    ]);

    radio.received.length = 0;
    const everywhere = await lights(core, token, {
      place: { kind: "home" },
      to: "off",
    });
    expect(everywhere.json()).toMatchObject({ on: false, switched: 4 });
    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: false }],
      ["counter-1", { on: false }],
      ["hall-1", { on: false }],
      ["lamp-1", { on: false }],
    ]);
  });

  it("refuses a room or zone the home does not have, and a request it cannot read", async () => {
    const { core, token } = await home();
    for (const place of [
      { kind: "room", id: "attic" },
      { kind: "zone", id: "upstairs" },
    ]) {
      const response = await lights(core, token, { place, to: "on" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    }
    for (const body of [
      { place: { kind: "home" }, to: "dim" },
      { place: { kind: "floor", id: "x" }, to: "on" },
      { place: { kind: "home" }, to: "on", extra: true },
    ]) {
      expect((await lights(core, token, body)).statusCode).toBe(400);
    }
    expect(radio.received).toEqual([]);
  });

  it("names the lights that could not be switched", async () => {
    const { core, token, ids } = await home();
    // The counter light has lost its power but not yet gone offline.
    radio.gadgets.get("counter-1")!.answers = false;
    const response = await lights(core, token, {
      place: { kind: "home" },
      to: "on",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      on: true,
      switched: 2,
      failed: [{ device: ids.counter, capability: "light" }],
    });
  });

  it("lets a shared client switch every light, as the household", async () => {
    const { core, living } = await home();
    const tablet = sharedClient(core);
    const response = await lights(core, tablet.token, {
      place: { kind: "room", id: living },
      to: "toggle",
    });
    // The lamp is on, so it turns the room off.
    expect(response.json()).toEqual({ on: false, switched: 1, failed: [] });
    expect(switched()).toEqual([["lamp-1", { on: false }]]);
    expect(radio.received[0]!.actor).toEqual({
      kind: "client",
      id: tablet.id,
    });
  });
});

describe("the lights pieces", () => {
  it("are among the core's pieces", async () => {
    const { core, token } = await home();
    const pieces = (await get(core, "/api/workflows/pieces", { token })).json();
    expect(
      pieces
        .filter(
          (piece: { id: string; app: string | null }) => piece.id === "lights",
        )
        .map((piece: { kind: string; app: string | null; title: string }) => [
          piece.kind,
          piece.app,
          piece.title,
        ]),
    ).toEqual([
      ["condition", null, "Lights are on or off"],
      ["step", null, "Switch lights"],
    ]);
  });

  it("switch a place's lights as the workflow when its lights are as asked", async () => {
    const { core, token, living, kitchen } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("trigger", "manual"),
          {
            id: "living-on",
            kind: "condition",
            piece: "lights",
            config: { place: { kind: "room", id: living }, are: "anyOn" },
          },
          {
            id: "kitchen-off",
            kind: "condition",
            piece: "lights",
            config: { place: { kind: "room", id: kitchen }, are: "allOff" },
          },
          {
            id: "all-off",
            kind: "step",
            piece: "lights",
            config: { place: { kind: "home" }, to: "off" },
          },
        ],
        edges: [
          { from: "trigger", to: "living-on" },
          { from: "living-on", to: "kitchen-off" },
          { from: "kitchen-off", to: "all-off" },
        ],
      },
    });

    await runByHand(core, token, id);
    await core.workflows.settled();

    const [run] = await runsOf(core, token, id);
    expect(run!.status).toBe("succeeded");
    expect(run!.steps.map((step) => [step.node, step.status])).toEqual([
      ["living-on", "succeeded"],
      ["kitchen-off", "succeeded"],
      ["all-off", "succeeded"],
    ]);
    expect(run!.steps[2]!.output).toEqual({
      on: false,
      switched: 2,
      failed: [],
    });
    expect(radio.received.map(({ actor }) => actor)).toEqual([
      { kind: "workflow", id },
      { kind: "workflow", id },
    ]);
  });

  it("does not run the step while the condition fails", async () => {
    const { core, token, kitchen } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("trigger", "manual"),
          {
            id: "kitchen-on",
            kind: "condition",
            piece: "lights",
            config: { place: { kind: "room", id: kitchen }, are: "anyOn" },
          },
          {
            id: "kitchen-off",
            kind: "step",
            piece: "lights",
            config: { place: { kind: "room", id: kitchen }, to: "off" },
          },
        ],
        edges: [
          { from: "trigger", to: "kitchen-on" },
          { from: "kitchen-on", to: "kitchen-off" },
        ],
      },
    });

    await runByHand(core, token, id);
    await core.workflows.settled();

    const [run] = await runsOf(core, token, id);
    expect(run).toMatchObject({ status: "skipped", reason: "conditions" });
    expect(radio.received).toEqual([]);
  });

  it("refuse to be saved for a room or zone the home does not have, and break once it goes", async () => {
    const { core, token, hall } = await home();
    for (const [kind, piece, config] of [
      ["step", "lights", { place: { kind: "room", id: "attic" }, to: "on" }],
      [
        "condition",
        "lights",
        { place: { kind: "zone", id: "upstairs" }, are: "anyOn" },
      ],
    ] as const) {
      const response = await post(
        core,
        "/api/workflows/add",
        {
          name: "Test",
          graph: {
            version: 1,
            nodes: [
              trigger("trigger", "manual"),
              { id: "node", kind, piece, config },
              {
                id: "step",
                kind: "step",
                piece: "lights",
                config: { place: { kind: "home" }, to: "on" },
              },
            ],
            edges: [
              { from: "trigger", to: "node" },
              { from: "node", to: "step" },
            ],
          },
        },
        { token },
      );
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(
        kind === "step"
          ? "There is no room attic"
          : "There is no zone upstairs",
      );
    }

    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("trigger", "manual"),
          {
            id: "hall-on",
            kind: "step",
            piece: "lights",
            config: { place: { kind: "room", id: hall }, to: "on" },
          },
        ],
        edges: [{ from: "trigger", to: "hall-on" }],
      },
    });
    await post(core, "/api/places/rooms/remove", { id: hall }, { token });
    await runByHand(core, token, id);
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    expect(run).toMatchObject({
      status: "skipped",
      reason: "broken",
      error: "The room it names was removed",
    });
    expect(radio.received).toEqual([]);
  });

  describe("turning a room on as its lights.turnOn says", () => {
    async function dark() {
      const context = await home();
      const { core, token, living } = context;
      await lights(core, token, {
        place: { kind: "room", id: living },
        to: "off",
      });
      await settled();
      radio.received.length = 0;
      return context;
    }

    it("keeps off the lights it keeps off, and brings the others on with their look", async () => {
      const { core, token, living, ids } = await dark();
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [
          { device: ids.lamp, capability: "light", state: { on: false } },
          {
            device: ids.ceiling,
            capability: "light",
            state: { on: true, brightness: 40 },
          },
        ],
        until: null,
      });

      const response = await lights(core, token, {
        place: { kind: "room", id: living },
        to: "toggle",
      });

      expect(response.json()).toEqual({ on: true, switched: 1, failed: [] });
      expect(Object.keys(asked())).toEqual(["ceiling-1"]);
      expect(asked()["ceiling-1"]).toMatchObject({ on: true, brightness: 40 });
    });

    it("brings a light it leaves out on as the core remembers it", async () => {
      const { core, token, living, ids } = await dark();
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [
          { device: ids.ceiling, capability: "light", state: { on: false } },
        ],
        until: null,
      });

      await lights(core, token, {
        place: { kind: "room", id: living },
        to: "on",
      });

      expect(switched()).toEqual([["lamp-1", { on: true }]]);
    });

    it("goes by none once it no longer holds, or when it would leave every light off", async () => {
      const { core, token, living, ids } = await dark();
      const off = [
        { device: ids.lamp, capability: "light", state: { on: false } },
        { device: ids.ceiling, capability: "light", state: { on: false } },
      ] as const;
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [off[0]],
        until: new Date(core.now().getTime() - 1000).toISOString(),
      });
      await lights(core, token, {
        place: { kind: "room", id: living },
        to: "on",
      });
      expect(switched().sort()).toEqual([
        ["ceiling-1", { on: true }],
        ["lamp-1", { on: true }],
      ]);

      await lights(core, token, {
        place: { kind: "room", id: living },
        to: "off",
      });
      await settled();
      radio.received.length = 0;
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [...off],
        until: null,
      });
      await lights(core, token, {
        place: { kind: "room", id: living },
        to: "on",
      });
      expect(switched().sort()).toEqual([
        ["ceiling-1", { on: true }],
        ["lamp-1", { on: true }],
      ]);
    });

    it("turns a zone or the home on room by room, each by its own rule", async () => {
      const { core, token, living, kitchen, downstairs, ids } = await dark();
      // A rule names a room's lights; a light that moved since keeps none.
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [
          { device: ids.lamp, capability: "light", state: { on: false } },
          { device: ids.counter, capability: "light", state: { on: false } },
        ],
        until: null,
      });

      await lights(core, token, {
        place: { kind: "zone", id: downstairs },
        to: "on",
      });

      expect(switched().sort()).toEqual([
        ["ceiling-1", { on: true }],
        ["counter-1", { on: true }],
      ]);
      expect(kitchen).not.toBe(living);
    });

    it("falls back separately for a room whose rule leaves all its reachable lights off", async () => {
      const { core, token, living, downstairs, ids } = await dark();
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [ids.lamp, ids.ceiling].map((device) => ({
          device,
          capability: "light",
          state: { on: false },
        })),
        until: null,
      });

      await lights(core, token, {
        place: { kind: "zone", id: downstairs },
        to: "on",
      });

      expect(switched().sort()).toEqual([
        ["ceiling-1", { on: true }],
        ["counter-1", { on: true }],
        ["lamp-1", { on: true }],
      ]);
    });

    it("keeps a rule's other lights off when its chosen light is already on", async () => {
      const { core, token, living, ids } = await home();
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [
          { device: ids.lamp, capability: "light", state: { on: true } },
          { device: ids.ceiling, capability: "light", state: { on: false } },
        ],
        until: null,
      });

      const response = await lights(core, token, {
        place: { kind: "room", id: living },
        to: "on",
      });

      expect(response.json()).toEqual({ on: true, switched: 0, failed: [] });
      expect(radio.received).toEqual([]);
    });

    it("follows it in the lights step too, as the workflow", async () => {
      const { core, token, living, ids } = await dark();
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [
          { device: ids.lamp, capability: "light", state: { on: false } },
        ],
        until: null,
      });
      const { id } = await addWorkflow(core, token, {
        name: "Living on",
        graph: {
          version: 1,
          nodes: [
            trigger("trigger", "manual"),
            {
              id: "on",
              kind: "step",
              piece: "lights",
              config: { place: { kind: "room", id: living }, to: "on" },
            },
          ],
          edges: [{ from: "trigger", to: "on" }],
        },
      });

      await runByHand(core, token, id);
      await core.workflows.settled();

      expect((await runsOf(core, token, id))[0]?.status).toBe("succeeded");
      expect(switched()).toEqual([["ceiling-1", { on: true }]]);
    });
  });
});
