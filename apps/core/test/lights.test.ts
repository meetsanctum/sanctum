import { describe, expect, it } from "vitest";

import { radio } from "./devices-support.js";
import { darkRoom, home, publishRule, switched } from "./lights-support.js";
import { get, post } from "./support.js";
import {
  addWorkflow,
  runByHand,
  runsOf,
  trigger,
} from "./workflows-support.js";

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

  it("follows the room's turn-on rule in the lights step", async () => {
    const { core, token, living, ids } = await darkRoom();
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [{ device: ids.lamp, capability: "light", state: { on: false } }],
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
