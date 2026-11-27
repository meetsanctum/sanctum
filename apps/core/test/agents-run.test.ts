import {
  defineAction,
  defineApp,
  moodRunSchema,
  moodType,
  toStaticManifest,
} from "@meetsanctum/app-sdk";
import assistant from "@meetsanctum/assistant";
import moods from "@meetsanctum/moods";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgentChanges } from "../src/agents/changes.js";
import { contractOf } from "../src/app-host/contract.js";
import { connect, names } from "./agents-support.js";
import { devicesSeenBy, lampsCore, radio, settled } from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import { post } from "./support.js";

// `run`: an AI agent runs one of the home's moods by the app and key
// `entities` gives it, through the action the app says runs its moods, so it
// names neither, and that action has no tool of its own. It is listed while
// that action is on for AI agents, and refuses as that action does.

const moodsPackage: AppPackage = {
  app: moods,
  origin: "official",
  migrationsFolder: fileURLToPath(
    new URL("../../../catalog/apps/moods/migrations", import.meta.url),
  ),
};

const setScene = defineAction({
  id: "example.setScene",
  title: "Set a scene",
  tier: "write",
  input: z.object({ fixtureCount: z.number().int().min(1) }),
  output: moodRunSchema,
  runs: moodType.id,
  assistant: {
    starts: "on",
    description: "Set a scene.",
    needs: [moodType.id],
  },
  async run(_ctx, { fixtureCount }) {
    return { switched: fixtureCount, failed: [] };
  },
});
const example = defineApp({
  id: "sanctum.example",
  name: "Example",
  version: "0.1.0",
  core: "^2.0.0",
  permissions: [],
  actions: [setScene],
  events: [],
  provides: { entities: [moodType] },
  async start(ctx) {
    await ctx.entities.publish({
      type: moodType.id,
      key: "reading",
      name: "Reading",
      state: {
        placeId: "office",
        icon: "moon",
        name: "Reading",
        order: 0,
        active: false,
        input: { fixtureCount: 3 },
      },
    });
  },
});

async function household(...extraApps: AppPackage[]) {
  const home = await lampsCore({ apps: [moodsPackage, ...extraApps] });
  const { core, maya, lamp } = home;
  const token = maya.token;
  const office = (
    await post(core, "/api/places/rooms/add", { name: "Office" }, { token })
  ).json().id as string;
  await post(core, "/api/devices/update", { id: lamp, roomId: office }, maya);
  const created = await post(
    core,
    "/api/apps/sanctum.moods/actions/moods.createMood",
    {
      roomId: office,
      name: "Relax",
      lights: [
        {
          device: lamp,
          capability: "light",
          state: { on: true, brightness: 40 },
        },
      ],
    },
    { token },
  );
  expect(created.statusCode).toBe(200);
  const agent = core.auth.clients.createAgent({
    name: "Codex on the office Mac",
    platform: "macos",
    addedBy: { kind: "person", id: maya.person.id },
  });
  const client = await connect(core, agent.token);
  const offer = (id: string, on: boolean) =>
    post(
      core,
      "/api/agents/can-use/offer",
      { app: "sanctum.moods", id, on },
      { token },
    );
  return { ...home, token, office, client, offer };
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

async function moodsSeen(client: Client) {
  const read = await call(client, "entities", { type: "mood" });
  return read.content.entities as {
    app: string;
    key: string;
    name: string;
    state: Record<string, unknown>;
  }[];
}

describe("the run tool", () => {
  it("runs a mood by its app and key, answering its type and what it set", async () => {
    const { client, office } = await household();
    const [relax] = await moodsSeen(client);
    const sent = radio.received.length;

    const ran = await call(client, "run", {
      app: relax!.app,
      key: relax!.key,
    });
    await settled();

    const listed = await names(client);
    expect(listed).toContain("run");
    expect(listed).not.toContain("sanctum_moods_runMood");
    expect(relax!.state).not.toHaveProperty("input");
    expect(relax).toMatchObject({
      app: "sanctum.moods",
      name: "Relax",
      state: { placeId: office },
    });
    expect(ran).toEqual({
      isError: false,
      content: { type: "mood", result: { switched: 1, failed: [] } },
    });
    expect(radio.received.length).toBeGreaterThan(sent);
  });

  it("is listed only while the action that runs moods is on, and refuses as it does", async () => {
    const { client, core, offer } = await household();
    const [relax] = await moodsSeen(client);

    await offer("moods.runMood", false);
    const listed = await names(client);
    const refused = await call(client, "run", {
      app: relax!.app,
      key: relax!.key,
    });

    expect(listed).not.toContain("run");
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatchObject({ error: "not_allowed" });
    expect(refused.content.message).toContain("Moods' settings");
    expect(core.activity.recent()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "sanctum.moods",
          action: "moods.runMood",
          actor: expect.stringMatching(/^assistant-run:/),
          outcome: "refused",
          reason: "forbidden",
        }),
      ]),
    );
  });

  it("is refused while moods are off for AI agents, as Run a mood is", async () => {
    const { client, offer } = await household();
    const [relax] = await moodsSeen(client);

    await offer("mood", false);
    const listed = await names(client);
    const refused = await call(client, "run", {
      app: relax!.app,
      key: relax!.key,
    });

    expect(listed).not.toContain("run");
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatchObject({ error: "not_allowed" });
    expect(refused.content.message).toContain("Moods' settings");
  });

  it("answers alike for a key that isn't there and an app that runs nothing", async () => {
    const { client } = await household();

    const missing = await call(client, "run", {
      app: "sanctum.moods",
      key: "nothing",
    });
    const other = await call(client, "run", { app: "lamps", key: "nothing" });
    const wrong = await call(client, "run", { app: "sanctum.moods" });

    expect(missing.content).toMatchObject({ error: "not_found" });
    expect(other.content).toEqual(missing.content);
    expect(wrong.content).toMatchObject({ error: "invalid_input" });
  });

  it("has Run a mood answer as an unknown tool, run in its place", async () => {
    const { client } = await household();
    const [relax] = await moodsSeen(client);

    await expect(
      client.callTool({
        name: "sanctum_moods_runMood",
        arguments: { id: relax!.key },
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Unknown tool: sanctum_moods_runMood"),
    });
  });

  it("passes a second provider's published input to its own runner", async () => {
    const { client } = await household({ app: example, origin: "official" });
    const reading = (await moodsSeen(client)).find(
      ({ app }) => app === example.id,
    );
    expect(reading?.key).toBe("reading");

    expect(
      await call(client, "run", { app: example.id, key: reading!.key }),
    ).toEqual({
      isError: false,
      content: { type: "mood", result: { switched: 3, failed: [] } },
    });
  });

  it("describes what running a mood does", async () => {
    const { client } = await household();

    const { tools } = await client.listTools();
    const run = tools.find((tool) => tool.name === "run");

    expect(run?.description).toContain(
      "Runs an entity of a supported type (mood) by the app and key",
    );
    expect(run?.description).toContain("can turn others there off");
  });
});

