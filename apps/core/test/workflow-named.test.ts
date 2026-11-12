import {
  defineAction,
  defineApp,
  names,
  toStaticManifest,
  type WorkflowInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppPackage } from "./runner-apps.js";
import { namedIn } from "../src/workflows/named.js";
import { lampsCore, radio } from "./devices-support.js";
import { get, post } from "./support.js";
import {
  addWorkflow,
  cleanStep,
  lightsOff,
  runByHand,
  runsOf,
  steps,
  trigger,
  vacuumPackage,
} from "./workflows-support.js";

// What a workflow names: the rooms, zones and devices in the fields its pieces
// declare with names(), the core's own and apps'. Saving refuses one there is
// none of, and one removed later breaks the workflow, which says so in its
// problems and does not run until it is changed. Each problem names the node
// and the field that names what is gone, for the editor to mark.

async function home(apps: AppPackage[] = []) {
  const context = await lampsCore({ apps: [vacuumPackage, ...apps] });
  const { core, maya } = context;
  const add = async (path: string, body: object) =>
    (await post(core, path, body, maya)).json().id as string;
  const remove = (path: string, id: string) => post(core, path, { id }, maya);
  const problemsOf = async (id: string) =>
    ((await get(core, "/api/workflows", maya)).json() as WorkflowInfo[]).find(
      (workflow) => workflow.id === id,
    )!.problems;
  return { ...context, token: maya.token, add, remove, problemsOf };
}

describe("what a config names", () => {
  it("is found along its schema, in the fields that declare it", () => {
    const schema = z.object({
      place: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("room"), id: names("room") }),
        z.object({ kind: z.literal("zone"), id: names("zone") }),
      ]),
      lights: z
        .array(z.object({ device: names("device"), capability: z.string() }))
        .default([]),
      spare: names("device").optional(),
      note: z.string(),
    });

    expect(
      namedIn(schema, {
        place: { kind: "zone", id: "upstairs" },
        lights: [{ device: "lamp", capability: "light" }],
        note: "kitchen",
      }),
    ).toEqual([
      { kind: "zone", id: "upstairs", field: "place.id" },
      { kind: "device", id: "lamp", field: "lights.0.device" },
    ]);
  });

  it("is marked in the piece's JSON Schema, for the editor", async () => {
    const { core, token } = await home();
    const pieces = (
      await get(core, "/api/workflows/pieces", { token })
    ).json() as {
      kind: string;
      app: string | null;
      id: string;
      config: unknown;
    }[];
    const own = (kind: string, id: string) =>
      pieces.find(
        (piece) => piece.app === null && piece.kind === kind && piece.id === id,
      );

    expect(JSON.stringify(own("step", "lights")!.config)).toContain(
      '"names":"room"',
    );
    expect(
      JSON.stringify(pieces.find((piece) => piece.id === "vacuum.clean")),
    ).toContain('"names":"zone"');
    expect(own("trigger", "device")).toMatchObject({
      config: { properties: { device: { names: "device" } } },
    });
  });
});

