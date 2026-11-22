import {
  controlPermission,
  defineAction,
  defineApp,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { changesKept } from "../src/agents/changes.js";
import { connect } from "./agents-support.js";
import {
  command,
  devicesSeenBy,
  lampsCore,
  radio,
  settled,
} from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import { post } from "./support.js";

// What AI agents do with lights: on, off, brighter, dimmer and a set
// brightness and colour temperature, each light answered for, and putting
// an agent's own change back where nobody changed it since.

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
    actions: [glow],
    events: [],
  }),
  origin: "official",
};

async function household() {
  const home = await lampsCore({ apps: [examplePackage] });
  const { core, maya, lamp, plug } = home;
  const token = maya.token;
  await radio.add("lamp-2", "light", "Reading lamp");
  await settled();
  const reading = (await devicesSeenBy(core, token)).find(
    (device: { driverName: string }) => device.driverName === "Reading lamp",
  ).id as string;
  const living = (
    await post(
      core,
      "/api/places/rooms/add",
      { name: "Living room" },
      { token },
    )
  ).json().id as string;
  for (const id of [lamp, reading, plug]) {
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
  const room = { kind: "room", id: living };
  return { ...home, token, living, room, reading, agent, client, area };
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
    content: result.structuredContent as Record<string, unknown> & {
      change?: string;
      lights?: Record<string, unknown>[];
      changed?: Record<string, unknown>[];
    },
  };
}

// Each light's result in the answer, by device.
const results = (answer: Awaited<ReturnType<typeof call>>) =>
  Object.fromEntries(
    (answer.content.lights ?? []).map((light) => [
      light.device,
      { result: light.result, why: light.why, state: light.state },
    ]),
  );

const done = expect.stringMatching(/^(sent|confirmed)$/);

describe("AI agents' lights", () => {
  it("dims the lights that are on and leaves those that are off", async () => {
    const { core, token, client, room, lamp, reading } = await household();
    await command(core, token, lamp, "light", { on: true, brightness: 50 });
    await settled();

    const answer = await call(client, "lights", { place: room, to: "dimmer" });
    await settled();

    expect(answer.isError).toBe(false);
    expect(results(answer)).toEqual({
      [lamp]: {
        result: done,
        why: undefined,
        state: expect.objectContaining({ brightness: 30 }),
      },
      [reading]: { result: "skipped", why: "off", state: expect.anything() },
    });
    expect(answer.content.change).toEqual(expect.any(String));
  });

  it("sets a lit light's brightness alone, and brings an off one on with it", async () => {
    const { core, token, client, room, lamp, reading } = await household();
    await command(core, token, lamp, "light", {
      on: true,
      brightness: 50,
      hue: 20,
      saturation: 80,
    });
    await settled();

    const answer = await call(client, "lights", {
      place: room,
      set: { brightness: 100 },
    });
    await settled();

    expect(results(answer)[lamp]).toMatchObject({
      result: done,
      // A colour of its own stays.
      state: { on: true, brightness: 100, colorMode: "color", hue: 20 },
    });
    expect(results(answer)[reading]).toMatchObject({
      result: done,
      state: { on: true, brightness: 100 },
    });
  });

  it("keeps a colour temperature within each light's range", async () => {
    const { client, room, lamp } = await household();

    const answer = await call(client, "lights", {
      place: room,
      set: { colorTemperature: 60 },
    });
    await settled();

    // The lamps go no warmer than 500 mireds and no cooler than 153.
    expect(results(answer)[lamp]).toMatchObject({
      result: done,
      state: { on: true, colorTemperature: 153 },
    });
  });

  it("answers for a light that isn't answering", async () => {
    const { client, room, lamp, reading } = await household();
    await radio.unplug("lamp-2");
    await settled();

    const answer = await call(client, "lights", { place: room, to: "on" });

    expect(results(answer)[reading]).toMatchObject({ result: "offline" });
    expect(results(answer)[lamp]).toMatchObject({ result: done });
  });

  it("takes either to or set, not both", async () => {
    const { client, room } = await household();

    for (const input of [
      { place: room },
      { place: room, to: "on", set: { brightness: 10 } },
      { place: room, set: {} },
    ]) {
      expect(await call(client, "lights", input)).toMatchObject({
        isError: true,
        content: { error: "invalid_input" },
      });
    }
  });
});

