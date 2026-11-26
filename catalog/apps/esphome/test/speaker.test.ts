import { MediaPlayerState, VoiceAssistantEvent } from "esphome-client";
import { afterEach, describe, expect, it } from "vitest";

import { add, announce, startHome } from "./support.js";
import { player, voicePe } from "./voice-pe.js";

// A smart speaker, such as the Home Assistant Voice PE: a device with a voice
// assistant that plays. It's declared a smart speaker, its player is a media
// player, its button's presses are a button's, and its ring and mute switch
// stay its own. Its voice assistant waits for someone to follow its
// requests, which Sanctum does, declining each the core doesn't take before
// any sound is sent (listening.test.ts).

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

const speaker = () => voicePe(home);

describe("a smart speaker", () => {
  it("is a smart speaker that plays, is pressed and has microphones, its ring its own", async () => {
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
      // Its Mute switch, which its side switch turns on too, and its player's
      // format for announcements.
      {
        kind: "audio",
        features: {
          mutes: true,
          muteSwitch: true,
          announces: true,
          announcementPlayer: "media-media_player",
          listens: true,
        },
      },
    ]);

    await home.core.until(() => device.voiceFollowed, "its requests followed");
    device.fire(202, "easter_egg_press");
    device.fire(202, "long_press");
    await home.core.until(() => home.core.presses.length > 0, "its long press");
    expect(home.core.presses).toEqual([
      { key, capability: "event-button_press", action: "long_press" },
    ]);
  });

  it("follows its voice requests and declines each, once added and after it reconnects", async () => {
    home = await startHome();
    const device = await speaker();
    const key = await add(home.core, device);
    await home.core.until(() => device.voiceFollowed, "its requests followed");

    const declinedRun = [
      { type: "response", isDeclined: true },
      { type: "event", eventType: VoiceAssistantEvent.RUN_END },
    ];
    device.wake();
    await home.core.until(
      () => device.voiceMessages.length >= declinedRun.length,
      "its run ended",
    );
    expect(device.voiceMessages).toEqual(declinedRun);

    const greeted = device.greeted;
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => device.greeted > greeted && device.voiceFollowed,
      "followed again",
    );
    device.wake();
    await home.core.until(
      () => device.voiceMessages.length >= declinedRun.length * 2,
      "its run ended",
    );
    expect(device.voiceMessages).toEqual([...declinedRun, ...declinedRun]);
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
    await home.core.until(() => {
      const state = home.core.latest(key, capability);
      return (
        state?.activity === "playing" &&
        state.volume === 35 &&
        state.muted === true
      );
    }, "playing, quieter and muted");
    await home.core.command(key, capability, "media", { activity: "paused" });
    await home.core.until(
      () => home.core.latest(key, capability)?.activity === "paused",
      "paused",
    );
    await home.core.command(key, capability, "media", { playback: "stop" });
    await home.core.until(
      () => home.core.latest(key, capability)?.activity === "idle",
      "stopped",
    );
  });

  it("is doing what it did before while it announces, idle or playing", async () => {
    home = await startHome();
    const device = await speaker();
    const key = await add(home.core, device);
    const capability = "media-media_player";
    await home.core.until(
      () => home.core.latest(key, capability) !== undefined,
      "its state",
    );
    const activities = () =>
      home.core.reports
        .map((each) => each.states[capability] as { activity?: string })
        .filter((state) => state !== undefined)
        .map((state) => state.activity);

    // An answer or a timer's chime while it is idle is not playing.
    device.setState(201, { state: MediaPlayerState.ANNOUNCING, volume: 0.5 });
    await home.core.until(
      () => home.core.latest(key, capability)?.volume === 50,
      "its announcement",
    );
    expect(activities()).not.toContain("playing");
    device.setState(201, { state: MediaPlayerState.IDLE, volume: 0.6 });

    // One in the middle of music leaves it playing.
    device.setState(201, { state: MediaPlayerState.PLAYING });
    await home.core.until(
      () => home.core.latest(key, capability)?.activity === "playing",
      "playing",
    );
    device.setState(201, { state: MediaPlayerState.ANNOUNCING, volume: 0.7 });
    await home.core.until(
      () => home.core.latest(key, capability)?.volume === 70,
      "its announcement over music",
    );
    expect(home.core.latest(key, capability)?.activity).toBe("playing");
    expect(activities().slice(-2)).toEqual(["playing", "playing"]);

    const reports = activities().length;
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => activities().length > reports,
      "its state after reconnecting",
    );
    expect(activities().slice(reports)).toEqual(["playing"]);
  });

  it("sends an announcement to the FLAC player and reports each player's own activity", async () => {
    home = await startHome();
    const music = {
      ...player,
      key: 207,
      objectId: "music",
      messages: undefined,
    };
    const device = await home.plugIn({
      name: "voice",
      voiceAssistant: true,
      entities: [music, player],
      states: {
        201: { state: MediaPlayerState.IDLE, volume: 0.6 },
        207: { state: MediaPlayerState.IDLE, volume: 0.6 },
      },
    });
    const key = await add(home.core, device);
    const capability = "media-media_player";
    expect(home.core.registered.get(key)?.capabilities).toContainEqual(
      expect.objectContaining({
        kind: "audio",
        features: expect.objectContaining({
          announces: true,
          announcementPlayer: capability,
        }),
      }),
    );
    await home.core.until(
      () => home.core.latest(key, capability)?.activity === "idle",
      "idle",
    );

    const url = "http://192.168.1.20:4180/a/abc.flac";
    device.silent.add(201);
    await home.core.command(key, "audio", "audio", { announce: { url } });
    await home.core.until(
      () => device.commands.some((command) => command.fields.mediaUrl === url),
      "it received the announcement",
    );
    expect(device.commands.at(-1)).toMatchObject({
      type: "media_player",
      key: 201,
      fields: { mediaUrl: url, announcement: true },
    });
    // The Voice PE reports the announcement it was asked for as playing.
    device.setState(201, { state: MediaPlayerState.PLAYING, volume: 0.4 });
    device.setState(207, { state: MediaPlayerState.PLAYING });
    await home.core.until(
      () => home.core.latest(key, "media-music")?.activity === "playing",
      "the other player reports while the fetch notice is pending",
    );
    expect(home.core.latest(key, capability)?.volume).toBe(60);
    await home.core.command(key, "audio", "audio", {
      announcementFetched: { url },
    });
    await home.core.until(
      () => home.core.latest(key, capability)?.volume === 40,
      "the announcing player reports after the fetch notice",
    );
    // The announcing player is doing what it did before; the other plays.
    expect(home.core.latest(key, capability)?.activity).toBe("idle");

    // Once it has stopped, playing is its own again.
    device.setState(201, { state: MediaPlayerState.IDLE, volume: 0.5 });
    await home.core.until(
      () => home.core.latest(key, capability)?.volume === 50,
      "the announcement's end",
    );
    device.setState(201, { state: MediaPlayerState.PLAYING });
    await home.core.until(
      () => home.core.latest(key, capability)?.activity === "playing",
      "playing after the announcement",
    );
  });

  it("reports ordinary playback after reconnecting during an announcement", async () => {
    home = await startHome();
    const device = await speaker();
    const key = await add(home.core, device);
    const capability = "media-media_player";
    await home.core.until(
      () => home.core.latest(key, capability)?.activity === "idle",
      "idle",
    );
    const url = "http://192.168.1.20:4180/a/abc.flac";
    device.silent.add(201);
    await home.core.command(key, "audio", "audio", { announce: { url } });
    await home.core.until(
      () => device.commands.some((command) => command.fields.mediaUrl === url),
      "it received the announcement",
    );
    await home.core.command(key, "audio", "audio", {
      announcementFetched: { url },
    });
    device.setState(201, { state: MediaPlayerState.PLAYING, volume: 0.4 });
    await home.core.until(
      () => home.core.latest(key, capability)?.volume === 40,
      "it reported announcement playback",
    );
    expect(home.core.latest(key, capability)?.activity).toBe("idle");
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => home.core.latest(key, capability)?.activity === "playing",
      "it reported ordinary playback on the new connection",
    );
  });

  it("keeps a speaker's activity separate from another speaker with the same capability", async () => {
    home = await startHome();
    const first = await speaker();
    const firstKey = await add(home.core, first);
    const second = await home.plugIn({
      entities: [player],
      states: { 201: { state: MediaPlayerState.IDLE } },
    });
    const secondKey = await add(home.core, second);
    const capability = "media-media_player";

    await home.core.until(
      () => home.core.latest(secondKey, capability)?.activity === "idle",
      "second speaker idle",
    );
    first.setState(201, { state: MediaPlayerState.PLAYING });
    await home.core.until(
      () => home.core.latest(firstKey, capability)?.activity === "playing",
      "first speaker playing",
    );
    second.setState(201, { state: MediaPlayerState.ANNOUNCING, volume: 0.55 });
    await home.core.until(
      () => home.core.latest(secondKey, capability)?.volume === 55,
      "second speaker announcing",
    );
    expect(home.core.latest(secondKey, capability)?.activity).toBe("idle");
  });

  it("is a media player, and nobody follows its requests, when it has no voice assistant", async () => {
    home = await startHome();
    const device = await home.plugIn({
      name: "player",
      entities: [{ ...player, fields: { supportsPause: true } }],
      states: { 201: { state: MediaPlayerState.IDLE } },
    });
    const key = await add(home.core, device);
    const capability = "media-media_player";

    const registered = home.core.registered.get(key);
    expect(registered?.type).toBe("media-player");
    expect(registered?.capabilities[0]?.features).toMatchObject({
      playback: ["play", "pause", "stop"],
    });
    await home.core.until(
      () => home.core.latest(key, capability) !== undefined,
      "its state",
    );
    await home.core.command(key, capability, "media", { volume: 25 });
    await home.core.until(
      () => home.core.latest(key, capability)?.volume === 25,
      "its volume changed",
    );
    expect(device.voiceFollowed).toBe(false);
  });

  it("offers power and stop for a player that advertises neither play nor pause", async () => {
    home = await startHome();
    const device = await home.plugIn({
      name: "player",
      entities: [
        {
          ...player,
          fields: {
            featureFlags: (1 << 2) | (1 << 3) | (1 << 7) | (1 << 8) | (1 << 12),
          },
        },
      ],
      states: { 201: { state: MediaPlayerState.NONE } },
    });
    const key = await add(home.core, device);
    const capability = "media-media_player";

    expect(
      home.core.registered.get(key)?.capabilities[0]?.features,
    ).toMatchObject({
      power: true,
      playback: ["stop"],
    });
    await home.core.until(
      () => home.core.latest(key, capability) !== undefined,
      "its state",
    );
    expect(home.core.latest(key, capability)).toEqual({
      activity: "idle",
      volume: 0,
      muted: false,
    });

    await home.core.command(key, capability, "media", { on: true });
    await home.core.until(
      () => home.core.latest(key, capability)?.on === true,
      "on",
    );
    await home.core.command(key, capability, "media", { on: false });
    await home.core.until(
      () => home.core.latest(key, capability)?.on === false,
      "off",
    );
  });
});
