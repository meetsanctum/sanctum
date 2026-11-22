import { describe, expect, it, onTestFinished } from "vitest";

import { createDevices, type Deliver } from "../src/devices/devices.js";
import { command, lampsCore, radio, settled } from "./devices-support.js";
import { deferredDelivery, get, type TestCore } from "./support.js";

// Media players: what one plays and how loud is a `media` capability. A
// command that asks for state, as a volume, waits for the player's report;
// one that asks for none, as a step of the volume or the next track, is
// done once its driver takes it. History keeps when it played and was on,
// never what it played.

const minute = 60_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mediaCore(options: { confirmMs?: number } = {}) {
  const home = await lampsCore(options);
  await radio.add("box-1", "media", "Living room box");
  await settled();
  const devices = (
    await get(home.core, "/api/devices", { token: home.maya.token })
  ).json();
  const player = devices.find(
    (device: { driverName: string }) => device.driverName === "Living room box",
  );
  return { ...home, player: player.id as string };
}

async function partOf(core: TestCore, token: string, id: string) {
  const devices = (await get(core, "/api/devices", { token })).json();
  return devices
    .find((each: { id: string }) => each.id === id)
    .capabilities.find((each: { kind: string }) => each.kind === "media");
}

async function playerWithDelivery(deliver: Deliver) {
  const { core, maya, player } = await mediaCore();
  const devices = createDevices(core.db, {
    gate: core.gate,
    places: core.places,
    activity: core.activity,
    deliver,
    now: core.now,
  });
  onTestFinished(() => devices.close());
  const send = (command: object) =>
    devices.command(
      { kind: "user", id: maya.person.id },
      { device: player, capability: "media", command },
      {},
      null,
    );
  const part = () => devices.get(player)?.capabilities[0];
  return { devices, send, part };
}

