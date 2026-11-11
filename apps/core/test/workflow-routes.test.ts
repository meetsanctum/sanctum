import type {
  PieceInfo,
  WorkflowInfo,
  WorkflowRunInfo,
} from "@meetsanctum/app-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { ActionCallError } from "../src/app-host/errors.js";
import type { Principal } from "../src/auth/clients.js";
import { workflowRules } from "../src/workflows/workflows.js";
import { lampsCore, personWithClient } from "./devices-support.js";
import { get, post, sharedClient } from "./support.js";
import {
  addWorkflow,
  sample,
  samplePackage,
  noteStep,
  runByHand,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// Workflows' client routes: they belong to the household, so every person and
// shared client reads, changes and runs them, and a graph is saved only whole,
// its problems tied to their nodes and fields.

beforeEach(() => sample.reset());

async function home() {
  const { core, maya, lamp } = await lampsCore({ apps: [samplePackage] });
  return { core, lamp, token: maya.token, maya };
}

const morning = steps(
  trigger("t", "time", { time: "07:00" }),
  noteStep("note"),
);

describe("saving a workflow", () => {
  it("refuses a graph that is not whole, saying why", async () => {
    const { core, token, lamp } = await home();
    const refused = async (graph: unknown) => {
      const response = await post(
        core,
        "/api/workflows/add",
        { name: "Broken", graph },
        { token },
      );
      expect(response.statusCode).toBe(400);
      return response.json();
    };

    const whole = (message: string) => ({ node: null, field: null, message });
    expect(await refused({ version: 1, nodes: [], edges: [] })).toEqual({
      error: "invalid_workflow",
      problems: [
        whole("A workflow needs a trigger"),
        whole("A workflow needs a step"),
      ],
    });
    expect(
      (
        await refused(
          steps(trigger("t", "manual"), {
            id: "s",
            kind: "step",
            app: "test.nope",
            piece: "nope.do",
            config: {},
          }),
        )
      ).problems,
    ).toEqual([
      {
        node: "s",
        field: null,
        message: "The app test.nope is not installed, for nope.do",
      },
    ]);
    expect(
      (
        await refused(
          steps(trigger("t", "time", { time: "7am" }), noteStep("note")),
        )
      ).problems,
    ).toEqual([
      { node: "t", field: "time", message: "Use a time such as 07:30" },
    ]);
    expect(
      (
        await refused(
          steps(trigger("t", "manual"), {
            id: "s",
            kind: "step",
            piece: "device",
            config: { device: lamp, capability: "light", command: { on: 2 } },
          }),
        )
      ).problems,
    ).toEqual([
      {
        node: "s",
        field: "command.on",
        message: expect.stringMatching(/^The command does not fit a light: /),
      },
    ]);
    expect(
      (
        await refused({
          ...morning,
          edges: [{ from: "t", to: "elsewhere" }],
        })
      ).problems,
    ).toEqual([
      whole("An edge leads to elsewhere, which is not a node"),
      whole("No trigger leads to a step"),
    ]);
    // Not a graph at all.
    const malformed = await post(
      core,
      "/api/workflows/add",
      { name: "Odd", graph: { nodes: [{ id: "x", kind: "logic" }] } },
      { token },
    );
    expect(malformed.json()).toEqual({ error: "invalid_request" });
  });

  it("raises the version only when the graph changes", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, { graph: morning });

    const renamed = await post(
      core,
      "/api/workflows/update",
      { id, name: "Mornings", graph: morning },
      { token },
    );
    expect(renamed.json()).toMatchObject({ name: "Mornings", version: 1 });

    const changed = await post(
      core,
      "/api/workflows/update",
      {
        id,
        graph: steps(trigger("t", "time", { time: "07:30" }), noteStep("note")),
      },
      { token },
    );
    expect(changed.json()).toMatchObject({ version: 2 });
  });

  it("removes a workflow with its runs", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, { graph: morning });
    await runByHand(core, token, id);
    await core.workflows.settled();

    const removed = await post(
      core,
      "/api/workflows/remove",
      { id },
      { token },
    );
    expect(removed.statusCode).toBe(204);
    expect((await get(core, "/api/workflows", { token })).json()).toEqual([]);
    expect(
      (await get(core, `/api/workflows/runs?workflow=${id}`, { token }))
        .statusCode,
    ).toBe(404);
  });

  it("logs every change with who made it", async () => {
    const { core, token, maya } = await home();
    const { id } = await addWorkflow(core, token, { graph: morning });
    await post(
      core,
      "/api/workflows/update",
      { id, enabled: false },
      { token },
    );
    await runByHand(core, token, id);
    await core.workflows.settled();
    await post(core, "/api/workflows/remove", { id }, { token });

    expect(
      core.activity
        .recent()
        .filter((entry) => entry.source === "workflows")
        .map(({ action, personId, subjectId }) => ({
          action,
          personId,
          subjectId,
        }))
        .reverse(),
    ).toEqual(
      [
        "workflow.add",
        "workflow.update",
        "workflow.run",
        "workflow.remove",
      ].map((action) => ({ action, personId: maya.person.id, subjectId: id })),
    );
  });
});

