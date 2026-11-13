import { describe, expect, it } from "vitest";
import { z } from "zod";

import { brokenPromises } from "../src/contract.js";
import {
  createAppContext,
  defineAction,
  defineApp,
  defineEvent,
  defineTrigger,
  jobWhen,
  toStaticManifest,
  workflowGraph,
  type CoreCalls,
} from "../src/index.js";

// The pieces an app adds to workflows and the jobs it schedules.

const addItem = defineAction({
  id: "example.addItem",
  title: "Add an item",
  tier: "write",
  input: z.object({ listId: z.string(), name: z.string().min(1) }),
  output: z.object({ itemId: z.string() }),
  run: async (_ctx, input) => ({ itemId: input.name }),
});

const hasItems = defineAction({
  id: "example.hasItems",
  title: "A list has items",
  tier: "read",
  input: z.object({ listId: z.string() }),
  output: z.boolean(),
  run: async () => true,
});

const itemAdded = defineEvent({
  id: "example.itemAdded",
  payload: z.object({ listId: z.string(), itemId: z.string() }),
});

const itemAddedTrigger = defineTrigger({
  id: "example.itemAdded",
  title: "An item is added",
  event: itemAdded,
  config: z.object({ listId: z.string().optional() }),
});

const base = {
  id: "sanctum.example",
  name: "Example",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  actions: [addItem, hasItems],
  events: [itemAdded],
};

const exampleApp = (provides: Parameters<typeof defineApp>[0]["provides"]) =>
  defineApp({ ...base, provides });

describe("an app's workflow pieces", () => {
  it("are its own events and actions", () => {
    expect(
      exampleApp({
        triggers: [itemAddedTrigger],
        conditions: [hasItems],
        steps: [addItem],
      }).provides?.steps,
    ).toEqual([addItem]);
  });

  it("refuse an action or event of another app", () => {
    const other = defineAction({ ...addItem, id: "other.addItem" });
    expect(() => exampleApp({ steps: [other] })).toThrow(
      /not one of its actions/,
    );
    expect(() =>
      exampleApp({
        triggers: [
          { ...itemAddedTrigger, event: { ...itemAdded, id: "x.added" } },
        ],
      }),
    ).toThrow(/own events/);
  });

  it("have conditions that are read actions answering a boolean", () => {
    expect(() => exampleApp({ conditions: [addItem] })).toThrow(/must be read/);
    const reads = defineAction({
      ...hasItems,
      output: z.object({}),
      run: async () => ({}),
    });
    expect(() =>
      defineApp({
        ...base,
        actions: [addItem, reads],
        provides: { conditions: [reads] },
      }),
    ).toThrow(/answers a boolean/);
  });

  it("filter a trigger only on fields its event's payload has", () => {
    expect(() =>
      exampleApp({
        triggers: [
          {
            ...itemAddedTrigger,
            config: z.object({ shop: z.string().optional() }),
          },
        ],
      }),
    ).toThrow(/shop/);
  });

  it("name the optional permissions they need, which the editor asks for", () => {
    const withPeople = (needs: string[], needed = false) => {
      const step = { ...addItem, needs };
      return defineApp({
        ...base,
        permissions: [
          { id: "people.read", reason: "To say who added it.", needed },
        ],
        actions: [step, hasItems],
        provides: { steps: [step] },
      });
    };
    const app = withPeople(["people.read"]);
    expect(toStaticManifest(app).provides.steps).toEqual([
      { id: "example.addItem", words: null, needs: ["people.read"] },
    ]);
    expect(() => withPeople(["places.read"])).toThrow(
      /needs places.read, which the app does not ask for/,
    );
    expect(() => withPeople(["people.read"], true)).toThrow(
      /needs people.read, which the app needs already/,
    );
  });

  it("have unique ids per kind", () => {
    expect(() =>
      exampleApp({ triggers: [itemAddedTrigger, itemAddedTrigger] }),
    ).toThrow(/Duplicate trigger/);
  });

  it("go into the static manifest and its contract", () => {
    const before = toStaticManifest(
      exampleApp({
        triggers: [itemAddedTrigger],
        conditions: [hasItems],
        steps: [addItem],
      }),
    );
    expect(before.provides).toEqual({
      entities: [],
      widgets: [],
      roomSections: [],
      devicePages: [],
      triggers: [
        {
          id: "example.itemAdded",
          title: "An item is added",
          event: "example.itemAdded",
          config: expect.objectContaining({ type: "object" }),
          words: null,
          needs: [],
        },
      ],
      conditions: [{ id: "example.hasItems", words: null, needs: [] }],
      steps: [{ id: "example.addItem", words: null, needs: [] }],
    });
    const after = toStaticManifest(
      defineApp({ ...base, version: "0.1.1", provides: {} }),
    );
    expect(brokenPromises(before, after)).toEqual([
      "trigger example.itemAdded",
      "condition example.hasItems",
      "step example.addItem",
    ]);
  });
});

describe("jobs", () => {
  it("run once, every so often, daily or at the sun", () => {
    expect(jobWhen.parse({ at: "2026-10-30T07:00:00Z" })).toEqual({
      at: "2026-10-30T07:00:00Z",
    });
    expect(jobWhen.parse({ every: 300 })).toEqual({ every: 300, offset: 0 });
    expect(jobWhen.parse({ daily: "07:30", days: ["mon"] })).toEqual({
      daily: "07:30",
      days: ["mon"],
    });
    expect(jobWhen.parse({ sun: "sunset" })).toEqual({
      sun: "sunset",
      offsetMinutes: 0,
    });
    expect(jobWhen.safeParse({ every: 10 }).success).toBe(false);
    expect(jobWhen.safeParse({ daily: "25:00" }).success).toBe(false);
  });

  it("cross into the core as messages, with the action by its id", async () => {
    const calls: unknown[] = [];
    const record = async (call: unknown) => {
      calls.push(call);
      return undefined as never;
    };
    const core = {
      emit: record,
      scheduleJob: record,
      cancelJob: record,
      jobs: async () => [],
    } as unknown as CoreCalls;
    const ctx = createAppContext({
      appId: "sanctum.example",
      actor: { kind: "app", id: "sanctum.example" },
      core,
    });
    await ctx.events.emit(itemAdded, { listId: "board", itemId: "milk" });
    await ctx.jobs.schedule({
      key: "tidy",
      action: addItem,
      input: { listId: "board", name: "milk" },
      when: { every: 3600 },
    });
    await ctx.jobs.cancel("tidy");
    expect(calls).toEqual([
      {
        event: "example.itemAdded",
        payload: { listId: "board", itemId: "milk" },
      },
      {
        key: "tidy",
        action: "example.addItem",
        input: { listId: "board", name: "milk" },
        when: { every: 3600 },
      },
      "tidy",
    ]);
  });
});

describe("a workflow's graph", () => {
  it("is nodes and edges", () => {
    const graph = workflowGraph.parse({
      nodes: [
        { id: "t", kind: "trigger", piece: "time", config: { time: "07:00" } },
        {
          id: "s",
          kind: "step",
          app: "sanctum.moods",
          piece: "moods.runMood",
          config: { id: "m" },
        },
      ],
      edges: [{ from: "t", to: "s" }],
    });
    expect(graph.version).toBe(1);
    expect(
      workflowGraph.safeParse({ ...graph, nodes: [{ id: "x", kind: "logic" }] })
        .success,
    ).toBe(false);
  });
});
