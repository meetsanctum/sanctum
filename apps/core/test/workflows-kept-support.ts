import {
  defineAction,
  defineApp,
  defineEvent,
  defineTrigger,
  workflowGraph,
  type WorkflowGraph,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { AppPackage } from "./runner-apps.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";
import { sample, samplePackage, steps, trigger } from "./workflows-support.js";

// What the tests of workflows an app keeps share: an app that keeps them, and a
// home with it.

export const rang = defineEvent({
  id: "keeper.rang",
  payload: z.object({ bell: z.string() }),
});

export const heard: string[] = [];

export const listen = defineAction({
  id: "keeper.listen",
  title: "Listen",
  tier: "write",
  input: z.object({ text: z.string() }),
  output: z.object({}),
  async run(_ctx, input) {
    heard.push(input.text);
    await sample.hold?.promise;
    return {};
  },
});

export const ring = defineAction({
  id: "keeper.ring",
  title: "Ring",
  tier: "write",
  input: z.object({ bell: z.string() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.events.emit(rang, input);
    return {};
  },
});

export const keep = defineAction({
  id: "keeper.keep",
  title: "Keep a workflow",
  tier: "write",
  input: z.object({
    key: z.string(),
    name: z.string(),
    graph: workflowGraph,
    enabled: z.boolean().optional(),
  }),
  output: z.object({ id: z.string(), version: z.number() }),
  async run(ctx, { key, ...workflow }) {
    const kept = await ctx.workflows.put(key, workflow);
    return { id: kept.id, version: kept.version };
  },
});

export const drop = defineAction({
  id: "keeper.drop",
  title: "Drop a workflow",
  tier: "write",
  input: z.object({ key: z.string() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.workflows.remove(input.key);
    return {};
  },
});

export const list = defineAction({
  id: "keeper.list",
  title: "List its workflows",
  tier: "read",
  input: z.object({}),
  output: z.object({ keys: z.array(z.string().nullable()) }),
  async run(ctx) {
    return { keys: (await ctx.workflows.list()).map((each) => each.appKey) };
  },
});

export function keeper(
  permissions = ["workflows.manage"],
  needed?: string,
): AppPackage {
  return {
    origin: "official",
    app: defineApp({
      id: "test.keeper",
      name: "Keeper",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: permissions.map((id) => ({
        id,
        reason: "For the test.",
        needed: id === needed,
      })),
      actions: [listen, ring, keep, drop, list],
      events: [rang],
      provides: {
        triggers: [
          defineTrigger({
            id: "keeper.rang",
            title: "A bell rings",
            event: rang,
            config: z.object({ bell: z.string().optional() }),
          }),
        ],
        steps: [listen],
      },
    }),
  };
}

// When the bell rings, Keeper listens: its own trigger and step.
export function bellGraph(bell: string, text = bell): WorkflowGraph {
  return steps(trigger("rang", "keeper.rang", { bell }, "test.keeper"), {
    id: "listen",
    kind: "step",
    app: "test.keeper",
    piece: "keeper.listen",
    config: { text },
  });
}

export type SignedIn = Awaited<ReturnType<typeof claimed>>;

export async function home(apps: AppPackage[] = [keeper()]) {
  heard.length = 0;
  const core = await testCore({ apps: [samplePackage, ...apps] });
  const maya = await claimed(core);
  return { core, maya };
}

export function call(
  core: TestCore,
  maya: SignedIn,
  action: string,
  input: object,
) {
  return post(core, `/api/apps/test.keeper/actions/${action}`, input, maya);
}

export async function listed(core: TestCore, maya: SignedIn) {
  return (await get(core, "/api/workflows", { token: maya.token })).json() as {
    id: string;
    name: string;
    app: string | null;
    appKey: string | null;
    version: number;
    createdBy: string | null;
  }[];
}
