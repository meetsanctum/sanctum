import { defineAction, defineApp, names } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { schemaCheck } from "../src/app-host/contract.js";
import { namedInSchema } from "../src/workflows/named.js";
import { claimed, get, post, testCore } from "./support.js";
import { addWorkflow, runByHand, steps, trigger } from "./workflows-support.js";

describe("references declared in a manifest", () => {
  it.each(["a/b", "a~b", "a%b", "a%2Fb", "a#b", "a b"])(
    "resolves union defaults and references in a field called %s",
    (key) => {
      const schema = z.object({
        [key]: z.union([
          z.object({ room: names("room").default("study") }),
          z.number(),
        ]),
      });
      const json = z.toJSONSchema(schema, { io: "input" });
      const value = { [key]: {} };

      expect(schemaCheck(json)(value)).toEqual({
        success: true,
        data: { [key]: { room: "study" } },
      });
      expect(namedInSchema(json, value)).toEqual([
        { kind: "room", id: "study", field: `${key}.room` },
      ]);
    },
  );
  it.each([
    ["a root default", names("room").default("study"), undefined, ""],
    [
      "a nested object default",
      z.object({ room: names("room") }).default({ room: "study" }),
      undefined,
      "room",
    ],
    [
      "an omitted tuple item",
      z.tuple([names("room").default("study")]),
      [],
      "0",
    ],
    [
      "a record key",
      z.record(names("room"), z.boolean()),
      { study: true },
      "study",
    ],
    [
      "a record value",
      z.record(z.string(), names("room")),
      { first: "study" },
      "first",
    ],
    ["a tuple rest", z.tuple([z.number()], names("room")), [1, "study"], "1"],
  ])("finds %s", (_label, schema, value, field) => {
    const json = z.toJSONSchema(schema, { io: "input" });

    expect(namedInSchema(json, value)).toEqual([
      { kind: "room", id: "study", field },
    ]);
  });

  it("follows local references and recursive union branches", () => {
    const room = z.object({
      room: names("room"),
      get children() {
        return z.array(room).optional();
      },
    });
    const schema = z.object({
      choice: z.union([room, z.object({ kind: z.literal("home") })]),
    });
    const json = z.toJSONSchema(schema, { io: "input" });

    expect(
      namedInSchema(json, {
        choice: { room: "study", children: [{ room: "hall" }] },
      }),
    ).toEqual([
      { kind: "room", id: "study", field: "choice.room" },
      { kind: "room", id: "hall", field: "choice.children.0.room" },
    ]);
    expect(namedInSchema(json, { choice: { kind: "home" } })).toEqual([]);
  });

  it("follows references to the root schema", () => {
    const schema = z.object({
      room: names("room"),
      get child() {
        return schema.optional();
      },
    });

    expect(
      namedInSchema(z.toJSONSchema(schema, { io: "input" }), {
        room: "study",
        child: { room: "hall" },
      }),
    ).toEqual([
      { kind: "room", id: "study", field: "room" },
      { kind: "room", id: "hall", field: "child.room" },
    ]);
  });

  it("refuses a missing record-key room and marks the workflow broken when that room goes", async () => {
    const visit = defineAction({
      id: "visitor.visit",
      title: "Visit rooms",
      tier: "write",
      input: z.object({ rooms: z.record(names("room"), z.boolean()) }),
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
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const { token } = await claimed(core);
    const graph = (room: string) =>
      steps(trigger("t", "manual"), {
        id: "visit",
        kind: "step",
        app: app.id,
        piece: visit.id,
        config: { rooms: { [room]: true } },
      });

    const refused = await post(
      core,
      "/api/workflows/add",
      {
        name: "Visit rooms",
        graph: graph("missing"),
      },
      { token },
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().problems).toContainEqual({
      node: "visit",
      field: "rooms.missing",
      message: "There is no room missing",
    });

    const room = (
      await post(core, "/api/places/rooms/add", { name: "Study" }, { token })
    ).json() as { id: string };
    const workflow = await addWorkflow(core, token, {
      name: "Visit rooms",
      graph: graph(room.id),
    });
    const preview = await get(core, `/api/places/rooms/removal?id=${room.id}`, {
      token,
    });
    expect(preview.json().workflows).toEqual([
      { id: workflow.id, name: "Visit rooms" },
    ]);

    await post(core, "/api/places/rooms/remove", { id: room.id }, { token });
    expect((await runByHand(core, token, workflow.id)).json()).toMatchObject({
      status: "skipped",
      reason: "broken",
    });
  });
});
