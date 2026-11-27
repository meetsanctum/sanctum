import {
  controlPermission,
  defineAction,
  defineApp,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
// brightness, white or colour, each light answered for, and putting
// an agent's own change back where nobody changed it since.

// Turns one light on, as an app's action that commands devices does.
const glow = defineAction({
  id: "example.glow",
  title: "Glow",
  tier: "write",
  input: z.object({
    device: z.string(),
    brightness: z.number().optional(),
  }),
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
      command: { on: true, brightness: input.brightness },
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

async function household(options?: Parameters<typeof lampsCore>[0]) {
  const home = await lampsCore({ ...options, apps: [examplePackage] });
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
  it("does not treat confirmation of a later command as confirmation of the first", async () => {
    const { client, lamp } = await household();
    let receive!: () => void;
    const receiving = new Promise<void>((resolve) => {
      receive = resolve;
    });
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const radioCommand = vi
      .spyOn(radio, "carryOut")
      .mockImplementationOnce(() => {
        receive();
        return accepted;
      });
    onTestFinished(() => {
      radioCommand.mockRestore();
    });

    const first = call(client, "lights", {
      place: {
        kind: "lights",
        lights: [{ device: lamp, capability: "light" }],
      },
      set: { brightness: 80 },
    });
    await receiving;
    try {
      await call(client, "device_command", {
        device: lamp,
        capability: "light",
        command: { brightness: 20 },
      });
      await settled();
    } finally {
      accept();
    }

    expect(results(await first)[lamp]).toMatchObject({
      result: "sent",
      state: { brightness: 20 },
    });
  });

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

  it("sets a lit light's brightness alone, and leaves an off one off while one is on", async () => {
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
      result: "skipped",
      why: "off",
      state: { on: false },
    });
  });

  it("brings the room up at a brightness while none of its lights is on", async () => {
    const { client, room, lamp, reading } = await household();

    const answer = await call(client, "lights", {
      place: room,
      set: { brightness: 30 },
    });
    await settled();

    for (const light of [lamp, reading]) {
      expect(results(answer)[light]).toMatchObject({
        result: done,
        state: { on: true, brightness: 30 },
      });
    }
  });

  it("brings every light to a white, at the level of those that are on", async () => {
    const { core, token, client, room, lamp, reading } = await household();
    await command(core, token, lamp, "light", { on: true, brightness: 60 });
    await settled();

    const answer = await call(client, "lights", {
      place: room,
      set: { colorTemperature: 250 },
    });
    await settled();

    expect(results(answer)[lamp]).toMatchObject({
      result: done,
      state: { on: true, brightness: 60, colorTemperature: 250 },
    });
    expect(results(answer)[reading]).toMatchObject({
      result: done,
      state: { on: true, brightness: 60, colorTemperature: 250 },
    });
  });

  it("brings every light to a colour at the brightness asked", async () => {
    const { core, token, client, room, lamp, reading } = await household();
    await command(core, token, lamp, "light", { on: true, brightness: 60 });
    await settled();

    const answer = await call(client, "lights", {
      place: room,
      set: { brightness: 100, hue: 220, saturation: 80 },
    });
    await settled();

    for (const light of [lamp, reading]) {
      expect(results(answer)[light]).toMatchObject({
        result: done,
        state: {
          on: true,
          brightness: 100,
          colorMode: "color",
          hue: 220,
          saturation: 80,
        },
      });
    }
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
  it("restores a temperature when the light reports it without a colour mode", async () => {
    const { client, lamp } = await household();
    const changed = await call(client, "lights", {
      place: {
        kind: "lights",
        lights: [{ device: lamp, capability: "light" }],
      },
      set: { colorTemperature: 250 },
    });
    await settled();
    await radio.press("lamp-1", { colorMode: undefined });

    const restored = await call(client, "restore", {
      change: changed.content.change,
    });

    expect(restored.content.changed).toMatchObject([
      { result: done, state: { on: false, colorTemperature: 370 } },
    ]);
  });

  it("sends one restore command when two calls ask for the same change", async () => {
    const { client, lamp } = await household();
    const changed = await call(client, "device_command", {
      device: lamp,
      capability: "light",
      command: { on: true },
    });
    await settled();
    const sent = radio.received.length;
    const input = { change: changed.content.change };

    const [first, second] = await Promise.all([
      call(client, "restore", input),
      call(client, "restore", input),
    ]);

    expect(first.content.changed).toMatchObject([{ result: done }]);
    expect(second).toEqual(first);
    expect(radio.received).toHaveLength(sent + 1);
  });

  it("restores a light dimmed to zero by a device command", async () => {
    const { client, core, token, lamp } = await household();
    await command(core, token, lamp, "light", { on: true, brightness: 40 });
    await settled();

    const changed = await call(client, "device_command", {
      device: lamp,
      capability: "light",
      command: { brightness: 0 },
    });
    await settled();
    const restored = await call(client, "restore", {
      change: changed.content.change,
    });

    expect(restored.content.changed).toMatchObject([
      { result: done, state: { on: true, brightness: 40 } },
    ]);
  });

  it("leaves a light someone switched off after a brightness command", async () => {
    const { client, core, token, lamp } = await household();
    await command(core, token, lamp, "light", { on: true, brightness: 40 });
    await settled();
    const changed = await call(client, "device_command", {
      device: lamp,
      capability: "light",
      command: { brightness: 60 },
    });
    await settled();
    await radio.press("lamp-1", { on: false });

    const restored = await call(client, "restore", {
      change: changed.content.change,
    });

    expect(restored.content.changed).toMatchObject([
      { result: "changed", by: null, state: { on: false, brightness: 60 } },
    ]);
  });

  it("can restore the lights that changed before a command limit was reached", async () => {
    const { client, core, room } = await household({
      agentCommandLimits: { agentPerMinute: 1, homePerMinute: 10 },
    });
    const changed = await call(client, "lights", { place: room, to: "on" });
    await settled();

    expect(changed).toMatchObject({
      isError: true,
      content: {
        error: "limited",
        change: expect.any(String),
        lights: expect.arrayContaining([
          expect.objectContaining({ result: done }),
          expect.objectContaining({ result: "failed", why: "limited" }),
        ]),
      },
    });
    core.advance(61_000);
    const restored = await call(client, "restore", {
      change: changed.content.change,
    });
    expect(restored.content.changed).toMatchObject([
      { result: done, state: { on: false } },
    ]);
  });

  it("returns the same partial restore results when asked again", async () => {
    const { client, core, room } = await household({
      agentCommandLimits: { agentPerMinute: 3, homePerMinute: 10 },
    });
    const changed = await call(client, "lights", { place: room, to: "on" });
    await settled();
    const input = { change: changed.content.change };
    const first = await call(client, "restore", input);
    await settled();
    const sent = radio.received.length;

    expect(first).toMatchObject({
      isError: true,
      content: {
        error: "limited",
        changed: expect.arrayContaining([
          expect.objectContaining({ result: done }),
          expect.objectContaining({ result: "failed", why: "limited" }),
        ]),
      },
    });
    core.advance(61_000);
    expect(await call(client, "restore", input)).toEqual(first);
    expect(radio.received).toHaveLength(sent);
  });

  it("puts lights back as they were, and says the same when asked again", async () => {
    const { core, token, client, room, lamp, reading } = await household();
    await command(core, token, lamp, "light", { on: true, brightness: 40 });
    await settled();

    const changed = await call(client, "lights", {
      place: room,
      set: { brightness: 100, colorTemperature: 250 },
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
    await call(client, "sanctum_example_glow", {
      device: lamp,
      brightness: 80,
    });
    await settled();

    const restored = await call(client, "restore", {
      change: changed.content.change,
    });

    expect(
      restored.content.changed!.find((item) => item.device === lamp),
    ).toMatchObject({ result: "changed", by: "Example" });
  });

  it("does not attribute a physical brightness change to an app that turned the light on", async () => {
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

    expect(restored.content.changed).toContainEqual(
      expect.objectContaining({ device: lamp, result: "changed", by: null }),
    );
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

  it("refuses a repeat restore after its area is switched off", async () => {
    const { client, area, room } = await household();
    const changed = await call(client, "lights", { place: room, to: "on" });
    await settled();
    const input = { change: changed.content.change };
    expect(await call(client, "restore", input)).toMatchObject({
      isError: false,
    });

    await area(controlPermission("switch"), true);
    await area(controlPermission("light"), false);
    expect(await call(client, "restore", input)).toMatchObject({
      isError: true,
      content: { error: "not_allowed" },
    });
  });
});
