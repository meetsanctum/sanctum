import {
  activityReadPermission,
  aiAssistantPermission,
  controlPermission,
  modelsUsePermission,
  type PermissionRequest,
  assistantAppId,
  defineApp,
  isActionError,
  type AiToolAnswer,
  type AssistantRequestCall,
  type EarlierExchange,
  type RequestContext,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { connect } from "./agents-support.js";
import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { lampsCore } from "./devices-support.js";
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
const assistantGrant = {
  id: aiAssistantPermission,
  reason: "To do what you ask.",
  needed: true,
} satisfies PermissionRequest;

function fakeAssistant(
  script: { current: Script },
  permissions: PermissionRequest[],
) {
  return defineApp({
    ...base,
    id: assistantAppId,
    name: "Assistant",
    permissions,
    actions: [],
    requests: (ctx, request) => script.current(ctx, request),
  });
}

async function household(
  permissions = [assistantGrant] as PermissionRequest[],
) {
  const script: { current: Script } = { current: async () => {} };
  const { core, maya, lamp, plug } = await lampsCore({
    apps: [{ app: fakeAssistant(script, permissions), origin: "official" }],
  });
  return { core, maya, lamp, plug, script };
}

const grant = (
  core: TestCore,
  token: string,
  permission: string,
  granted: boolean,
) =>
  post(
    core,
    `/api/apps/${assistantAppId}/permissions/update`,
    { permission, granted },
    { token },
  );

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

    expect(
      (await grant(core, maya.token, aiAssistantPermission, false)).statusCode,
    ).toBe(200);
    expect((await ask(core, maya.token, "Hello?")).statusCode).toBe(503);
    expect(
      (await grant(core, maya.token, aiAssistantPermission, true)).statusCode,
    ).toBe(200);
    await running(core, assistantAppId);

    await ask(core, maya.token, "Still there?");
    expect(seen.at(-1)).toEqual([]);
  });

  it.each([
    { required: true, permission: modelsUsePermission },
    { required: false, permission: aiAssistantPermission },
  ])(
    "ends an in-flight request when the $permission grant is revoked",
    async ({ required, permission }) => {
      const permissions = required
        ? [
            assistantGrant,
            {
              id: modelsUsePermission,
              reason: "To answer requests.",
              needed: true,
            },
          ]
        : [{ ...assistantGrant, needed: false, startsOn: true }];
      const { core, maya, script } = await household(permissions);
      const entered = deferredDelivery();
      const aborted = deferredDelivery();
      const release = deferredDelivery();
      script.current = async (_ctx, request) => {
        if (request.text === "Wait") {
          request.signal.addEventListener("abort", aborted.resolve, {
            once: true,
          });
          entered.resolve();
          await release.promise;
        } else {
          await request.reply({ text: String(request.earlier.length) });
        }
      };
      try {
        await ask(core, maya.token, "First");
        const pending = ask(core, maya.token, "Wait");
        await entered.promise;
        expect(
          (await grant(core, maya.token, permission, false)).statusCode,
        ).toBe(200);
        expect((await pending).statusCode).toBe(503);
        await aborted.promise;
        expect(core.apps.isRunning(assistantAppId)).toBe(!required);
        expect(
          (await grant(core, maya.token, permission, true)).statusCode,
        ).toBe(200);
        await running(core, assistantAppId);
        expect((await ask(core, maya.token, "After regrant")).json()).toEqual({
          reply: "0",
        });
      } finally {
        release.resolve();
      }
    },
  );

  it("forgets what the Assistant heard once an AI area is switched off", async () => {
    const { core, maya, script } = await household();
    const setArea = (on: boolean) =>
      post(
        core,
        "/api/agents/can-use/area",
        { id: activityReadPermission, on },
        { token: maya.token },
      );
    expect((await setArea(true)).statusCode).toBe(200);
    let seen: EarlierExchange[] | undefined;
    script.current = async (ctx, request) => {
      seen = request.earlier;
      const answer = await ctx.ai.call("activity", {});
      await request.reply({
        text: answer.isError
          ? "Activity unavailable."
          : "Here's what happened.",
      });
    };
    expect((await ask(core, maya.token, "What happened?")).json()).toEqual({
      reply: "Here's what happened.",
    });
    expect((await setArea(false)).statusCode).toBe(200);
    expect((await ask(core, maya.token, "And before that?")).json()).toEqual({
      reply: "Activity unavailable.",
    });
    // What it read while the area was on goes with the switch.
    expect(seen).toEqual([]);
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
});

describe("putting back without a change", () => {
  it("puts back the Assistant's last change, while an MCP agent still names one", async () => {
    const { core, maya, lamp, script } = await household();
    script.current = async (ctx, request) => {
      const restore = (await ctx.ai.list()).find(
        (tool) => tool.name === "restore",
      );
      expect(restore?.input).toMatchObject({
        properties: { change: expect.objectContaining({ type: "string" }) },
      });
      expect(restore?.input.required ?? []).not.toContain("change");
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

  it("puts back the change from this device when one person uses two devices", async () => {
    const { core, maya, lamp, plug, script } = await household();
    const laptop = core.auth.clients.createPersonal({
      name: "Laptop",
      platform: "macos",
      personId: maya.person.id,
    });
    expect(
      (
        await post(
          core,
          "/api/agents/can-use/area",
          {
            id: controlPermission("switch"),
            on: true,
          },
          { token: maya.token },
        )
      ).statusCode,
    ).toBe(200);
    script.current = async (ctx, request) => {
      const answer =
        request.text === "Put it back"
          ? await ctx.ai.call("restore", {})
          : await ctx.ai.call("device_command", {
              device: request.text === "Turn on the lamp" ? lamp : plug,
              capability:
                request.text === "Turn on the lamp" ? "light" : "power",
              command: { on: true },
            });
      await request.reply({ text: answer.isError ? "No." : "Done." });
    };

    expect((await ask(core, maya.token, "Turn on the lamp")).json()).toEqual({
      reply: "Done.",
    });
    await lampIsOn(core, lamp, true);
    expect((await ask(core, laptop.token, "Turn on the plug")).json()).toEqual({
      reply: "Done.",
    });
    await lampIsOn(core, plug, true);
    expect((await ask(core, maya.token, "Put it back")).json()).toEqual({
      reply: "Done.",
    });
    await lampIsOn(core, lamp, false);
    await lampIsOn(core, plug, true);
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
          await ctx.ai.call("x".repeat(64), {});
          await expect(ctx.ai.call("x".repeat(65), {})).rejects.toThrow(
            "A tool's call is its name and an input object",
          );
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
        expect(request.earlier[0]?.tools).toEqual([
          expect.objectContaining({
            name: "x".repeat(64),
            outcome: "answered",
            isError: true,
          }),
        ]);
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