describe("a workflow that names a room", () => {
  it("checks a default room when saving, previewing removal and running", async () => {
    const visit = defineAction({
      id: "visitor.visit",
      title: "Visit a room",
      tier: "write",
      input: z.object({ room: names("room").default("missing-room") }),
      output: z.object({}),
      run: async () => ({}),
    });
    const app = defineApp({
      id: "test.visitor",
      name: "Visitor",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [visit],
      events: [],
      provides: { steps: [visit] },
    });
    // A manifest's default is fixed when it's written, so this one is rewritten
    // once there is a room for it to name.
    const manifest = toStaticManifest(app);
    const room = (
      manifest.actions[0]!.input as unknown as {
        properties: { room: { default: string } };
      }
    ).properties.room;
    const { core, token, add, remove, problemsOf } = await home([
      { app, manifest, origin: "official" },
    ]);
    const graph = steps(trigger("t", "manual"), {
      id: "visit",
      kind: "step",
      app: app.id,
      piece: visit.id,
      config: {},
    });
    const refused = await post(
      core,
      "/api/workflows/add",
      { name: "Visit", graph },
      { token },
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().problems).toEqual([
      {
        node: "visit",
        field: "room",
        message: "There is no room missing-room",
      },
    ]);

    const defaultRoom = await add("/api/places/rooms/add", { name: "Study" });
    room.default = defaultRoom;
    const { id } = await addWorkflow(core, token, { name: "Visit", graph });
    const preview = await get(
      core,
      `/api/places/rooms/removal?id=${defaultRoom}`,
      { token },
    );
    expect(preview.json().workflows).toEqual([{ id, name: "Visit" }]);
    await remove("/api/places/rooms/remove", defaultRoom);
    expect(await problemsOf(id)).toEqual([
      {
        node: "visit",
        field: "room",
        message: "The room it names was removed",
      },
    ]);
    expect((await runByHand(core, token, id)).json()).toMatchObject({
      status: "skipped",
      reason: "broken",
    });
    expect((await runsOf(core, token, id))[0]!.steps).toEqual([]);
  });

  it("lists the room once it is removed, and is skipped as broken", async () => {
    const { core, token, add, remove, problemsOf } = await home();
    const study = await add("/api/places/rooms/add", { name: "Study" });
    const kitchen = await add("/api/places/rooms/add", { name: "Kitchen" });
    const studyOff = await addWorkflow(core, token, {
      name: "Study lights off",
      enabled: false,
      graph: steps(
        trigger("t", "manual"),
        lightsOff("off", { kind: "room", id: study }),
      ),
    });
    const kitchenOff = await addWorkflow(core, token, {
      name: "Kitchen lights off",
      graph: steps(
        trigger("t", "manual"),
        lightsOff("off", { kind: "room", id: kitchen }),
      ),
    });
    expect(await problemsOf(studyOff.id)).toEqual([]);

    await remove("/api/places/rooms/remove", study);

    expect(await problemsOf(studyOff.id)).toEqual([
      {
        node: "off",
        field: "place.id",
        message: "The room it names was removed",
      },
    ]);
    expect(await problemsOf(kitchenOff.id)).toEqual([]);
    expect((await runByHand(core, token, studyOff.id)).json()).toMatchObject({
      status: "skipped",
      reason: "broken",
      error: "The room it names was removed",
    });
    const [run] = await runsOf(core, token, studyOff.id);
    expect(run!.steps).toEqual([]);
    expect(radio.received).toEqual([]);
  });

  it("is saved again only once it names a room there is", async () => {
    const { core, token, add, remove, problemsOf } = await home();
    const study = await add("/api/places/rooms/add", { name: "Study" });
    const office = await add("/api/places/rooms/add", { name: "Office" });
    const graph = steps(
      trigger("t", "manual"),
      lightsOff("off", { kind: "room", id: study }),
    );
    const { id } = await addWorkflow(core, token, { graph });
    await remove("/api/places/rooms/remove", study);

    const unchanged = await post(
      core,
      "/api/workflows/update",
      { id, graph },
      { token },
    );
    expect(unchanged.json()).toEqual({
      error: "invalid_workflow",
      problems: [
        {
          node: "off",
          field: "place.id",
          message: `There is no room ${study}`,
        },
      ],
    });

    const changed = await post(
      core,
      "/api/workflows/update",
      {
        id,
        graph: steps(
          trigger("t", "manual"),
          lightsOff("off", { kind: "room", id: office }),
        ),
      },
      { token },
    );
    expect(changed.statusCode).toBe(200);
    expect(await problemsOf(id)).toEqual([]);
  });
});

describe("a workflow that names a zone or a device", () => {
  it("lists each once it is removed, in an app's piece as in the core's", async () => {
    const { core, token, lamp, add, remove, problemsOf } = await home();
    const upstairs = await add("/api/places/zones/add", {
      name: "Upstairs",
      roomIds: [],
    });
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("t", "device", { device: lamp, field: "on" }),
        cleanStep("clean", { kind: "zone", id: upstairs }),
      ),
    });

    await remove("/api/places/zones/remove", upstairs);
    const zoneGone = {
      node: "clean",
      field: "place.id",
      message: "The zone it names was removed",
    };
    expect(await problemsOf(id)).toEqual([zoneGone]);
    expect((await remove("/api/devices/remove", lamp)).statusCode).toBe(200);
    expect(await problemsOf(id)).toEqual([
      {
        node: "t",
        field: "device",
        message: "The device it names was removed",
      },
      zoneGone,
    ]);
    // A run says why it was skipped in words.
    expect((await runByHand(core, token, id)).json()).toMatchObject({
      reason: "broken",
      error: "The device it names was removed. The zone it names was removed",
    });
  });

  it("is not saved while there is none of one it names", async () => {
    const { core, token, lamp } = await home();
    const refused = await post(
      core,
      "/api/workflows/add",
      {
        name: "Nowhere",
        graph: steps(
          trigger("t", "manual"),
          cleanStep("attic", { kind: "room", id: "attic" }),
          cleanStep("loft", { kind: "zone", id: "loft" }),
          cleanStep("home", { kind: "home" }),
          {
            id: "nope",
            kind: "step",
            piece: "device",
            config: {
              device: "nope",
              capability: "light",
              command: { on: true },
            },
          },
          {
            id: "lamp",
            kind: "step",
            piece: "device",
            config: {
              device: lamp,
              capability: "light",
              command: { on: true },
            },
          },
        ),
      },
      { token },
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.json().problems).toEqual([
      { node: "attic", field: "place.id", message: "There is no room attic" },
      { node: "loft", field: "place.id", message: "There is no zone loft" },
      { node: "nope", field: "device", message: "There is no device nope" },
    ]);
  });
});
