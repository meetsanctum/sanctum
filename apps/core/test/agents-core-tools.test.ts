import {
  controlPermission,
  defineAction,
  defineApp,
  defineEntityType,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createDeviceLog } from "../src/devices/activity.js";
import { createLimitedLog } from "../src/agents/limits.js";
import { connect, names } from "./agents-support.js";
import { command, lampsCore, radio, settled } from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import { post, type TestCore } from "./support.js";

// The core's own tools for AI agents: lights, device commands, what apps
// bring, activity and history. Each is listed while its area is on, answers
// with what AI agents may see only, and every entry a call leads to carries
// its call's id. AI agents' device commands are held to a limit a minute,
// those an app's action sends for them included.

const note = defineEntityType({
  id: "example.note",
  title: "Note",
  state: z.object({ text: z.string() }),
  assistant: { starts: "on", description: "The household's notes." },
});

const secret = defineEntityType({
  id: "example.secret",
  title: "Secret",
  state: z.object({ text: z.string() }),
  assistant: { starts: "off", description: "Kept to the household." },
});

const publish = defineAction({
  id: "example.publish",
  title: "Publish",
  tier: "write",
  input: z.object({ type: z.string(), key: z.string(), text: z.string() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.entities.publish({
      type: input.type,
      key: input.key,
      name: input.key,
      state: { text: input.text },
    });
    return {};
  },
});

// Turns one light on, as an app's action that commands devices does.
const glow = defineAction({
  id: "example.glow",
  title: "Glow",
  tier: "write",
  input: z.object({ device: z.string() }),
  output: z.object({}),
  assistant: {
    starts: "on",
    description: "Turn one light on.",
    needs: [controlPermission("light")],
  },
  async run(ctx, input) {
    await ctx.devices.command({
      device: input.device,
      capability: "light",
      command: { on: true },
    });
    return {};
  },
});

const examplePackage: AppPackage = {
  app: defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [
      {
        id: controlPermission("light"),
        reason: "To turn lights on.",
        needed: true,
      },
    ],
    actions: [publish, glow],
    events: [],
    provides: { entities: [note, secret] },
  }),
  origin: "official",
};

async function household(options: Parameters<typeof lampsCore>[0] = {}) {
  const home = await lampsCore({ apps: [examplePackage], ...options });
  const { core, maya, lamp, plug } = home;
  const token = maya.token;
  const living = (
    await post(
      core,
      "/api/places/rooms/add",
      { name: "Living room" },
      { token },
    )
  ).json().id as string;
  for (const id of [lamp, plug]) {
    await post(core, "/api/devices/update", { id, roomId: living }, { token });
  }
  const agent = core.auth.clients.createAgent({
    name: "Codex on the office Mac",
    platform: "macos",
    addedBy: { kind: "person", id: maya.person.id },
  });
  const client = await connect(core, agent.token);
  const area = (id: string, on: boolean) =>
    post(core, "/api/agents/can-use/area", { id, on }, { token });
  return { ...home, token, living, agent, client, area };
}

type Client = Awaited<ReturnType<typeof household>>["client"];

async function call(
  client: Client,
  name: string,
  input: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: input });
  return {
    isError: result.isError === true,
    content: result.structuredContent as Record<string, unknown>,
  };
}

function entries(core: TestCore, action?: string) {
  return core.db.$client
    .prepare(
      `select action, outcome, reason, actor, subject_id as subject,
        call_id as call from activity
        ${action ? "where action = ?" : ""} order by rowid`,
    )
    .all(...(action ? [action] : [])) as {
    action: string;
    outcome: string;
    reason: string | null;
    actor: string | null;
    subject: string | null;
    call: string | null;
  }[];
}

