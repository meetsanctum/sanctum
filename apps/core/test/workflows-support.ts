import {
  defineAction,
  defineApp,
  defineEvent,
  defineTrigger,
  jobWhen,
  names,
  type Actor,
  type WorkflowGraph,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { AppPackage } from "./runner-apps.js";
import { get, post, type TestCore } from "./support.js";

// An app for the workflow tests: Sample emits an event when a task is done,
// provides a trigger on it, a condition and steps, and schedules jobs for
// itself. Tests hold its steps open and read what reached it through `sample`.

type Hold = { promise: Promise<void>; release: () => void };

export const sample = {
  // What each step and job saw, with the actor behind it.
  noted: [] as { text: string; actor: Actor }[],
  ticks: [] as Actor[],
  due: new Set<string>(),
  // While set, the note step waits for it.
  hold: undefined as Hold | undefined,
  reset() {
    this.noted.length = 0;
    this.ticks.length = 0;
    this.due.clear();
    this.hold = undefined;
  },
  holdSteps() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.hold = { promise, release };
    return release;
  },
};

const done = defineEvent({
  id: "sample.done",
  payload: z.object({ task: z.string(), room: z.string() }),
});

const finish = defineAction({
  id: "sample.finish",
  title: "Finish a task",
  tier: "write",
  input: z.object({
    task: z.string(),
    room: z.string(),
    fail: z.boolean().default(false),
  }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.events.emit(done, { task: input.task, room: input.room });
    if (input.fail) {
      throw new Error("the task fell over");
    }
    return {};
  },
});

const note = defineAction({
  id: "sample.note",
  title: "Write a note",
  tier: "write",
  // Whose turn it was, which the editor asks for as the note is added.
  needs: ["people.read"],
  input: z.object({ text: z.string() }),
  output: z.object({ noted: z.number() }),
  async run(ctx, input) {
    sample.noted.push({ text: input.text, actor: ctx.actor });
    await sample.hold?.promise;
    return { noted: sample.noted.length };
  },
});

const wipe = defineAction({
  id: "sample.wipe",
  title: "Wipe every task",
  tier: "destructive",
  input: z.object({}),
  output: z.object({}),
  run: async () => ({}),
});

const isDue = defineAction({
  id: "sample.isDue",
  title: "A task is due",
  tier: "read",
  input: z.object({ task: z.string() }),
  output: z.boolean(),
  run: async (_ctx, input) => sample.due.has(input.task),
});

const tick = defineAction({
  id: "sample.tick",
  title: "Look at what is due",
  tier: "write",
  input: z.object({}),
  output: z.object({}),
  async run(ctx) {
    sample.ticks.push(ctx.actor);
    return {};
  },
});

// Schedules one of its own actions, as an app would from its pages.
const plan = defineAction({
  id: "sample.plan",
  title: "Plan a job",
  tier: "write",
  input: z.object({
    key: z.string(),
    action: z.enum(["sample.tick", "sample.wipe"]).default("sample.tick"),
    when: jobWhen,
  }),
  output: z.object({ nextAt: z.string().nullable() }),
  async run(ctx, input) {
    const job = await ctx.jobs.schedule({
      key: input.key,
      action: input.action === "sample.tick" ? tick : wipe,
      input: {},
      when: input.when,
    });
    return { nextAt: job.nextAt };
  },
});

export const choresApp = defineApp({
  id: "test.sample",
  name: "Sample",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [
    {
      id: "people.read",
      reason: "To say whose turn it was.",
      asked: "when you add a note to an automation",
    },
  ],
  actions: [finish, note, wipe, isDue, tick, plan],
  events: [done],
  provides: {
    triggers: [
      defineTrigger({
        id: "sample.done",
        title: "A task is done",
        event: done,
        config: z.object({
          room: z.string().optional(),
          task: z.string().optional(),
        }),
      }),
    ],
    conditions: [isDue],
    steps: [note, wipe],
  },
});

export const samplePackage: AppPackage = {
  app: choresApp,
  origin: "official",
};

// Vacuum, an app whose step names a room or a zone: its place declares them
// with names(), as the core's lights pieces do.
const place = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("room"), id: names("room") }),
  z.object({ kind: z.literal("zone"), id: names("zone") }),
  z.object({ kind: z.literal("home") }),
]);

const clean = defineAction({
  id: "vacuum.clean",
  title: "Clean",
  tier: "write",
  input: z.object({ place }),
  output: z.object({}),
  run: async () => ({}),
});

export const vacuumPackage: AppPackage = {
  app: defineApp({
    id: "test.vacuum",
    name: "Vacuum",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [],
    actions: [clean],
    events: [],
    provides: { steps: [clean] },
  }),
  origin: "official",
};

type Node = WorkflowGraph["nodes"][number];

export const trigger = (
  id: string,
  piece: string,
  config: Record<string, unknown> = {},
  app?: string,
): Node => ({ id, kind: "trigger", piece, config, ...(app && { app }) });

export const noteStep = (id: string, text = id): Node => ({
  id,
  kind: "step",
  app: "test.sample",
  piece: "sample.note",
  config: { text },
});

export const cleanStep = (id: string, where: z.input<typeof place>): Node => ({
  id,
  kind: "step",
  app: "test.vacuum",
  piece: "vacuum.clean",
  config: { place: where },
});

/** The core's lights step, switching a place's lights off. */
export const lightsOff = (id: string, where: z.input<typeof place>): Node => ({
  id,
  kind: "step",
  piece: "lights",
  config: { place: where, to: "off" },
});

/** A graph whose trigger leads straight to each of its steps, in order. */
export function steps(start: Node, ...nodes: Node[]): WorkflowGraph {
  return {
    version: 1,
    nodes: [start, ...nodes],
    edges: nodes.map((node) => ({ from: start.id, to: node.id })),
  };
}

export async function addWorkflow(
  core: TestCore,
  token: string,
  body: { name?: string; runMode?: string; enabled?: boolean; graph: unknown },
) {
  const response = await post(
    core,
    "/api/workflows/add",
    { name: "Test", ...body },
    { token },
  );
  if (response.statusCode !== 200) {
    throw new Error(`add failed: ${response.body}`);
  }
  return response.json() as { id: string; warnings: string[] };
}

export async function runsOf(core: TestCore, token: string, id: string) {
  return (
    await get(core, `/api/workflows/runs?workflow=${id}`, { token })
  ).json() as {
    id: string;
    status: string;
    reason: string | null;
    error: string | null;
    trigger: { nodes: string[]; data: unknown };
    steps: {
      node: string;
      status: string;
      output: unknown;
      error: string | null;
    }[];
  }[];
}

export async function runByHand(core: TestCore, token: string, id: string) {
  return post(core, "/api/workflows/run", { id }, { token });
}
