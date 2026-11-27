import { toStaticManifest } from "@meetsanctum/app-sdk";
import moods from "@meetsanctum/moods";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { contractOf } from "../src/app-host/contract.js";
import { connect, names } from "./agents-support.js";
import { lampsCore, radio, settled } from "./devices-support.js";
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

async function household() {
  const home = await lampsCore({ apps: [moodsPackage] });
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
    const { client, offer } = await household();
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

    const own = await client
      .callTool({
        name: "sanctum_moods_runMood",
        arguments: { id: relax!.key },
      })
      .then(
        (result) => ({ isError: result.isError === true }),
        (error: Error) => ({ isError: true, message: error.message }),
      );

    expect(own.isError).toBe(true);
  });

  it("describes what running a mood does", async () => {
    const { client } = await household();

    const { tools } = await client.listTools();
    const run = tools.find((tool) => tool.name === "run");

    expect(run?.description).toContain("Runs a mood by the app and key");
    expect(run?.description).toContain("can turn others there off");
  });
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
});
