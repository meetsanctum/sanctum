import {
  aiAssistantPermission,
  defineAction,
  defineApp,
  isActionError,
  type AiToolAnswer,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { agentLimits } from "../src/agents/limits.js";
import { connect, names } from "./agents-support.js";
import { lampsCore } from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import { post, type TestCore } from "./support.js";

// An app the household lets act as its AI assistant lists and calls the
// tools MCP agents get, through ctx.ai, only within a turn a person or a
// shared device opened, and for them: the same switches hold, its own
// offers are left out, its changes can be put back, and its calls count in
// a home pool of their own.

// What an app's code got, or the code it was refused with.
async function attempt<T>(work: () => Promise<T>) {
  try {
    return { got: await work() };
  } catch (error) {
    if (isActionError(error)) return { refused: error.code };
    return { failed: true };
  }
}

const tools = defineAction({
  id: "assistant.tools",
  title: "List the tools",
  tier: "read",
  turn: true,
  input: z.object({}),
  output: z.unknown(),
  run: (ctx) => attempt(() => ctx.ai.list()),
});

// A read, so the call itself isn't logged and the Activity entries' first
// cause is the assistant acting for the person, as a request's will be.
const use = defineAction({
  id: "assistant.use",
  title: "Call tools",
  tier: "read",
  turn: true,
  input: z.object({
    calls: z.array(
      z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }),
    ),
  }),
  output: z.unknown(),
  async run(ctx, { calls }) {
    const answers: AiToolAnswer[] = [];
    for (const call of calls)
      answers.push(await ctx.ai.call(call.name, call.input));
    return answers;
  },
});

const plain = defineAction({
  id: "assistant.plain",
  title: "List without a turn",
  tier: "read",
  input: z.object({}),
  output: z.unknown(),
  run: (ctx) => attempt(() => ctx.ai.list()),
});

// What the assistant offers AI agents itself, which it never sees.
const own = defineAction({
  id: "assistant.own",
  title: "Say hello",
  tier: "read",
  input: z.object({}),
  output: z.object({ hello: z.boolean() }),
  assistant: { starts: "on", description: "Says hello." },
  run: async () => ({ hello: true }),
});

const assistantPackage: AppPackage = {
  app: defineApp({
    id: "sanctum.assistant",
    name: "Assistant",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [
      {
        id: aiAssistantPermission,
        reason: "To do what you ask.",
        needed: true,
      },
    ],
    actions: [tools, use, plain, own],
    events: [],
  }),
  origin: "official",
};

const withoutPackage: AppPackage = {
  app: defineApp({
    id: "sanctum.without",
    name: "Without",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [],
    actions: [tools],
    events: [],
  }),
  origin: "official",
};

async function household() {
  return lampsCore({ apps: [assistantPackage, withoutPackage] });
}

type Attempt<T> = { got?: T; refused?: string; failed?: boolean };

async function listed(
  core: TestCore,
  token: string,
  app = "sanctum.assistant",
) {
  const response = await post(
    core,
    `/api/apps/${app}/actions/assistant.tools`,
    {},
    { token },
  );
  expect(response.statusCode).toBe(200);
  return response.json<Attempt<{ name: string; input: object }[]>>();
}

async function used(
  core: TestCore,
  token: string,
  calls: { name: string; input: Record<string, unknown> }[],
) {
  const response = await post(
    core,
    "/api/apps/sanctum.assistant/actions/assistant.use",
    { calls },
    { token },
  );
  expect(response.statusCode).toBe(200);
  return response
    .json<AiToolAnswer[]>()
    .map((answer) => ({ ...answer, json: parsed(answer.text) }));
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("an assistant app's tools", () => {
  it("are the MCP tools, in ctx.models' shape, but its own", async () => {
    const { core, maya } = await household();

    const { got } = await listed(core, maya.token);

    const listedNames = got!.map((tool) => tool.name);
    expect(listedNames).toContain("home_overview");
    expect(listedNames).toContain("lights");
    expect(listedNames).not.toContain("sanctum_assistant_own");
    for (const tool of got!) {
      expect(tool).toEqual({
        name: expect.any(String),
        description: expect.any(String),
        input: expect.objectContaining({ type: "object" }),
      });
    }

    // An MCP agent sees the assistant's offer.
    const agent = core.auth.clients.createAgent({
      name: "Codex on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    expect(await names(await connect(core, agent.token))).toContain(
      "sanctum_assistant_own",
    );
  });

  it("run for the person who opened the turn, and can be put back", async () => {
    const { core, maya, lamp } = await household();

    const [switched] = await used(core, maya.token, [
      {
        name: "device_command",
        input: { device: lamp, capability: "light", command: { on: true } },
      },
    ]);

    expect(switched).toMatchObject({
      isError: false,
      json: { device: lamp, capability: "light", kind: "light" },
    });
    const { change } = switched!.json as { change: string };
    expect(change).toEqual(expect.any(String));
    await vi.waitFor(() =>
      expect(core.devices.get(lamp)?.capabilities[0]?.state).toMatchObject({
        on: true,
      }),
    );

    const agentId = `sanctum.assistant/user:${maya.person.id}`;
    const entry = core.activity
      .recent()
      .find((each) => each.actor === `assistant-run:${agentId}`);
    expect(entry).toMatchObject({ clientName: "Assistant" });
    expect(core.activityViews.info(entry!).who).toEqual({
      kind: "agent",
      id: agentId,
      name: "Assistant",
      addedBy: null,
      askedBy: { kind: "person", id: maya.person.id, name: "Maya" },
    });

    const [restored] = await used(core, maya.token, [
      { name: "restore", input: { change } },
    ]);
    expect(restored).toMatchObject({ isError: false });
    await vi.waitFor(() =>
      expect(core.devices.get(lamp)?.capabilities[0]?.state).toMatchObject({
        on: false,
      }),
    );
  });

  it("hold to the household's switches, and never reach its own", async () => {
    const { core, maya, plug } = await household();

    const [plugged, ownCall] = await used(core, maya.token, [
      {
        name: "device_command",
        input: { device: plug, capability: "power", command: { on: true } },
      },
      { name: "sanctum_assistant_own", input: {} },
    ]);

    // Switches start off for AI agents, so the plug's refusal says where.
    expect(plugged).toMatchObject({
      isError: true,
      text: expect.stringContaining("What AI Agents Can Use"),
    });
    expect(ownCall).toMatchObject({
      isError: true,
      text: 'There\'s no tool called "sanctum_assistant_own".',
    });
  });

  it("need a turn and the permission", async () => {
    const { core, maya } = await household();

    const outside = await post(
      core,
      "/api/apps/sanctum.assistant/actions/assistant.plain",
      {},
      maya,
    );
    expect(outside.json()).toEqual({ refused: "no_turn" });

    expect(await listed(core, maya.token, "sanctum.without")).toEqual({
      failed: true,
    });
  });

  it("count in a home pool apart from MCP agents'", async () => {
    const { core, maya } = await household();
    const calls = Array.from(
      { length: agentLimits.agentPerMinute + 1 },
      () => ({
        name: "home_overview",
        input: {},
      }),
    );

    const answers = await used(core, maya.token, calls);

    expect(answers.slice(0, -1).every((answer) => !answer.isError)).toBe(true);
    expect(answers.at(-1)).toMatchObject({
      isError: true,
      text: expect.stringContaining("Too many calls"),
    });
    // An MCP agent still gets through.
    const agent = core.auth.clients.createAgent({
      name: "Codex on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    expect(await names(await connect(core, agent.token))).toContain(
      "home_overview",
    );
  });
});