it("runs a named mood through the Assistant without leaving the previous light change as its implicit undo", async () => {
  const { core, token } = await household({
    app: assistant,
    origin: "official",
  });
  await radio.add("lamp-2", "light", "Reading lamp");
  const kitchen = await post(
    core,
    "/api/places/rooms/add",
    { name: "Kitchen" },
    { token },
  );
  expect(kitchen.statusCode).toBe(200);
  const reading = (await devicesSeenBy(core, token)).find(
    (device: { driverName: string }) => device.driverName === "Reading lamp",
  );
  expect(
    (
      await post(
        core,
        "/api/devices/update",
        { id: reading.id, roomId: kitchen.json().id },
        { token },
      )
    ).statusCode,
  ).toBe(200);

  async function ask(text: string) {
    const response = await post(
      core,
      "/api/assistant/ask",
      { text },
      { token },
    );
    expect(response.statusCode).toBe(200);
    return response.json().reply;
  }

  expect(await ask("Turn on the Kitchen lights")).toBe("Kitchen lights on.");
  expect(radio.gadgets.get("lamp-2")?.state).toMatchObject({ on: true });
  expect(await ask("Set the Office to Relax")).toBe("Relax in Office.");
  expect(radio.gadgets.get("lamp-1")?.state).toMatchObject({
    on: true,
    brightness: 40,
  });
  const sent = radio.received.length;
  expect(await ask("Undo that")).toBe("I can't undo a mood.");
  expect(radio.received).toHaveLength(sent);
  expect(radio.gadgets.get("lamp-2")?.state).toMatchObject({ on: true });

  expect(await ask("Turn off the Kitchen lights")).toBe("Kitchen lights off.");
  expect(await ask("Put it back")).toBe("Put back.");
  expect(radio.gadgets.get("lamp-2")?.state).toMatchObject({ on: true });
});

it("blocks implicit undo only for the device that ran the mood", () => {
  const changes = createAgentChanges({ isActiveAgent: () => true });
  const tablet = { id: assistant.id, requestClientId: "tablet" };
  const phone = { id: assistant.id, requestClientId: "phone" };
  const light = {
    device: "lamp",
    capability: "light",
    kind: "light" as const,
    at: new Date(),
    before: { on: false },
    asked: { on: true },
  };
  const tabletChange = changes.record(tablet, [light]);
  const phoneChange = changes.record(phone, [light]);

  changes.recordMood(tablet);
  expect(changes.last(tablet)).toBe("mood");
  expect(changes.last(phone)).toMatchObject({ id: phoneChange });
  expect(changes.find(tablet, tabletChange!)).toMatchObject({
    changed: [light],
  });

  const next = changes.record(tablet, [light]);
  expect(changes.last(tablet)).toMatchObject({ id: next });
});

describe("an app's action that runs moods", () => {
  const manifest = () => toStaticManifest(moods);
  type Action = ReturnType<typeof manifest>["actions"][number];
  const changed = (change: (action: Action) => Action) => {
    const whole = manifest();
    return {
      ...whole,
      actions: whole.actions.map((action) =>
        action.runs ? change(action) : action,
      ),
    };
  };

  it("is refused without the mood switch, or answering something else", () => {
    const noSwitch = changed((action) => ({
      ...action,
      assistant: {
        ...action.assistant!,
        needs: ["devices.control:light"],
      },
    }));
    const otherAnswer = changed((action) => ({
      ...action,
      output: { type: "object", properties: {} } as Action["output"],
    }));

    expect(() => contractOf(manifest())).not.toThrow();
    expect(() => contractOf(noSwitch)).toThrow(
      "Its action moods.runMood can't run mood",
    );
    expect(() => contractOf(otherAnswer)).toThrow(
      "Its action moods.runMood can't run mood",
    );
  });

  it("checks a mood publication's input against its own runner", () => {
    const state = contractOf(toStaticManifest(example)).entityTypes.get(
      moodType.id,
    )!.state;
    const values = {
      placeId: "office",
      icon: "moon",
      name: "Reading",
      order: 0,
      active: false,
    };

    expect(state({ ...values, input: { fixtureCount: 3 } }).success).toBe(true);
    expect(state({ ...values, input: {} })).toMatchObject({
      success: false,
      issues: [expect.objectContaining({ path: ["input", "fixtureCount"] })],
    });
  });
});