describe("running a workflow by hand", () => {
  it("runs it from its manual triggers, or all of them, even while it is off", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      enabled: false,
      graph: morning,
    });

    const run = await runByHand(core, token, id);
    expect(run.json()).toMatchObject({
      workflowId: id,
      status: "running",
      trigger: { nodes: ["t"] },
    });
    await core.workflows.settled();
    expect((await runsOf(core, token, id))[0]).toMatchObject({
      status: "succeeded",
    });
  });
});

describe("who may", () => {
  it("lets every person, children and guests too, and shared clients add, change, run and remove them", async () => {
    const { core } = await home();
    const callers = {
      child: personWithClient(core, "Ida"),
      guest: personWithClient(core, "Gus"),
      kitchen: { ...sharedClient(core), person: undefined },
    };

    for (const [name, caller] of Object.entries(callers)) {
      const call = { token: caller.token };
      const added = await post(
        core,
        "/api/workflows/add",
        { name, graph: morning },
        call,
      );
      expect(added.json()).toMatchObject({
        name,
        createdBy: caller.person?.id ?? null,
      });
      const { id } = added.json() as { id: string };
      const renamed = await post(
        core,
        "/api/workflows/update",
        { id, name: `${name}'s` },
        call,
      );
      expect(renamed.json()).toMatchObject({ name: `${name}'s` });
      const run = await runByHand(core, call.token, id);
      expect(run.json()).toMatchObject({ workflowId: id, status: "running" });
      await core.workflows.settled();
      expect((await get(core, "/api/workflows/pieces", call)).statusCode).toBe(
        200,
      );
      expect(await runsOf(core, call.token, id)).toHaveLength(1);
      expect(
        (await post(core, "/api/workflows/remove", { id }, call)).statusCode,
      ).toBe(204);
    }

    // The activity log says who, and on which client.
    expect(
      core.activity
        .recent()
        .filter(
          (entry) =>
            entry.source === "workflows" &&
            entry.clientId === callers.kitchen.id,
        )
        .map(({ action, personId }) => ({ action, personId }))
        .reverse(),
    ).toEqual(
      [
        "workflow.add",
        "workflow.update",
        "workflow.run",
        "workflow.remove",
      ].map((action) => ({ action, personId: null })),
    );
  });

  it("keeps who pressed Run, or the shared client it was pressed on", async () => {
    const { core, token, maya } = await home();
    const kitchen = sharedClient(core);
    const { id } = await addWorkflow(core, token, {
      runMode: "queued",
      graph: morning,
    });

    const byMaya = (await runByHand(core, token, id)).json();
    const byKitchen = (await runByHand(core, kitchen.token, id)).json();
    await core.workflows.settled();

    expect(byMaya).toMatchObject({
      startedBy: maya.person.id,
      startedOn: null,
    });
    expect(byKitchen).toMatchObject({
      startedBy: null,
      startedOn: "Kitchen tablet",
    });
    expect(
      (
        (
          await get(core, `/api/workflows/runs?workflow=${id}`, { token })
        ).json() as WorkflowRunInfo[]
      ).map(({ startedBy, startedOn }) => ({ startedBy, startedOn })),
    ).toEqual([
      { startedBy: null, startedOn: "Kitchen tablet" },
      { startedBy: maya.person.id, startedOn: null },
    ]);
  });

  it("keeps them from widget tokens", async () => {
    const { core } = await home();
    const widgets: Principal = {
      client: { id: "kitchen", kind: "shared", name: "Kitchen tablet" },
      scope: "widgets",
    };

    for (const rule of [workflowRules.read, workflowRules.change]) {
      expect(() => core.gate.admit(widgets, rule)).toThrow(
        new ActionCallError("forbidden"),
      );
    }
  });
});

