import {
  aiAssistantPermission,
  defineAction,
  defineApp,
  isActionError,
  type ActionDefinition,
  type AiToolAnswer,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAssistantCalls } from "../src/agents/assistants.js";
import { agentLimits, createAgentLimiter } from "../src/agents/limits.js";
import { createGate } from "../src/app-host/gate.js";
import { connect, names } from "./agents-support.js";
import { lampsCore, personWithClient, radio } from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import {
  deferredDelivery,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

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
  id: "example.tools",
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
  id: "example.use",
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

const tryTools = (turn: boolean) =>
  defineAction({
    id: turn ? "example.check" : "example.plain",
    title: "Check tool access",
    tier: "read",
    ...(turn ? { turn: true } : {}),
    input: z.object({}),
    output: z.unknown(),
    async run(ctx) {
      return {
        list: await attempt(() => ctx.ai.list()),
        call: await attempt(() => ctx.ai.call("home_overview")),
      };
    },
  });

const malformed = defineAction({
  id: "example.malformed",
  title: "Call with malformed input",
  tier: "read",
  turn: true,
  input: z.object({}),
  output: z.unknown(),
  async run(ctx) {
    try {
      // The core must validate what comes over the socket.
      await ctx.ai.call(
        "home_overview",
        [] as unknown as Record<string, unknown>,
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
});

// What the assistant offers AI agents itself, which it never sees.
const own = defineAction({
  id: "example.own",
  title: "Say hello",
  tier: "read",
  input: z.object({}),
  output: z.object({ hello: z.boolean() }),
  assistant: { starts: "on", description: "Says hello." },
  run: async () => ({ hello: true }),
});

function assistantPackage(
  permitted: boolean,
  extraActions: ActionDefinition[],
): AppPackage {
  return {
    app: defineApp({
      id: "sanctum.example",
      name: "Assistant",
      version: "0.1.0",
      core: "^2.0.0",
      permissions: permitted
        ? [
            {
              id: aiAssistantPermission,
              reason: "To do what you ask.",
              needed: true,
            },
          ]
        : [],
      actions: [
        tools,
        use,
        tryTools(true),
        tryTools(false),
        malformed,
        own,
        ...extraActions,
      ],
      events: [],
    }),
    origin: "official",
  };
}

const toolTarget: AppPackage = {
  app: defineApp({
    id: "test.tool-target",
    name: "Tool target",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [],
    actions: [
      defineAction({
        id: "toolTarget.report",
        title: "Report the caller",
        tier: "read",
        assistant: { starts: "on", description: "Reports who called." },
        input: z.object({ large: z.boolean().optional() }),
        output: z.unknown(),
        run: async (ctx, { large }) =>
          large ? '"'.repeat(350_000) : ctx.actor,
      }),
    ],
    events: [],
  }),
  origin: "system",
};

async function household({
  permitted = true,
  apps = [],
  extraActions = [],
  agentCommandLimits,
}: {
  permitted?: boolean;
  apps?: AppPackage[];
  extraActions?: ActionDefinition[];
  agentCommandLimits?: NonNullable<
    Parameters<typeof lampsCore>[0]
  >["agentCommandLimits"];
} = {}) {
  return lampsCore({
    apps: [assistantPackage(permitted, extraActions), ...apps],
    agentCommandLimits,
  });
}

type Attempt<T> = { got?: T; refused?: string; failed?: boolean };

async function listed(core: TestCore, token: string) {
  const response = await post(
    core,
    "/api/apps/sanctum.example/actions/example.tools",
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
    "/api/apps/sanctum.example/actions/example.use",
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
    expect(listedNames).not.toContain("sanctum_example_own");
    for (const tool of got!) {
      expect(tool).toEqual({
        name: expect.any(String),
        description: expect.any(String),
        input: expect.objectContaining({ type: "object" }),
      });
    }

    // An MCP agent sees the assistant's offer.
    const agent = core.auth.clients.createAgent({
      name: "Agent on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    expect(await names(await connect(core, agent.token))).toContain(
      "sanctum_example_own",
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

    const agentId = `sanctum.example/user:${maya.person.id}`;
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

    const restore = [{ name: "restore", input: { change } }];
    const tablet = sharedClient(core);
    const [refused] = await used(core, tablet.token, restore);
    expect(refused).toMatchObject({ isError: true });
    expect(core.devices.get(lamp)?.capabilities[0]?.state).toMatchObject({
      on: true,
    });

    const [restored] = await used(core, maya.token, restore);
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
      { name: "sanctum_example_own", input: {} },
    ]);

    // Switches start off for AI agents, so the plug's refusal says where.
    expect(plugged).toMatchObject({
      isError: true,
      text: expect.stringContaining("What AI Agents Can Use"),
    });
    expect(ownCall).toMatchObject({
      isError: true,
      text: 'There\'s no tool called "sanctum_example_own".',
    });
  });

  it.each([
    { permitted: true, action: "plain", refusal: { refused: "no_turn" } },
    { permitted: false, action: "check", refusal: { failed: true } },
  ])(
    "checks tool access in example.$action",
    async ({ permitted, action, refusal }) => {
      const { core, maya } = await household({ permitted });
      const dispatch = vi.spyOn(core.agentTools, "call");

      const response = await post(
        core,
        `/api/apps/sanctum.example/actions/example.${action}`,
        {},
        maya,
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ list: refusal, call: refusal });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("validates tool input before dispatch", async () => {
    const { core, maya } = await household();
    const dispatch = vi.spyOn(core.agentTools, "call");
    const response = await post(
      core,
      "/api/apps/sanctum.example/actions/example.malformed",
      {},
      maya,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBe(
      "A tool's call is its name and an input object",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops a queued light command once its turn closes", async () => {
    const settling = deferredDelivery();
    const releaseHold = deferredDelivery();
    const detached = defineAction({
      id: "example.detached",
      title: "Close the turn with a tool pending",
      tier: "read",
      turn: true,
      input: z.object({}),
      output: z.boolean(),
      async run(ctx) {
        void ctx.ai
          .call("lights", { place: { kind: "home" }, to: "dimmer" })
          .catch(() => undefined) // The test checks the tool's result in the core.
          .finally(settling.resolve);
        await settling.promise;
        return true;
      },
    });
    const { core, maya, lamp } = await household({ extraActions: [detached] });
    expect(
      await used(core, maya.token, [
        {
          name: "device_command",
          input: {
            device: lamp,
            capability: "light",
            command: { on: true, brightness: 50 },
          },
        },
      ]),
    ).toMatchObject([{ isError: false }]);
    const settle = vi
      .spyOn(core.holds, "settle")
      .mockImplementation(async () => {
        settling.resolve();
        await releaseHold.promise;
      });
    const dispatch = vi.spyOn(core.agentTools, "call");
    try {
      const response = await post(
        core,
        "/api/apps/sanctum.example/actions/example.detached",
        {},
        maya,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toBe(true);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      releaseHold.resolve();
    }
    expect(await dispatch.mock.results[0]?.value).toMatchObject({
      isError: true,
    });
    expect(radio.received).toHaveLength(1);
  });

  it("keeps concurrent turns for the same agent independent", async () => {
    const core = await testCore();
    const gate = createGate(
      core.people,
      () => true,
      () => true,
    );
    const release = deferredDelivery();
    const assistant = createAssistantCalls({
      tools: () => ({
        list: () => [],
        async call(agent, name) {
          const rule = { tier: "write" } as const;
          const actor = gate.admit(agent, rule);
          if (name === "wait") await release.promise;
          gate.permit(actor, rule);
          return { content: [{ type: "text", text: "Done" }] };
        },
      }),
      appName: () => "Assistant",
      canActFor: () => true,
      limiter: createAgentLimiter(),
      logLimited: () => {},
      duringCall: (_id, work) => work(),
      newCallId: () => "call",
    });
    const opener = { kind: "user", id: "person" } as const;
    let ended = false;
    const queued = assistant.call(
      "sanctum.example",
      opener,
      "wait",
      {},
      () => ended,
    );

    ended = true;
    const other = assistant.call(
      "sanctum.example",
      opener,
      "run",
      {},
      () => false,
    );
    release.resolve();
    await expect(queued).rejects.toMatchObject({ code: "forbidden" });
    await expect(other).resolves.toEqual({ isError: false, text: "Done" });
  });

  it.each(["person", "shared device"])(
    "checks a revoked %s during an open turn",
    async (opener) => {
      const opened = deferredDelivery();
      const continueTurn = deferredDelivery();
      const afterRevocation = defineAction({
        id: "example.recheck",
        title: "Recheck tool access",
        tier: "read",
        turn: true,
        input: z.object({}),
        output: z.unknown(),
        async run(ctx) {
          opened.resolve();
          await continueTurn.promise;
          return {
            list: await attempt(() => ctx.ai.list()),
            call: await attempt(() => ctx.ai.call("home_overview")),
          };
        },
      });
      const { core, maya } = await household({
        extraActions: [afterRevocation],
      });
      const client =
        opener === "person" ? personWithClient(core) : sharedClient(core);
      const dispatch = vi.spyOn(core.agentTools, "call");
      const listing = vi.spyOn(core.agentTools, "list");
      const turn = post(
        core,
        "/api/apps/sanctum.example/actions/example.recheck",
        {},
        client,
      );
      try {
        expect(
          await Promise.race([
            opened.promise.then(() => true),
            turn.then(() => false),
          ]),
        ).toBe(true);
        const revoked =
          "person" in client
            ? await post(
                core,
                "/api/people/remove",
                { id: client.person.id },
                maya,
              )
            : await post(
                core,
                "/api/auth/clients/revoke",
                { id: client.id },
                maya,
              );
        expect(revoked.statusCode).toBeLessThan(300);
      } finally {
        continueTurn.resolve();
      }
      const response = await turn;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        list: { refused: "forbidden" },
        call: { refused: "forbidden" },
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(listing).not.toHaveBeenCalled();
    },
  );

  it("lists and calls another app's offered action for the turn opener", async () => {
    const { core, maya } = await household({ apps: [toolTarget] });
    const name = "test_tool-target_report";
    expect(
      (await listed(core, maya.token)).got?.map((tool) => tool.name),
    ).toContain(name);

    const [answer] = await used(core, maya.token, [{ name, input: {} }]);
    expect(answer).toMatchObject({
      isError: false,
      json: {
        kind: "assistant-run",
        id: `sanctum.example/user:${maya.person.id}`,
        onBehalfOf: maya.person.id,
      },
    });
  });

  it("returns a tool error when an answer is too large for the app socket", async () => {
    const { core, maya } = await household({ apps: [toolTarget] });
    const [answer] = await used(core, maya.token, [
      { name: "test_tool-target_report", input: { large: true } },
    ]);
    expect(answer).toMatchObject({
      isError: true,
      text: expect.stringContaining("Narrow the request"),
    });
  });

  it("counts listings and calls in a home pool apart from MCP agents'", async () => {
    const { core, maya } = await household();
    const overviewCalls = (count: number) =>
      Array.from({ length: count }, () => ({
        name: "home_overview",
        input: {},
      }));
    const { agentPerMinute, homePerMinute } = agentLimits;
    for (const [token, count] of [
      [maya.token, agentPerMinute - 1],
      [personWithClient(core).token, agentPerMinute],
      [sharedClient(core).token, homePerMinute - 2 * agentPerMinute],
    ] as const) {
      const answers = await used(core, token, overviewCalls(count));
      expect(answers).toHaveLength(count);
      expect(answers.every((answer) => !answer.isError)).toBe(true);
      if (token === maya.token) {
        expect((await listed(core, token)).got).toBeDefined();
        expect(await listed(core, token)).toEqual({ refused: "limited" });
        expect(await used(core, token, overviewCalls(1))).toMatchObject([
          { isError: true },
        ]);
      }
    }
    expect(await listed(core, sharedClient(core).token)).toEqual({
      refused: "limited",
    });

    const agent = core.auth.clients.createAgent({
      name: "Agent on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    expect(await names(await connect(core, agent.token))).toContain(
      "home_overview",
    );
  });

  it("counts device commands separately from MCP agents' commands", async () => {
    const { core, maya, lamp } = await household({
      agentCommandLimits: { agentPerMinute: 10, homePerMinute: 1 },
    });
    const agent = core.auth.clients.createAgent({
      name: "Agent on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    const client = await connect(core, agent.token);
    const name = "device_command";
    const input = (on: boolean) => ({
      device: lamp,
      capability: "light",
      command: { on },
    });
    const byAgent = (on: boolean) =>
      client.callTool({ name, arguments: input(on) });
    const byAssistant = (on: boolean) =>
      used(core, maya.token, [{ name, input: input(on) }]);

    expect((await byAgent(true)).isError).not.toBe(true);
    expect(await byAssistant(false)).toMatchObject([{ isError: false }]);
    expect(await byAgent(true)).toMatchObject({
      isError: true,
      structuredContent: { error: "limited" },
    });
    expect(await byAssistant(true)).toMatchObject([
      {
        isError: true,
        text: expect.stringContaining("too many device commands"),
      },
    ]);
    expect(radio.received).toHaveLength(2);
  });
});
