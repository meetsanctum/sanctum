import {
  aiAssistantPermission,
  assistantAppId,
  defineAction,
  defineApp,
  isActionError,
  type AiToolAnswer,
  type AssistantRequestCall,
  type EarlierExchange,
  type RequestContext,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { connect } from "./agents-support.js";
import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { lampsCore } from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import {
  claimed,
  deferredDelivery,
  deferredResult,
  post,
  sharedClient,
  type TestCore,
} from "./support.js";

// Each device is a conversation of its own with Sanctum's Assistant: a newer
// request from it takes over from one still running, and gets the device's
// exchanges of the last 5 minutes as `earlier`, so "put it back" works from
// the change a tool answered with, or, once that's gone, without one.

useCleanUps();

type Script = (
  ctx: RequestContext,
  request: AssistantRequestCall,
) => Promise<void>;

// A fake Assistant, whose handler each test sets.
function fakeAssistant(script: { current: Script }) {
  return defineApp({
    ...base,
    id: assistantAppId,
    name: "Assistant",
    permissions: [
      {
        id: aiAssistantPermission,
        reason: "To do what you ask.",
        needed: true,
      },
    ],
    actions: [],
    requests: (ctx, request) => script.current(ctx, request),
  });
}

// An app offering AI agents a call that waits until the test lets it go.
const slowEntered = deferredDelivery();
const slowRelease = deferredDelivery();
const slow: AppPackage = {
  app: defineApp({
    ...base,
    id: "test.slow",
    name: "Slow",
    permissions: [],
    actions: [
      defineAction({
        id: "slow.wait",
        title: "Wait",
        tier: "read",
        assistant: { starts: "on", description: "Waits a while." },
        input: z.object({}),
        output: z.object({ waited: z.boolean() }),
        async run() {
          slowEntered.resolve();
          await slowRelease.promise;
          return { waited: true };
        },
      }),
    ],
  }),
  origin: "system",
};

async function household() {
  const script: { current: Script } = { current: async () => {} };
  const { core, maya, lamp } = await lampsCore({
    apps: [{ app: fakeAssistant(script), origin: "official" }, slow],
  });
  return { core, maya, lamp, script };
}

async function ask(core: TestCore, token: string, text: string) {
  return post(core, "/api/assistant/ask", { text }, { token });
}

const lampIsOn = (core: TestCore, lamp: string, on: boolean) =>
  vi.waitFor(() =>
    expect(core.devices.get(lamp)?.capabilities[0]?.state).toMatchObject({
      on,
    }),
  );

const changeOf = (answer: AiToolAnswer) =>
  (JSON.parse(answer.text) as { change: string }).change;

describe("a device's 5-minute window", () => {
  it("lets a second request put the lights back from the change in earlier", async () => {
    const { core, maya, lamp, script } = await household();
    const ended = deferredDelivery();
    let seen: EarlierExchange[] = [];
    script.current = async (ctx, request) => {
      seen = request.earlier;
      if (request.text === "Turn on the kitchen lamp") {
        await ctx.ai.call("device_command", {
          device: lamp,
          capability: "light",
          command: { on: true },
        });
        await request.reply({ text: "It's on." });
        ended.resolve();
        return;
      }
      const [last] = request.earlier;
      const [tool] = last!.tools;
      if (tool?.outcome !== "answered") throw new Error("No answer kept");
      await ctx.ai.call("restore", {
        change: changeOf({ text: tool.text, isError: tool.isError }),
      });
      await request.reply({ text: "Put back." });
    };

    expect(
      (await ask(core, maya.token, "Turn on the kitchen lamp")).json(),
    ).toEqual({ reply: "It's on." });
    await lampIsOn(core, lamp, true);
    expect(seen).toEqual([]);
    // Its handler is done, so the next request doesn't cut it off.
    await ended.promise;
    await new Promise((settled) => setImmediate(settled));

    expect((await ask(core, maya.token, "Put it back")).json()).toEqual({
      reply: "Put back.",
    });
    await lampIsOn(core, lamp, false);
    expect(seen).toEqual([
      {
        asked: "Turn on the kitchen lamp",
        at: expect.any(String),
        tools: [
          {
            name: "device_command",
            input: { device: lamp, capability: "light", command: { on: true } },
            outcome: "answered",
            text: expect.stringContaining('"change"'),
            isError: false,
          },
        ],
        reply: "It's on.",
        cutOff: false,
      },
    ]);
  });

  it("is the device's own, and goes when the Assistant stops", async () => {
    const { core, maya, script } = await household();
    const seen: EarlierExchange[][] = [];
    script.current = async (_ctx, request) => {
      seen.push(request.earlier);
      await request.reply({ text: "Yes." });
    };
    const tablet = sharedClient(core);

    await ask(core, maya.token, "Is it raining?");
    await ask(core, tablet.token, "Is it cold?");
    await ask(core, maya.token, "And tomorrow?");

    expect(seen.map((earlier) => earlier.map(({ asked }) => asked))).toEqual([
      [],
      [],
      ["Is it raining?"],
    ]);

    const grant = (granted: boolean) =>
      post(
        core,
        `/api/apps/${assistantAppId}/permissions/update`,
        { permission: aiAssistantPermission, granted },
        { token: maya.token },
      );
    expect((await grant(false)).statusCode).toBe(200);
    expect((await ask(core, maya.token, "Hello?")).statusCode).toBe(503);
    expect((await grant(true)).statusCode).toBe(200);
    await running(core, assistantAppId);

    await ask(core, maya.token, "Still there?");
    expect(seen.at(-1)).toEqual([]);
  });
});

describe("a newer request from the same device", () => {
  it("takes over: the first's calls are refused, and the newer one sees it cut off", async () => {
    const { core, maya, lamp, script } = await household();
    const called = deferredDelivery();
    const refusal = deferredResult<unknown>();
    let seen: EarlierExchange[] = [];
    script.current = async (ctx, request) => {
      if (request.text === "Turn on the kitchen lamp") {
        await ctx.ai.call("device_command", {
          device: lamp,
          capability: "light",
          command: { on: true },
        });
        called.resolve();
        await new Promise((aborted) =>
          request.signal.addEventListener("abort", aborted, { once: true }),
        );
        try {
          await ctx.ai.list();
          refusal.resolve(null);
        } catch (error) {
          refusal.resolve(isActionError(error) ? error.code : error);
        }
        return;
      }
      seen = request.earlier;
      await request.reply({ text: "Okay, the dining room." });
    };

    const first = ask(core, maya.token, "Turn on the kitchen lamp");
    await called.promise;
    const second = await ask(core, maya.token, "No, the dining room");

    expect(second.json()).toEqual({ reply: "Okay, the dining room." });
    expect((await first).json()).toEqual({ reply: null });
    expect(await refusal.promise).toBe("turn_ended");
    expect(seen).toEqual([
      expect.objectContaining({
        asked: "Turn on the kitchen lamp",
        tools: [expect.objectContaining({ outcome: "answered" })],
        reply: null,
        cutOff: true,
      }),
    ]);
  });

  it("waits up to 2 s for the first's tool call, then says its outcome is unknown", async () => {
    const { core, maya, script } = await household();
    let seen: EarlierExchange[] = [];
    script.current = async (ctx, request) => {
      if (request.text === "Wait for it") {
        await ctx.ai.call("test_slow_wait", {});
        return;
      }
      seen = request.earlier;
      await request.reply({ text: "Done." });
    };

    const first = ask(core, maya.token, "Wait for it");
    await slowEntered.promise;
    const started = Date.now();
    await ask(core, maya.token, "Never mind");

    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect((await first).json()).toEqual({ reply: null });
    expect(seen[0]!.tools).toEqual([
      { name: "test_slow_wait", input: {}, outcome: "unknown" },
    ]);
    slowRelease.resolve();
  });
});

describe("putting back without a change", () => {
  it("puts back the Assistant's last change, while an MCP agent still names one", async () => {
    const { core, maya, lamp, script } = await household();
    script.current = async (ctx, request) => {
      const answer =
        request.text === "Turn it on"
          ? await ctx.ai.call("device_command", {
              device: lamp,
              capability: "light",
              command: { on: true },
            })
          : await ctx.ai.call("restore", {});
      await request.reply({ text: answer.isError ? "No." : "Done." });
    };

    await ask(core, maya.token, "Turn it on");
    await lampIsOn(core, lamp, true);
    expect((await ask(core, maya.token, "Put it back")).json()).toEqual({
      reply: "Done.",
    });
    await lampIsOn(core, lamp, false);
    // Nothing left of its own to put back.
    expect((await ask(core, maya.token, "Put it back")).json()).toEqual({
      reply: "Done.",
    });

    const agent = core.auth.clients.createAgent({
      name: "Agent on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    const client = await connect(core, agent.token);
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === "restore")?.inputSchema.required,
    ).toEqual(["change"]);
    const result = await client.callTool({ name: "restore", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("a request in the Assistant's own container", () => {
  it("hears its call end as a newer request takes over", async () => {
    const entered = deferredDelivery();
    const refusal = deferredResult<unknown>();
    const app = defineApp({
      ...base,
      id: assistantAppId,
      name: "Assistant",
      permissions: [
        {
          id: aiAssistantPermission,
          reason: "To do what you ask.",
          needed: true,
        },
      ],
      actions: [],
      async requests(ctx, request) {
        if (request.text === "First") {
          entered.resolve();
          await new Promise((aborted) =>
            request.signal.addEventListener("abort", aborted, { once: true }),
          );
          try {
            await ctx.ai.list();
            refusal.resolve(null);
          } catch (error) {
            refusal.resolve(isActionError(error) ? error.code : error);
          }
          return;
        }
        await request.reply({
          text: request.earlier.map((each) => each.asked).join(", "),
        });
      },
    });
    const { core } = await apart(app);
    const maya = await claimed(core);
    await running(core, assistantAppId);

    const first = ask(core, maya.token, "First");
    await entered.promise;
    const second = await ask(core, maya.token, "Second");

    expect(second.json()).toEqual({ reply: "First" });
    expect((await first).json()).toEqual({ reply: null });
    expect(await refusal.promise).toBe("turn_ended");
  });
});
