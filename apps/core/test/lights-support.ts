import {
  defineAction,
  defineApp,
  turnOnSchema,
  turnOnType,
} from "@meetsanctum/app-sdk";
import { expect } from "vitest";
import { z } from "zod";

import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";

// Publishes a room's lights.turnOn as a test asks, as Moods would.
const rule = defineAction({
  id: "rules.publish",
  title: "Publish",
  tier: "write",
  input: z.object({ key: z.string(), state: z.unknown() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.entities.publish({
      type: turnOnType.id,
      key: input.key,
      name: input.key,
      state: input.state,
    });
    return {};
  },
});
const rules = defineApp({
  id: "sanctum.example",
  name: "Rules",
  version: "0.1.0",
  core: "^2.0.0",
  permissions: [],
  actions: [rule],
  events: [],
  provides: { entities: [turnOnType] },
});

export async function home() {
  const context = await lampsCore({
    apps: [{ app: rules, origin: "official" }],
  });
  const { core, maya, lamp, plug } = context;
  const token = maya.token;
  const room = async (name: string) =>
    (await post(core, "/api/places/rooms/add", { name }, { token })).json()
      .id as string;
  const living = await room("Living room");
  const kitchen = await room("Kitchen");
  const hall = await room("Hall");
  const downstairs = (
    await post(
      core,
      "/api/places/zones/add",
      { name: "Downstairs", roomIds: [living, kitchen] },
      { token },
    )
  ).json().id as string;
  for (const [key, name] of [
    ["ceiling-1", "Ceiling"],
    ["counter-1", "Counter"],
    ["hall-1", "Hall light"],
    ["away-1", "Away"],
    ["loose-1", "Loose"],
  ]) {
    await radio.add(key!, "light", name);
  }
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    driverName: string;
  }[];
  const idOf = (name: string) =>
    devices.find((device) => device.driverName === name)!.id;
  const ids = {
    lamp,
    plug,
    ceiling: idOf("Ceiling"),
    counter: idOf("Counter"),
    hall: idOf("Hall light"),
    away: idOf("Away"),
    loose: idOf("Loose"),
  };
  for (const [id, roomId] of [
    [ids.lamp, living],
    [ids.plug, living],
    [ids.ceiling, living],
    [ids.away, living],
    [ids.counter, kitchen],
    [ids.hall, hall],
  ]) {
    await post(core, "/api/devices/update", { id, roomId }, { token });
  }
  // The lamp and the hall light are on, the plug too; Away is unplugged.
  await radio.press("lamp-1", { on: true });
  await radio.press("hall-1", { on: true });
  await radio.press("plug-1", { on: true });
  await radio.unplug("away-1");
  await settled();
  return { ...context, token, ids, living, kitchen, hall, downstairs };
}

export function lights(core: TestCore, token: string, body: unknown) {
  return post(core, "/api/devices/lights", body, { token });
}

export async function publishRule(
  core: TestCore,
  token: string,
  key: string,
  // As an app writes it: one that names no rank is a choice.
  state: z.input<typeof turnOnSchema>,
) {
  const response = await post(
    core,
    `/api/apps/${rules.id}/actions/${rule.id}`,
    { key, state },
    { token },
  );
  expect(response.statusCode).toBe(200);
}

// What the radio was told, light by light, as the core asked for it.
export const asked = () =>
  Object.fromEntries(
    radio.received.map(({ command }) => [command.key, command.command]),
  );

// The lights the radio was told to switch, by what it calls them, and whether
// on or off: turning one on, the core adds the look it comes back at.
export const switched = () =>
  radio.received.map(({ command }) => [
    command.key,
    { on: (command.command as { on: boolean }).on },
  ]);

export async function darkRoom() {
  const context = await home();
  const { core, token, living } = context;
  await lights(core, token, {
    place: { kind: "room", id: living },
    to: "off",
  });
  await settled();
  radio.received.length = 0;
  return context;
}