describe("a workflow's runs, as the list shows them", () => {
  it("are its latest run and, while it is on, when its timers next start it", async () => {
    const { core, token } = await home();
    const timed = await addWorkflow(core, token, {
      name: "Timed",
      graph: steps(
        trigger("seven", "time", { time: "07:00" }),
        trigger("five", "time", { time: "17:00" }),
        noteStep("note"),
      ),
    });
    const byHand = await addWorkflow(core, token, {
      name: "By hand",
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });
    const listed = async () =>
      Object.fromEntries(
        (
          (
            await get(core, "/api/workflows", { token })
          ).json() as WorkflowInfo[]
        ).map((workflow) => [workflow.name, workflow]),
      );

    // The core's clock starts at noon UTC, in a home on UTC.
    expect(await listed()).toMatchObject({
      Timed: { lastRun: null, nextRun: "2026-10-26T17:00:00.000Z" },
      "By hand": { lastRun: null, nextRun: null },
    });

    await runByHand(core, token, timed.id);
    await core.workflows.settled();
    core.advance(60_000);
    // The newest run, while it is going and once it has ended.
    const release = sample.holdSteps();
    const second = (await runByHand(core, token, timed.id)).json();
    const going = await listed();
    core.advance(60_000);
    release();
    await core.workflows.settled();
    const ended = await listed();

    expect(going.Timed!.lastRun).toEqual({
      id: second.id,
      status: "running",
      at: "2026-10-26T12:01:00.000Z",
    });
    expect(ended.Timed!.lastRun).toEqual({
      id: second.id,
      status: "succeeded",
      at: "2026-10-26T12:02:00.000Z",
    });
    expect(ended["By hand"]!.lastRun).toBeNull();

    // A workflow that is off has no next run, though its timers move on.
    await post(
      core,
      "/api/workflows/update",
      { id: timed.id, enabled: false },
      { token },
    );
    expect((await listed()).Timed!.nextRun).toBeNull();
    expect(
      (await get(core, "/api/workflows", { token })).json(),
    ).toContainEqual(expect.objectContaining({ id: byHand.id, nextRun: null }));
  });
});

