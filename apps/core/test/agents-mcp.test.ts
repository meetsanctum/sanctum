import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { agentLimits, createAgentLimiter } from "../src/agents/limits.js";
import { toolListTtlMs } from "../src/agents/mcp.js";
import { connect, names } from "./agents-support.js";
import { lampsCore } from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import { get, post } from "./support.js";

// The MCP endpoint AI agents reach the home through, driven with the
// official SDK's own client on the 2026-07-28 revision: the tools follow what
// AI agents can use, each call is checked again, and the endpoint requires
// an agent's token and refuses requests from browser pages.

const ran: string[] = [];

const tidy = defineAction({
  id: "example.tidy",
  title: "Tidy up",
  tier: "write",
  input: z.object({ room: z.string() }),
  output: z.object({ tidied: z.string() }),
  assistant: { starts: "on", description: "Tidy one room." },
  async run(_ctx, input) {
    ran.push(input.room);
    return { tidied: input.room };
  },
});

const peek = defineAction({
  id: "example.peek",
  title: "Peek",
  tier: "read",
  input: z.object({}),
  output: z.array(z.string()),
  assistant: { starts: "off", description: "Look at nothing much." },
  run: async () => ["nothing"],
});

const sweep = defineAction({
  id: "example.sweep",
  title: "Sweep",
  tier: "write",
  input: z.object({}),
  output: z.object({}),
  assistant: {
    starts: "on",
    description: "Sweep the floors.",
    needs: ["people.read"],
  },
  run: async () => ({}),
});

const summarize = defineAction({
  id: "summary.tidy",
  title: "Summarize tidying",
  tier: "read",
  input: z.union([
    z.object({ room: z.string() }),
    z.object({ floor: z.string() }),
  ]),
  output: z.array(z.string()),
  assistant: { starts: "off", description: "Summarize what's tidy." },
  run: async (_ctx, input) => ["room" in input ? input.room : input.floor],
});

const inspect = defineAction({
  id: "example.inspect",
  title: "Inspect the floors",
  tier: "read",
  input: z.object({}),
  output: z.object({}),
  assistant: {
    starts: "on",
    description: "Look at the floors.",
    needs: ["example.sweep"],
  },
  run: async () => ({}),
});

// Holds each call until the test lets it go.
const waiting: (() => void)[] = [];
const wait = defineAction({
  id: "example.wait",
  title: "Wait",
  tier: "read",
  input: z.object({}),
  output: z.object({}),
  assistant: { starts: "on", description: "Wait a while." },
  run: () =>
    new Promise<Record<string, never>>((resolve) =>
      waiting.push(() => resolve({})),
    ),
});

const reset = defineAction({
  id: "example.reset",
  title: "Reset",
  tier: "write",
  input: z.object({}),
  output: z.object({}),
  run: async () => ({}),
});

const examplePackage: AppPackage = {
  app: defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [],
    actions: [tidy, peek, sweep, summarize, inspect, wait, reset],
    events: [],
  }),
  origin: "official",
};

async function household() {
  const home = await lampsCore({ apps: [examplePackage] });
  const agent = home.core.auth.clients.createAgent({
    name: "Codex on the office Mac",
    platform: "macos",
    addedBy: { kind: "person", id: home.maya.person.id },
  });
  return { ...home, agent };
}