describe("the core's tools for AI agents", () => {
  it("lists each while its area is on", async () => {
    const { client, area } = await household();

    // Lights start on, and with them device commands; the rest start off.
    expect(await names(client)).toEqual([
      "home_overview",
      "lights",
      "device_command",
      "restore",
      "entities",
      "sanctum_example_glow",
    ]);

    await area(controlPermission("light"), false);
    await area("activity.read", true);
    await area("history.read", true);
    expect(await names(client)).toEqual([
      "home_overview",
      "entities",
      "activity",
      "history",
    ]);
  });

  it("switches a room's lights and ties the call's entries together", async () => {
    const { core, client, living, lamp, agent } = await household();

    const result = await call(client, "lights", {
      place: { kind: "room", id: living },
      to: "on",
    });
    await settled();

    expect(result).toEqual({
      isError: false,
      content: {
        change: expect.any(String),
        lights: [
          {
            device: lamp,
            capability: "light",
            name: expect.any(String),
            result: expect.stringMatching(/^(sent|confirmed)$/),
            state: expect.objectContaining({ on: true }),
          },
        ],
      },
    });
    const [entry] = entries(core, "device.command");
    expect(entry).toMatchObject({
      outcome: "ok",
      actor: `assistant-run:${agent.client.id}`,
      subject: lamp,
    });
    expect(entry!.call).toEqual(expect.any(String));
  });

  it("refuses lights switched off, and a place the home doesn't have", async () => {
    const { core, client, area, agent } = await household();

    expect(
      await call(client, "lights", {
        place: { kind: "room", id: "nowhere" },
        to: "off",
      }),
    ).toMatchObject({ isError: true, content: { error: "not_found" } });
    expect(
      await call(client, "lights", { place: { kind: "home" }, to: "dim" }),
    ).toMatchObject({ isError: true, content: { error: "invalid_input" } });

    await area(controlPermission("light"), false);
    expect(
      await call(client, "lights", { place: { kind: "home" }, to: "off" }),
    ).toEqual({
      isError: true,
      content: {
        error: "not_allowed",
        message:
          "“Control your lights” is switched off for AI agents in Settings, What AI Agents Can Use.",
      },
    });
    // Logged once, naming the switch.
    expect(
      core.db.$client
        .prepare(
          "select actor, detail from activity where action = 'agents.refused'",
        )
        .all(),
    ).toEqual([
      {
        actor: `assistant-run:${agent.client.id}`,
        detail: JSON.stringify({
          tool: "lights",
          items: [controlPermission("light")],
        }),
      },
    ]);
  });

  it("commands a device of a kind AI agents may control, and hides the rest", async () => {
    const { client, area, plug, lamp } = await household();

    // Switches are seen, but not controlled, until the household says so.
    expect(
      await call(client, "device_command", {
        device: plug,
        capability: "power",
        command: { on: false },
      }),
    ).toEqual({
      isError: true,
      content: {
        error: "not_allowed",
        message:
          "“Control your switches” is switched off for AI agents in Settings, What AI Agents Can Use.",
      },
    });

    await area(controlPermission("switch"), true);
    const switched = await call(client, "device_command", {
      device: plug,
      capability: "power",
      command: { on: true },
    });
    expect(switched).toMatchObject({
      isError: false,
      content: { device: plug, capability: "power", kind: "switch" },
    });
    await settled();

    // A command the kind doesn't take, and a device AI agents can't see.
    expect(
      await call(client, "device_command", {
        device: lamp,
        capability: "light",
        command: { open: true },
      }),
    ).toMatchObject({ isError: true, content: { error: "invalid_input" } });
    await area(controlPermission("switch"), false);
    await area("devices.read:switch", false);
    expect(
      await call(client, "device_command", {
        device: plug,
        capability: "power",
        command: { on: true },
      }),
    ).toMatchObject({ isError: true, content: { error: "not_found" } });
  });

  it("lists the command each kind takes in its input schema", async () => {
    const { client, area } = await household();
    const schemaOf = async () =>
      (await client.listTools(undefined, { cacheMode: "bypass" })).tools.find(
        (tool) => tool.name === "device_command",
      )!.inputSchema;

    expect(await schemaOf()).toMatchObject({
      type: "object",
      required: ["device", "capability", "command"],
      properties: {
        command: { type: "object", properties: { on: { type: "boolean" } } },
      },
    });
    await area(controlPermission("switch"), true);
    expect(
      (await schemaOf()).properties!.command as { anyOf: unknown[] },
    ).toMatchObject({ anyOf: [{}, {}] });
  });

  it("holds an agent's device commands to a limit, those an app sends for it too", async () => {
    const { core, client, lamp, living } = await household({
      agentCommandLimits: { agentPerMinute: 2, homePerMinute: 10 },
    });

    expect(
      await call(client, "sanctum_example_glow", { device: lamp }),
    ).toMatchObject({ isError: false });
    await settled();
    expect(
      await call(client, "lights", {
        place: { kind: "room", id: living },
        to: "off",
      }),
    ).toMatchObject({
      isError: false,
      content: {
        lights: [{ result: expect.stringMatching(/^(sent|confirmed)$/) }],
      },
    });
    await settled();

    const refused = await call(client, "lights", {
      place: { kind: "room", id: living },
      to: "on",
    });
    expect(refused).toMatchObject({
      isError: true,
      content: { error: "limited" },
    });
    expect(
      await call(client, "sanctum_example_glow", { device: lamp }),
    ).toMatchObject({ isError: true });
    // Logged once, not for every command held back.
    expect(entries(core, "agents.limited")).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "commands" }),
    ]);

    // A minute on, there's room again.
    core.advance(61_000);
    expect(
      await call(client, "lights", {
        place: { kind: "room", id: living },
        to: "on",
      }),
    ).toMatchObject({
      isError: false,
      content: {
        lights: [{ result: expect.stringMatching(/^(sent|confirmed)$/) }],
      },
    });
  });

  it("reports a device-command limit through an app's action", async () => {
    const { core, client, lamp } = await household({
      agentCommandLimits: { agentPerMinute: 1, homePerMinute: 10 },
    });
    expect(
      await call(client, "sanctum_example_glow", { device: lamp }),
    ).toMatchObject({ isError: false });

    expect(
      await call(client, "sanctum_example_glow", { device: lamp }),
    ).toMatchObject({ isError: true, content: { error: "limited" } });
    expect(entries(core, "example.glow").at(-1)).toMatchObject({
      outcome: "refused",
      reason: "limited",
      call: entries(core, "agents.limited")[0]?.call,
    });
  });

  it("counts only commands sent to a device against the home's limit", async () => {
    const { core, client, lamp } = await household({
      agentCommandLimits: { agentPerMinute: 10, homePerMinute: 1 },
    });
    const secondAgent = core.auth.clients.createAgent({
      name: "Other agent",
      platform: "macos",
      addedBy: { kind: "person", id: core.people.list()[0]!.id },
    });
    const second = await connect(core, secondAgent.token);
    const send = (caller: Client, command: object) =>
      call(caller, "device_command", {
        device: lamp,
        capability: "light",
        command,
      });

    expect(await send(client, { colorTemperature: 400 })).toMatchObject({
      isError: false,
      content: { waitingFor: null },
    });
    expect(radio.received).toHaveLength(0);
    expect(await send(second, { on: true })).toMatchObject({ isError: false });
    expect(await send(client, { on: false })).toMatchObject({
      isError: true,
      content: { error: "limited" },
    });
  });

  it("gives an app action's commands the action's call id", async () => {
    const { core, client, lamp } = await household();

    await call(client, "sanctum_example_glow", { device: lamp });
    await settled();

    const [action] = entries(core, "example.glow");
    const [sent] = entries(core, "device.command");
    expect(action!.call).toEqual(expect.any(String));
    expect(sent).toMatchObject({ subject: lamp, call: action!.call });

    // Each call has its own.
    await call(client, "sanctum_example_glow", { device: lamp });
    expect(entries(core, "example.glow")[1]!.call).not.toBe(action!.call);
  });

  it.each(["original", null])(
    "keeps the call id %s when a joined command fails later",
    async (callId) => {
      const { core, lamp } = await household();
      const log = createDeviceLog({ activity: core.activity, confirmMs: 100 });
      const who = { actor: "sanctum" };
      const sent = {
        capability: "light",
        kind: "light" as const,
        app: null,
        asked: { brightness: 50 },
      };
      const write = () => log.command(who, lamp, "ok", undefined, sent);
      const join = () => {
        const first = write();
        expect(write()).toBe(first);
        return first;
      };
      const id =
        callId === null ? join() : core.activity.duringCall(callId, join);

      core.activity.duringCall("later", () => {
        log.unanswered(id, who, lamp, sent, {
          reason: "no_answer",
          hasResent: true,
        });
      });
      expect(entries(core, "device.command").at(-1)).toMatchObject({
        outcome: "failed",
        call: callId,
      });
    },
  );

  it("reads only what apps bring that's switched on", async () => {
    const { core, client, token } = await household();
    for (const [type, key, text] of [
      [note.id, "groceries", "Milk"],
      [secret.id, "safe", "1234"],
    ]) {
      await post(
        core,
        "/api/apps/sanctum.example/actions/example.publish",
        { type, key, text },
        { token },
      );
    }

    const tool = (
      await client.listTools(undefined, { cacheMode: "bypass" })
    ).tools.find((each) => each.name === "entities")!;
    expect(tool.description).toContain("example.note (“Note”, from Example)");
    expect(tool.description).not.toContain(secret.id);
    expect(await call(client, "entities")).toEqual({
      isError: false,
      content: {
        entities: [
          expect.objectContaining({
            app: "sanctum.example",
            appName: "Example",
            type: note.id,
            name: "groceries",
            state: { text: "Milk" },
          }),
        ],
      },
    });
    expect(await call(client, "entities", { type: secret.id })).toMatchObject({
      content: { entities: [] },
    });
  });

  it("reads activity for the devices it may see, naming people only with people's names on", async () => {
    const { core, client, area, token, lamp, plug, living, agent } =
      await household();
    await area("activity.read", true);
    await command(core, token, lamp, "light", { on: true });
    await command(core, token, plug, "power", { on: false });
    await call(client, "lights", {
      place: { kind: "room", id: living },
      to: "off",
    });
    await settled();

    const read = async () =>
      (await call(client, "activity")).content as {
        entries: {
          action: string;
          device: { id: string };
          who: Record<string, unknown>;
          call?: string;
        }[];
        next: string | null;
      };
    const first = await read();
    expect(first.entries.map((entry) => [entry.device.id, entry.who])).toEqual([
      [lamp, { kind: "agent", self: true }],
      [plug, { kind: "person" }],
      [lamp, { kind: "person" }],
    ]);
    expect(first.entries[0]!.call).toEqual(
      entries(core, "device.command").find(
        (entry) => entry.actor === `assistant-run:${agent.client.id}`,
      )!.call,
    );
    expect(first.entries[1]!.call).toBeUndefined();

    await area("people.read", true);
    expect((await read()).entries[1]!.who).toEqual({
      kind: "person",
      name: "Maya",
    });

    // Switches out of sight take their entries with them.
    await area("devices.read:switch", false);
    expect((await read()).entries.map((entry) => entry.device.id)).toEqual([
      lamp,
      lamp,
    ]);
  });

  it("paginates only visible activity and refuses a hidden device filter", async () => {
    const { core, client, area, lamp, plug } = await household();
    await area("activity.read", true);
    await area("devices.read:switch", false);
    const record = core.activity.for("devices");
    const recordOffline = (device: string) =>
      record({ action: "device.offline", outcome: "ok", subjectId: device });
    recordOffline(plug);
    recordOffline(lamp);
    const near = recordOffline(lamp);
    recordOffline(plug);
    record({ action: "device.command", outcome: "refused", subjectId: lamp });
    record({
      action: "device.changed",
      outcome: "ok",
      subjectId: lamp,
      detail: { capability: "light", on: true },
    });
    record({
      action: "device.command",
      outcome: "ok",
      subjectId: lamp,
      detail: {
        capability: "light",
        capabilityKind: "switch",
        asked: { on: true },
      },
    });

    expect(await call(client, "activity", { limit: 1 })).toMatchObject({
      isError: false,
      content: { entries: [{ device: { id: lamp } }], next: near },
    });
    expect(
      await call(client, "activity", { limit: 1, before: near }),
    ).toMatchObject({
      isError: false,
      content: { entries: [{ device: { id: lamp } }], next: null },
    });
    expect(await call(client, "activity", { device: plug })).toMatchObject({
      isError: true,
      content: { error: "not_found" },
    });
  });

  it("never shows an agent speech a speaker didn't understand, and pages past it", async () => {
    const { core, client, area, lamp } = await household();
    await area("activity.read", true);
    const record = core.activity.for("devices");
    // Stands in for a smart speaker's requests: the filter is the action's.
    const request = (reason?: string) =>
      record({
        action: "device.request",
        outcome: "ok",
        ...(reason ? { reason } : {}),
        subjectId: lamp,
        detail: { capability: "light", capabilityKind: "light" },
      });
    const answered = request();
    request("not_understood");
    request("not_understood");

    expect(await call(client, "activity", { limit: 1 })).toMatchObject({
      isError: false,
      content: { entries: [{ action: "device.request" }], next: null },
    });
    const { entries: all } = (await call(client, "activity")).content as {
      entries: { reason: string | null }[];
    };
    expect(all.map((entry) => entry.reason)).toEqual([null]);
    // The household still sees them.
    expect(
      core.activity
        .page({ kind: "devices", limit: 10 })
        .entries.filter((entry) => entry.action === "device.request"),
    ).toHaveLength(3);
    expect(answered).toBeTruthy();
  });

  it("reads up to 10 days of history for the devices it may see", async () => {
    const { core, client, area, lamp } = await household();
    await area("history.read", true);
    await radio.press("lamp-1", { on: true });
    await settled();
    core.advance(60_000);

    const read = await call(client, "history", {
      device: lamp,
      capability: "light",
    });
    expect(read).toMatchObject({
      isError: false,
      content: { device: lamp, capability: "light", kind: "light" },
    });
    expect(
      (read.content.states as { state: { on: boolean } }[]).at(-1)!.state.on,
    ).toBe(true);

    const longAgo = new Date(core.now().getTime() - 11 * 86_400_000);
    expect(
      await call(client, "history", {
        device: lamp,
        capability: "light",
        from: longAgo.toISOString(),
      }),
    ).toEqual({
      isError: true,
      content: {
        error: "invalid_input",
        message: "History goes back 10 days at most for AI agents.",
      },
    });
    await area(controlPermission("light"), false);
    expect(
      await call(client, "history", { device: lamp, capability: "light" }),
    ).toMatchObject({ isError: true, content: { error: "not_found" } });
  });

  it("keeps history within the last ten days of the core's clock", async () => {
    const { core, client, area, lamp } = await household();
    await area("history.read", true);
    const dayMs = 86_400_000;
    core.advance(11 * dayMs);
    const from = new Date(core.now().getTime() - 10 * dayMs).toISOString();
    await radio.press("lamp-1", { on: true });
    await settled();
    const to = core.now().toISOString();

    expect(
      await call(client, "history", {
        device: lamp,
        capability: "light",
        from,
        to,
      }),
    ).toMatchObject({
      isError: false,
      content: { from, to, states: [{ at: to, state: { on: true } }] },
    });
  });

  it("logs each limit an agent reaches once a minute, wherever it's reached", () => {
    const logged: unknown[] = [];
    let at = 0;
    const log = createLimitedLog({
      record: (entry) => {
        logged.push([entry.reason, entry.actor]);
        return "";
      },
      agentWho: (id) => ({ actor: `assistant-run:${id}` }),
      now: () => at,
    });

    log("agent-1", "commands");
    log("agent-1", "commands");
    log("agent-1", "per_minute");
    log("agent-2", "commands");
    at = 61_000;
    log("agent-1", "commands");

    expect(logged).toEqual([
      ["commands", "assistant-run:agent-1"],
      ["per_minute", "assistant-run:agent-1"],
      ["commands", "assistant-run:agent-2"],
      ["commands", "assistant-run:agent-1"],
    ]);
  });
});