describe("putting an AI agent's change back", () => {
  it("puts lights back as they were, and says the same when asked again", async () => {
    const { core, token, client, room, lamp, reading } = await household();
    await command(core, token, lamp, "light", { on: true, brightness: 40 });
    await settled();

    const changed = await call(client, "lights", {
      place: room,
      set: { brightness: 100 },
    });
    await settled();
    const restored = await call(client, "restore", {
      change: changed.content.change,
    });
    await settled();

    expect(restored.isError).toBe(false);
    const byDevice = Object.fromEntries(
      restored.content.changed!.map((item) => [item.device, item]),
    );
    expect(byDevice[lamp]).toMatchObject({
      result: done,
      state: { on: true, brightness: 40 },
    });
    expect(byDevice[reading]).toMatchObject({
      result: done,
      state: { on: false },
    });
    const sent = radio.received.length;
    expect(
      await call(client, "restore", { change: changed.content.change }),
    ).toEqual(restored);
    expect(radio.received).toHaveLength(sent);
  });

  it("leaves a light someone changed since", async () => {
    const { client, room, lamp, reading } = await household();

    const changed = await call(client, "lights", { place: room, to: "on" });
    await settled();
    // Someone turns the reading lamp off at the lamp.
    await radio.press("lamp-2", { on: false });
    await settled();

    const restored = await call(client, "restore", {
      change: changed.content.change,
    });

    const byDevice = Object.fromEntries(
      restored.content.changed!.map((item) => [item.device, item]),
    );
    expect(byDevice[reading]).toMatchObject({ result: "changed", by: null });
    expect(byDevice[lamp]).toMatchObject({ result: done });
  });

  it("names an app that changed a light since", async () => {
    const { client, room, lamp } = await household();

    const changed = await call(client, "lights", {
      place: room,
      set: { brightness: 30 },
    });
    await settled();
    await call(client, "sanctum_example_glow", { device: lamp });
    await radio.press("lamp-1", { on: true, brightness: 80 });
    await settled();

    const restored = await call(client, "restore", {
      change: changed.content.change,
    });

    expect(
      restored.content.changed!.find((item) => item.device === lamp),
    ).toMatchObject({ result: "changed", by: "Example" });
  });

  it("says a command still on its way is uncertain", async () => {
    const { client, room, lamp } = await household();
    radio.confirms = false;

    const changed = await call(client, "lights", { place: room, to: "on" });
    const restored = await call(client, "restore", {
      change: changed.content.change,
    });
    radio.confirms = true;

    expect(
      restored.content.changed!.find((item) => item.device === lamp),
    ).toMatchObject({ result: "uncertain" });
  });

  it("puts back a plug switched by a device command", async () => {
    const { client, area, plug } = await household();
    await area(controlPermission("switch"), true);

    const changed = await call(client, "device_command", {
      device: plug,
      capability: "power",
      command: { on: true },
    });
    await settled();
    const restored = await call(client, "restore", {
      change: changed.content.change,
    });
    await settled();

    expect(restored.content.changed).toEqual([
      expect.objectContaining({
        device: plug,
        result: done,
        state: { on: false },
      }),
    ]);
  });

  it("keeps an agent's last changes only, its own only", async () => {
    const { core, client, room, maya } = await household();
    const first = await call(client, "lights", { place: room, to: "on" });
    for (let each = 0; each < changesKept.count; each++) {
      await call(client, "lights", {
        place: room,
        to: each % 2 ? "on" : "off",
      });
      await settled();
    }
    // The lights are off after those, so this one sends something too.
    const last = await call(client, "lights", { place: room, to: "on" });
    expect(last.content.change).toEqual(expect.any(String));
    const other = core.auth.clients.createAgent({
      name: "Claude Code",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });
    const otherClient = await connect(core, other.token);

    for (const [caller, change] of [
      [client, first.content.change],
      [otherClient, last.content.change],
      [client, "not-a-change"],
    ] as const) {
      expect(await call(caller, "restore", { change })).toMatchObject({
        isError: true,
        content: { error: "change_gone" },
      });
    }
  });

  it("forgets changes after an hour", async () => {
    const { core, client, room } = await household();
    const changed = await call(client, "lights", { place: room, to: "on" });

    core.advance(changesKept.ms + 1);

    expect(
      await call(client, "restore", { change: changed.content.change }),
    ).toMatchObject({ isError: true, content: { error: "change_gone" } });
  });

  it("gives no change when nothing was sent", async () => {
    const { client, room } = await household();

    const answer = await call(client, "lights", { place: room, to: "off" });

    expect(answer.content.change).toBeNull();
    expect(
      (answer.content.lights ?? []).every(
        (light) => light.result === "skipped" && light.why === "already",
      ),
    ).toBe(true);
  });

  it("refuses to put back a change whose area was switched off since", async () => {
    const { client, area, room } = await household();
    const changed = await call(client, "lights", { place: room, to: "on" });
    await area(controlPermission("switch"), true);
    await area(controlPermission("light"), false);

    expect(
      await call(client, "restore", { change: changed.content.change }),
    ).toMatchObject({ isError: true, content: { error: "not_allowed" } });
  });
});