describe("the pieces", () => {
  it("are the core's own and every installed app's, with their configs", async () => {
    const { core, token } = await home();
    const pieces = (
      await get(core, "/api/workflows/pieces", { token })
    ).json() as { kind: string; app: string | null; id: string }[];

    expect(
      pieces.map(({ kind, app, id }) => `${kind} ${app ?? "core"} ${id}`),
    ).toEqual([
      "trigger core manual",
      "trigger core time",
      "trigger core sun",
      "trigger core device",
      "trigger core motion",
      "trigger core noMotion",
      "trigger core press",
      "trigger core entity",
      "condition core device",
      "condition core motion",
      "condition core noMotion",
      "condition core lightLevel",
      "condition core entity",
      "condition core time",
      "condition core lights",
      "step core device",
      "step core lights",
      "trigger test.sample sample.done",
      "condition test.sample sample.isDue",
      "step test.sample sample.note",
      "step test.sample sample.wipe",
    ]);
    expect(pieces.find((piece) => piece.id === "sample.note")).toMatchObject({
      title: "Write a note",
      needs: ["people.read"],
      config: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      sentence: null,
      card: null,
      presets: [],
      icon: null,
      group: null,
    });
  });

  it("carry the words Automations reads them with, their groups and their fields' markers", async () => {
    const { core, token } = await home();
    const pieces = (
      await get(core, "/api/workflows/pieces", { token })
    ).json() as PieceInfo[];
    const own = (kind: string, id: string) =>
      pieces.find(
        (piece) => piece.app === null && piece.kind === kind && piece.id === id,
      )!;

    expect(own("trigger", "sun")).toEqual({
      kind: "trigger",
      app: null,
      id: "sun",
      title: "At sunrise or sunset",
      config: expect.objectContaining({
        properties: {
          event: expect.objectContaining({
            enum: ["sunrise", "sunset"],
            labels: { sunrise: "sunrise", sunset: "sunset" },
          }),
          offsetMinutes: expect.objectContaining({
            offsetMinutes: true,
            default: 0,
          }),
        },
      }),
      sentence: "At {event}, {offsetMinutes}",
      card: { name: "{event}", specifics: "{offsetMinutes}" },
      presets: [
        {
          title: "At sunrise",
          sentence: "At sunrise, {offsetMinutes}",
          icon: "sunrise",
          config: { event: "sunrise" },
        },
        {
          title: "At sunset",
          sentence: "At sunset, {offsetMinutes}",
          icon: "sunset",
          config: { event: "sunset" },
        },
      ],
      icon: "sunset",
      needs: [],
      group: "Sunrise and sunset",
    });

    const lights = own("step", "lights");
    expect(lights).toMatchObject({
      sentence: "{to} the lights in {place}",
      card: null,
      icon: "lightbulb",
      group: null,
      config: {
        properties: {
          place: { place: true },
          to: {
            enum: [
              "toggle",
              "on",
              "off",
              "brighter",
              "dimmer",
              "brightenWhileHeld",
              "dimWhileHeld",
              "brightenOrDimWhileHeld",
            ],
            labels: {
              toggle: "Turn on or off",
              on: "Turn on",
              off: "Turn off",
              brighter: "Brighten",
              dimmer: "Dim",
              brightenWhileHeld: "While held, brighten",
              dimWhileHeld: "While held, dim",
              brightenOrDimWhileHeld: "While held, brighten or dim",
            },
          },
        },
      },
    });
    expect(lights.presets.map(({ title, config }) => [title, config])).toEqual([
      ["Turn on the lights", { to: "on" }],
      ["Turn off the lights", { to: "off" }],
      ["Turn the lights on or off", { to: "toggle" }],
    ]);
    expect(own("condition", "lights").config).toMatchObject({
      properties: {
        are: {
          labels: { anyOn: "any light is on", allOff: "every light is off" },
        },
      },
    });

    expect(
      Object.fromEntries(
        pieces
          .filter((piece) => piece.kind === "trigger")
          .map((piece) => [`${piece.app ?? "core"} ${piece.id}`, piece.group]),
      ),
    ).toEqual({
      "core manual": "By hand",
      "core time": "Time",
      "core motion": "Motion",
      "core noMotion": "Motion",
      "core sun": "Sunrise and sunset",
      "core device": null,
      "core press": "Buttons",
      "core entity": null,
      "test.sample sample.done": null,
    });
    expect(own("trigger", "time").config).toMatchObject({
      properties: {
        time: { timeOfDay: true },
        days: { days: true },
      },
    });
    expect(own("trigger", "device").config).toMatchObject({
      properties: {
        device: { names: "device" },
        capability: { partOf: "device" },
      },
    });
    expect(own("trigger", "entity")).toMatchObject({
      sentence: null,
      card: null,
      presets: [],
      icon: null,
    });
  });
});