describe("a media player", () => {
  it("comes in as one, with what it can do and what it is doing", async () => {
    const { core, maya, player } = await mediaCore();
    const devices = (
      await get(core, "/api/devices", { token: maya.token })
    ).json();

    expect(
      devices.find((each: { id: string }) => each.id === player),
    ).toMatchObject({
      type: "media-player",
      name: "Media Player",
      capabilities: [
        {
          id: "media",
          kind: "media",
          features: {
            power: true,
            playback: ["play", "pause", "stop", "next", "previous", "seek"],
            volume: "level",
            mute: true,
          },
          state: { on: true, activity: "idle", volume: 30, muted: false },
          sync: "synced",
        },
      ],
    });
  });

  it("waits for its report to confirm a volume", async () => {
    const { core, maya, player } = await mediaCore();
    radio.confirms = false;
    const answer = await command(core, maya.token, player, "media", {
      volume: 60,
    });

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      sync: "pending",
      desired: { volume: 60 },
      state: { volume: 60 },
    });
    core.devices.report("test.lamps", {
      key: "box-1",
      states: { media: { activity: "idle" } },
    });
    expect(await partOf(core, maya.token, player)).toMatchObject({
      sync: "pending",
      desired: { volume: 60 },
    });
    await radio.press("box-1", {});
    await settled();
    expect(await partOf(core, maya.token, player)).toMatchObject({
      sync: "synced",
      desired: null,
      state: { volume: 60 },
    });
  });

  it("keeps the newer command's attribution when an older skip finishes late", async () => {
    const skip = deferredDelivery();
    const { send, part } = await playerWithDelivery(async (_, { command }) => {
      if ("playback" in command) await skip.promise;
    });

    const older = send({ playback: "next" });
    await send({ volume: 60 });
    skip.resolve();
    await older;

    expect(part()).toMatchObject({
      sync: "pending",
      desired: { volume: 60 },
      setBy: { asked: { volume: 60 } },
    });
  });

  it("restores a successful skip's attribution when a newer command fails", async () => {
    const skip = deferredDelivery();
    const volume = deferredDelivery();
    const { send, part } = await playerWithDelivery(async (_, { command }) => {
      await ("playback" in command ? skip.promise : volume.promise);
    });

    const older = send({ playback: "next" });
    const newer = send({ volume: 60 });
    skip.resolve();
    await older;
    volume.reject(new Error("The player stopped answering"));
    await expect(newer).rejects.toMatchObject({ code: "app_failed" });

    expect(part()).toMatchObject({
      sync: "synced",
      desired: null,
      setBy: { asked: {} },
    });
  });

  it("leaves a replacement capability alone when a skip finishes late", async () => {
    const skip = deferredDelivery();
    const { devices, send, part } = await playerWithDelivery(
      () => skip.promise,
    );
    const older = send({ playback: "next" });
    devices.register("test.lamps", {
      key: "box-1",
      name: "Living room box",
      type: "switch",
      capabilities: [{ id: "media", kind: "switch" }],
    });
    skip.resolve();
    await older;

    expect(part()).toMatchObject({ kind: "switch", setBy: null });
  });

  it("is done with a step of the volume once its driver takes it, and never sends it again", async () => {
    const { core, maya, player } = await mediaCore({ confirmMs: 50 });
    radio.confirms = false;
    const answer = await command(core, maya.token, player, "media", {
      volumeStep: "up",
    });

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      sync: "synced",
      desired: null,
      setBy: { asked: {} },
    });
    expect(radio.received.map((each) => each.command.command)).toEqual([
      { volumeStep: "up" },
    ]);
    // Long past the time a report had to confirm a command.
    await wait(120);
    expect(radio.received).toHaveLength(1);
    expect(await partOf(core, maya.token, player)).toMatchObject({
      sync: "synced",
    });
    // What its report says next is what it shows.
    await radio.press("box-1", {});
    await settled();
    expect(await partOf(core, maya.token, player)).toMatchObject({
      state: { volume: 35 },
    });
  });

  it("leaves a command waiting for its report as it is when one that asks nothing goes", async () => {
    const { core, maya, player } = await mediaCore();
    radio.confirms = false;
    await command(core, maya.token, player, "media", { volume: 60 });
    const next = await command(core, maya.token, player, "media", {
      playback: "next",
    });

    expect(next.json()).toMatchObject({
      sync: "pending",
      desired: { volume: 60 },
      setBy: { asked: {} },
    });
    await radio.press("box-1", {});
    await settled();
    expect(await partOf(core, maya.token, player)).toMatchObject({
      sync: "synced",
      state: { volume: 60 },
    });
  });

  it("says in its activity what a command that asks nothing was", async () => {
    const { core, maya, player } = await mediaCore();
    await command(core, maya.token, player, "media", { playback: "next" });
    await settled();
    const page = (
      await get(core, `/api/activity?device=${player}`, { token: maya.token })
    ).json();
    const entry = page.entries.find(
      (each: { action: string }) => each.action === "device.command",
    );

    expect(entry).toMatchObject({
      outcome: "ok",
      subject: { id: player },
      detail: { capability: "media", asked: {}, command: { playback: "next" } },
    });
  });

  it("refuses a command it has no shape for", async () => {
    const { core, maya, player } = await mediaCore();
    const answer = await command(core, maya.token, player, "media", {
      playback: "play",
    });

    expect(answer.statusCode).toBe(400);
    expect(radio.received).toEqual([]);
  });

  it("has changed when it starts playing, not when its volume does", async () => {
    const { core, maya, player } = await mediaCore();
    const first = (await partOf(core, maya.token, player)).changedAt;
    core.advance(minute);
    await radio.press("box-1", { volume: 50 });
    await settled();
    expect((await partOf(core, maya.token, player)).changedAt).toBe(first);
    core.advance(minute);
    await radio.press("box-1", { activity: "playing" });
    await settled();
    expect((await partOf(core, maya.token, player)).changedAt).toBe(
      core.now().toISOString(),
    );
  });

  it("has when it played and was on in its history, never what or how loud", async () => {
    const { core, maya, player } = await mediaCore();
    const noon = core.now().getTime();
    core.advance(2 * minute);
    await radio.press("box-1", {
      activity: "playing",
      volume: 45,
      media: { title: "Slow Horses", season: 4, episode: 2 },
    });
    await settled();
    core.advance(minute);
    await radio.press("box-1", { volume: 50 });
    await settled();
    core.advance(2 * minute);
    core.history.maintain();

    const params = new URLSearchParams({
      device: player,
      capability: "media",
      from: new Date(noon).toISOString(),
    });
    const recorded = (
      await get(core, `/api/history/states?${params}`, { token: maya.token })
    ).json();
    expect(
      recorded.states.map((each: { state: unknown }) => each.state),
    ).toEqual([
      { on: true, activity: "idle" },
      { on: true, activity: "playing" },
    ]);

    params.set("period", "5m");
    const rolled = (
      await get(core, `/api/history/statistics?${params}`, {
        token: maya.token,
      })
    ).json();
    expect(rolled.fields.playing).toEqual([
      {
        start: new Date(noon).toISOString(),
        mean: 3 / 5,
        min: 0,
        max: 1,
        seconds: 300,
      },
    ]);
    expect(rolled.fields.on[0]).toMatchObject({ mean: 1 });
  });

  it("refuses a report the kind has no shape for", async () => {
    const { core } = await mediaCore();
    expect(() =>
      core.devices.report("test.lamps", {
        key: "box-1",
        states: { media: { activity: "rewinding" } },
      }),
    ).toThrow(/media state/);
  });
});