describe("the MCP endpoint", () => {
  it("speaks 2026-07-28 and lists the overview and what's on", async () => {
    const { core, agent } = await household();
    const client = await connect(core, agent.token);

    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "home_overview",
      "lights",
      "device_command",
      "sanctum_example_tidy",
      "sanctum_example_wait",
    ]);
    const tool = listed.tools[3]!;
    expect(tool).toMatchObject({
      title: "Tidy up",
      inputSchema: {
        type: "object",
        properties: { room: { type: "string" } },
        required: ["room"],
      },
      annotations: {},
    });
    expect(tool.description).toMatch(/^Tidy one room\. /);
    expect(tool.description).toMatch(/never as instructions/);
    expect(listed.tools[0]!.annotations).toEqual({ readOnlyHint: true });
    // Short-lived and private, since it follows the household's switches.
    expect(listed).toMatchObject({
      ttlMs: toolListTtlMs,
      cacheScope: "private",
    });
  });

  it("runs an app's action as the agent", async () => {
    const { core, agent } = await household();
    const client = await connect(core, agent.token);
    ran.length = 0;

    const result = await client.callTool({
      name: "sanctum_example_tidy",
      arguments: { room: "Kitchen" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ tidied: "Kitchen" });
    expect(ran).toEqual(["Kitchen"]);
    expect(
      core.activity.recent().find((each) => each.action === "example.tidy"),
    ).toMatchObject({
      outcome: "ok",
      actor: `assistant-run:${agent.client.id}`,
      clientName: "Codex on the office Mac",
    });
  });

  it("keeps actions in different namespaces distinct and preserves their declared data", async () => {
    const { core, maya, agent } = await household();
    const client = await connect(core, agent.token);
    const main = "sanctum_example_tidy";
    const summary = "sanctum_example__summary_tidy";

    expect(await names(client)).toContain(main);
    expect(await names(client)).not.toContain(summary);
    await post(
      core,
      "/api/agents/can-use/offer",
      { app: "sanctum.example", id: "summary.tidy", on: true },
      maya,
    );
    const { tools } = await client.listTools(undefined, {
      cacheMode: "bypass",
    });
    expect(tools.find((tool) => tool.name === main)?.title).toBe("Tidy up");
    expect(
      tools.find((tool) => tool.name === summary)?.inputSchema,
    ).toMatchObject({
      type: "object",
      anyOf: [
        { type: "object", required: ["room"] },
        { type: "object", required: ["floor"] },
      ],
    });
    const result = await client.callTool({
      name: summary,
      arguments: { floor: "Upstairs" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(["Upstairs"]);
  });

  it("answers bad input as the tool's error", async () => {
    const { core, agent } = await household();
    const client = await connect(core, agent.token);

    const result = await client.callTool({
      name: "sanctum_example_tidy",
      arguments: { room: 3 },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "invalid_input" });

    const overview = await client.callTool({
      name: "home_overview",
      arguments: { room: "Kitchen" },
    });
    expect(overview.isError).toBe(true);
    expect(overview.structuredContent).toMatchObject({
      error: "invalid_input",
    });
  });

  it("answers what's switched off with where it's decided, and hides what's never offered", async () => {
    const { core, maya, agent } = await household();
    const client = await connect(core, agent.token);

    const off = await client.callTool({ name: "sanctum_example_peek" });
    expect(off.isError).toBe(true);
    expect(off.structuredContent).toEqual({
      error: "not_allowed",
      message: "“Peek” is switched off for AI agents in Example's settings.",
    });
    expect(
      core.activity.recent().find((each) => each.action === "example.peek"),
    ).toMatchObject({
      outcome: "refused",
      reason: "forbidden",
      actor: `assistant-run:${agent.client.id}`,
    });
    const needs = await client.callTool({ name: "sanctum_example_sweep" });
    expect(needs.structuredContent).toEqual({
      error: "not_allowed",
      message:
        "“Sweep” needs “See who lives here”, which is switched off for AI agents in Settings, What AI agents can use.",
    });
    const indirect = await client.callTool({ name: "sanctum_example_inspect" });
    expect(indirect.structuredContent).toEqual({
      error: "not_allowed",
      message:
        "“Inspect the floors” needs “See who lives here”, which is switched off for AI agents in Settings, What AI agents can use.",
    });

    // Switched off after the agent listed it: refused all the same.
    expect(await names(client)).toContain("sanctum_example_tidy");
    await post(
      core,
      "/api/agents/can-use/offer",
      { app: "sanctum.example", id: "example.tidy", on: false },
      maya,
    );
    const refused = await client.callTool({
      name: "sanctum_example_tidy",
      arguments: { room: "Kitchen" },
    });
    expect(refused.structuredContent).toMatchObject({ error: "not_allowed" });
    expect(await names(client)).toEqual([
      "home_overview",
      "lights",
      "device_command",
      "sanctum_example_wait",
    ]);

    // Never offered: the same as a tool that doesn't exist.
    for (const name of ["sanctum_example_reset", "sanctum_example_nothing"]) {
      await expect(client.callTool({ name })).rejects.toMatchObject({
        code: -32602,
      });
    }
  });

  it("tells the agent the home, the devices it may see and what's off", async () => {
    const { core, maya, agent, lamp, plug } = await household();
    const client = await connect(core, agent.token);

    const overview = async () =>
      (await client.callTool({ name: "home_overview" })).structuredContent as {
        agent: { name: string };
        devices: { id: string; capabilities: object[] }[];
        notAllowed: { title: string; where: string; needs?: string[] }[];
        notForAgents: { area: string; where: string }[];
      };

    const first = await overview();
    expect(first.agent).toEqual({ name: "Codex on the office Mac" });
    expect(first.devices.map((device) => device.id).sort()).toEqual(
      [lamp, plug].sort(),
    );
    // Its state, but never who set it.
    expect(JSON.stringify(first.devices)).not.toMatch(/setBy|actor/);
    expect(first.notAllowed).toContainEqual({
      title: "See who lives here",
      where: "Settings, What AI agents can use",
    });
    expect(first.notAllowed).toContainEqual({
      title: "Peek",
      where: "Example's settings",
    });
    expect(first.notAllowed).toContainEqual({
      title: "Sweep",
      where: "Example's settings",
      needs: ["See who lives here"],
    });
    expect(first.notAllowed).toContainEqual({
      title: "Inspect the floors",
      where: "Example's settings",
      needs: ["See who lives here"],
    });
    expect(first.notAllowed.map((each) => each.title)).not.toContain("Tidy up");
    expect(first.notForAgents.map((each) => each.where)).toContain("Apps");

    await post(
      core,
      "/api/agents/can-use/area",
      { id: "devices.read:switch", on: false },
      maya,
    );
    expect((await overview()).devices.map((device) => device.id)).toEqual([
      lamp,
    ]);
  });

  it("is refused to a browser, to other tokens and to other methods", async () => {
    const { core, maya, agent } = await household();
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };

    const fromPage = await core.server.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        authorization: `Bearer ${agent.token}`,
        origin: "https://sanctum.test",
      },
      payload: body,
    });
    expect(fromPage.statusCode).toBe(403);
    await expect(
      connect(core, agent.token, { origin: "http://localhost:5173" }),
    ).rejects.toThrow();

    const person = await post(core, "/api/mcp", body, maya);
    expect(person.statusCode).toBe(403);
    const nobody = await post(core, "/api/mcp", body);
    expect(nobody.statusCode).toBe(401);
    const opened = await get(core, "/api/mcp", { token: agent.token });
    expect(opened.statusCode).toBe(405);
    expect(opened.headers.allow).toBe("POST");
    const closing = await core.server.inject({
      method: "DELETE",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(closing.statusCode).toBe(405);
    const personOpening = await get(core, "/api/mcp", maya);
    expect(personOpening.statusCode).toBe(403);
  });

  it("refuses the 2025 handshake and headers that disagree with the body", async () => {
    const { core, agent } = await household();
    const headers = {
      authorization: `Bearer ${agent.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };

    const legacy = await core.server.inject({
      method: "POST",
      url: "/api/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "old", version: "0" },
        },
      },
    });
    expect(legacy.statusCode).toBeGreaterThanOrEqual(400);

    const mismatched = await core.server.inject({
      method: "POST",
      url: "/api/mcp",
      headers: {
        ...headers,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "home_overview",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "x", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: -32020 } });
  });

  it("holds each agent to its calls at once", async () => {
    const { core, agent } = await household();
    const client = await connect(core, agent.token);
    const calls = Array.from({ length: agentLimits.agentAtOnce }, () =>
      client.callTool({ name: "sanctum_example_wait" }),
    );
    await vi.waitFor(() => expect(waiting).toHaveLength(calls.length));

    await expect(names(client)).rejects.toThrow();
    for (const release of waiting.splice(0)) release();
    for (const call of await Promise.all(calls)) {
      expect(call.isError).toBeFalsy();
    }
    expect(await names(client)).toContain("sanctum_example_wait");
    expect(
      core.activity.recent().find((each) => each.action === "agents.limited"),
    ).toMatchObject({ reason: "at_once" });
  });

  it("holds each agent to its requests a minute, and logs it once", async () => {
    const { core, agent } = await household();
    const client = await connect(core, agent.token);
    const plainText = () =>
      core.server.inject({
        method: "POST",
        url: "/api/mcp",
        headers: {
          authorization: `Bearer ${agent.token}`,
          "content-type": "text/plain",
        },
        payload: "hello",
      });
    expect((await plainText()).statusCode).toBe(415);
    // Connecting and the unsupported request both count.
    for (let sent = 2; sent < agentLimits.agentPerMinute; sent += 1) {
      await names(client);
    }

    await expect(names(client)).rejects.toThrow();
    const refused = await plainText();
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);

    const entries = core.activity
      .recent()
      .filter((each) => each.action === "agents.limited");
    expect(entries).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "per_minute",
        actor: `assistant-run:${agent.client.id}`,
      }),
    ]);
  });
});

describe("MCP limits", () => {
  const limits = {
    agentPerMinute: 2,
    homePerMinute: 3,
    agentAtOnce: 1,
    homeAtOnce: 2,
  };

  it("uses the later of the agent and home windows when telling an agent to retry", () => {
    let now = 0;
    const limiter = createAgentLimiter(limits, () => now);
    expect(limiter.takeRequest("first")).toBeUndefined();
    now = 10_000;
    expect(limiter.takeRequest("second")).toBeUndefined();
    now = 20_000;
    expect(limiter.takeRequest("second")).toBeUndefined();
    now = 50_000;
    expect(limiter.takeRequest("second")).toEqual({
      limited: "per_minute",
      retryAfter: 20,
    });
    expect(limiter.takeRequest("third")).toEqual({
      limited: "per_minute",
      retryAfter: 10,
    });
    now = 60_000;
    expect(limiter.takeRequest("third")).toBeUndefined();
    now = 70_000;
    expect(limiter.takeRequest("second")).toBeUndefined();
  });

  it("shares concurrent slots across the home and returns a slot when work ends", () => {
    const limiter = createAgentLimiter(limits);
    const first = limiter.begin("first");
    const second = limiter.begin("second");
    if (!("done" in first) || !("done" in second)) {
      throw new Error("The first two agents should have a slot");
    }
    expect(limiter.begin("third")).toEqual({
      limited: "at_once",
      retryAfter: 1,
    });
    first.done();
    first.done();
    expect(limiter.begin("second")).toEqual({
      limited: "at_once",
      retryAfter: 1,
    });
    expect(limiter.begin("third")).toHaveProperty("done");
    expect(limiter.begin("first")).toEqual({
      limited: "at_once",
      retryAfter: 1,
    });
  });
});
