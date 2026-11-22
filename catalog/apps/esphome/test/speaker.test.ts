import { EntityCategory } from "esphome-client";
import { afterEach, describe, expect, it } from "vitest";

import type { EmulatedEntity } from "./emulated-device.js";
import { add, announce, startHome } from "./support.js";

// A smart speaker, such as the Home Assistant Voice PE: a device with a voice
// assistant that plays. It's declared a smart speaker, its player is a media
// player, its button's presses are a button's, and its ring and mute switch
// stay its own. Its voice assistant waits for someone to follow its
// requests, which Sanctum does, declining each before any sound is sent.

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

const player: EmulatedEntity = {
  type: "media_player",
  key: 201,
  objectId: "media_player",
  name: "Media Player",
  fields: { supportsPause: true },
};

// The parts a Voice PE shows over its API, as its firmware names them.
const voicePe: EmulatedEntity[] = [
  player,
  {
    type: "event",
    key: 202,
    objectId: "button_press",
    name: "Button press",
    fields: {
      deviceClass: "button",
      eventTypes: [
        "double_press",
        "triple_press",
        "long_press",
        "easter_egg_press",
      ],
    },
  },
  {
    type: "switch",
    key: 203,
    objectId: "mute",
    name: "Mute",
    fields: { entityCategory: EntityCategory.CONFIG },
  },
  {
    type: "light",
    key: 204,
    objectId: "led_ring",
    name: "LED Ring",
    fields: { entityCategory: EntityCategory.CONFIG },
  },
];

const speaker = () =>
  home.plugIn({
    name: "voice",
    project: "Nabu Casa.Home Assistant Voice PE",
    voiceAssistant: true,
    entities: voicePe,
    states: { 201: { state: 1, volume: 0.6, muted: false } },
  });

describe("a smart speaker", () => {
  it("is a smart speaker that plays and is pressed, its ring and mute its own", async () => {
    home = await startHome();
    const device = await speaker();
    const key = await add(home.core, device);

    const registered = home.core.registered.get(key)!;
    expect(registered.type).toBe("smart-speaker");
    expect(
      registered.capabilities.map(({ kind, features }) => ({ kind, features })),
    ).toEqual([
      {
        kind: "media",
        features: {
          power: false,
          playback: ["play", "pause", "stop"],
          volume: "level",
          mute: true,
        },
      },
      {
        kind: "button",
        features: {
          actions: ["double_press", "triple_press", "long_press"],
          holds: [],
        },
      },
    ]);
  });

  it("follows its voice requests and declines each, once added and after it reconnects", async () => {
    home = await startHome();
    const device = await speaker();
    const key = await add(home.core, device);
    await home.core.until(() => device.voiceFollowed, "its requests followed");

    device.wake();
    await home.core.until(() => device.voiceAnswers.length === 1, "an answer");
    expect(device.voiceAnswers).toEqual([{ declined: true }]);

    const greeted = device.greeted;
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => device.greeted > greeted && device.voiceFollowed,
      "followed again",
    );
    device.wake();
    await home.core.until(() => device.voiceAnswers.length === 2, "an answer");
    expect(device.voiceAnswers[1]).toEqual({ declined: true });
    expect(home.core.availability.get(key)).toBe("online");
  });

  it("plays, pauses, stops, is set louder and muted", async () => {
    home = await startHome();
    const device = await speaker();
    const key = await add(home.core, device);
    const capability = "media-media_player";
    await home.core.until(
      () => home.core.latest(key, capability) !== undefined,
      "its state",
    );
    expect(home.core.latest(key, capability)).toEqual({
      activity: "idle",
      volume: 60,
      muted: false,
    });

    await home.core.command(key, capability, "media", { activity: "playing" });
    await home.core.command(key, capability, "media", { volume: 35 });
    await home.core.command(key, capability, "media", { muted: true });
    await home.core.until(
      () =>
        JSON.stringify(home.core.latest(key, capability)) ===
        JSON.stringify({ activity: "playing", volume: 35, muted: true }),
      "playing, quieter and muted",
    );
    await home.core.command(key, capability, "media", { playback: "stop" });
    await home.core.until(
      () =>
        (home.core.latest(key, capability) as { activity: string }).activity ===
        "idle",
      "stopped",
    );
  });

  it("is a media player, and nobody follows its requests, when it has no voice assistant", async () => {
    home = await startHome();
    const device = await home.plugIn({
      name: "player",
      entities: [player],
      states: { 201: { state: 1, volume: 0.6, muted: false } },
    });
    const key = await add(home.core, device);

    expect(home.core.registered.get(key)?.type).toBe("media-player");
    expect(device.voiceFollowed).toBe(false);
  });
});
