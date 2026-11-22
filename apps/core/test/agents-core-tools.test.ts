import {
  controlPermission,
  defineAction,
  defineApp,
  defineEntityType,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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
      content: { on: true, switched: 1, failed: [] },
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
          "“Control your lights” is switched off for AI agents in Settings, What AI agents can use.",
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
          "“Control your switches” is switched off for AI agents in Settings, What AI agents can use.",
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
    ).toMatchObject({ isError: false, content: { switched: 1 } });
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
    ).toMatchObject({ isError: false, content: { switched: 1 } });
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
});
