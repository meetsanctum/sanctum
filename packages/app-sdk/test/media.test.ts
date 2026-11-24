import { describe, expect, it } from "vitest";

import {
  capabilityRegistration,
  controlPermission,
  deviceCategoryOf,
  deviceTypeOf,
  fitsType,
  historyFields,
  media,
  permissionWords,
  readPermission,
  type MediaCommand,
  type MediaFeatures,
} from "../src/index.js";

// A media player: a TV box with power and every step of playback, and a
// smart speaker that only plays, pauses and stops, with its volume as a
// level and mute.
const tvBox = media.features.parse({
  power: true,
  playback: ["play", "pause", "stop", "next", "previous", "seek"],
  volume: "steps",
});
const smartSpeaker = media.features.parse({
  playback: ["play", "pause", "stop"],
  volume: "level",
  mute: true,
});

describe("a media player's features", () => {
  it("say nothing it can do unless its driver says so", () => {
    expect(media.features.parse({})).toEqual({
      power: false,
      playback: [],
      volume: null,
      mute: false,
    });
  });

  it("name each step of playback once", () => {
    expect(
      media.features.safeParse({ playback: ["play", "play"] }).success,
    ).toBe(false);
    expect(media.features.safeParse({ playback: ["rewind"] }).success).toBe(
      false,
    );
  });
});

describe("a media player's state", () => {
  it("needs only what it is doing, as a smart speaker that plays nothing", () => {
    expect(media.state.safeParse({ activity: "idle" }).success).toBe(true);
  });

  it("holds what is playing, where it is, and how loud", () => {
    const state = {
      on: true,
      activity: "playing",
      app: { id: "com.apple.TVWatchList", name: "Apple TV" },
      media: {
        title: "Slow Horses",
        series: "Slow Horses",
        season: 4,
        episode: 2,
        type: "episode",
        duration: 2700,
        position: 1032,
        positionAt: "2026-11-22T20:15:00.000Z",
        artwork: "a".repeat(64),
      },
      volume: 30,
      muted: false,
    };
    expect(media.state.parse(state)).toEqual(state);
  });

  it("refuses what the kind doesn't have", () => {
    expect(
      media.state.safeParse({ activity: "idle", shuffle: true }).success,
    ).toBe(false);
    expect(
      media.state.safeParse({ activity: "idle", media: { lyrics: "…" } })
        .success,
    ).toBe(false);
    expect(media.state.safeParse({ activity: "seeking" }).success).toBe(false);
    expect(
      media.state.safeParse({
        activity: "playing",
        media: { artwork: "not-a-hash" },
      }).success,
    ).toBe(false);
  });
});

describe("a media player's commands", () => {
  it("ask one thing at a time", () => {
    expect(media.command.safeParse({ on: true }).success).toBe(true);
    expect(media.command.safeParse({ on: true, volume: 20 }).success).toBe(
      false,
    );
    expect(media.command.safeParse({}).success).toBe(false);
    expect(media.command.safeParse({ playback: "play" }).success).toBe(false);
  });

  it("ask for state where its report can confirm it, and for none otherwise", () => {
    const asked = (command: MediaCommand) => media.desired(command);
    expect(asked({ on: false })).toEqual({ on: false });
    expect(asked({ activity: "paused" })).toEqual({ activity: "paused" });
    expect(asked({ volume: 40 })).toEqual({ volume: 40 });
    expect(asked({ muted: true })).toEqual({ muted: true });
    expect(asked({ volumeStep: "up" })).toEqual({});
    expect(asked({ playback: "next" })).toEqual({});
    expect(asked({ position: 60 })).toEqual({});
  });

  it("go only where the player can carry them out", () => {
    const can = (features: MediaFeatures, command: MediaCommand) =>
      media.supports(features, command);
    // A TV box turns on and off, and steps its volume.
    expect(can(tvBox, { on: true })).toBe(true);
    expect(can(tvBox, { playback: "next" })).toBe(true);
    expect(can(tvBox, { position: 30 })).toBe(true);
    expect(can(tvBox, { volumeStep: "down" })).toBe(true);
    expect(can(tvBox, { volume: 40 })).toBe(false);
    expect(can(tvBox, { muted: true })).toBe(false);
    // A smart speaker has no power, previous, next or seek; a step works on
    // its level too.
    expect(can(smartSpeaker, { on: true })).toBe(false);
    expect(can(smartSpeaker, { activity: "playing" })).toBe(true);
    expect(can(smartSpeaker, { playback: "stop" })).toBe(true);
    expect(can(smartSpeaker, { playback: "previous" })).toBe(false);
    expect(can(smartSpeaker, { position: 0 })).toBe(false);
    expect(can(smartSpeaker, { volume: 40 })).toBe(true);
    expect(can(smartSpeaker, { volumeStep: "up" })).toBe(true);
    expect(can(smartSpeaker, { muted: true })).toBe(true);
    // One with no volume takes neither.
    const silent = media.features.parse({ playback: ["play"] });
    expect(can(silent, { volumeStep: "up" })).toBe(false);
  });
});

describe("where a media player is", () => {
  it("registers with its features, and none means none", () => {
    expect(
      capabilityRegistration.parse({ id: "player", kind: "media" }),
    ).toEqual({
      id: "player",
      kind: "media",
      features: media.features.parse({}),
    });
  });

  it("gives each registration its own default playback list", () => {
    const register = () =>
      capabilityRegistration.parse({ id: "player", kind: "media" });
    const first = register();
    const second = register();
    if (first.kind !== "media" || second.kind !== "media") {
      throw new Error("Expected media capabilities");
    }
    expect(first.features.playback).not.toBe(second.features.playback);
  });

  it("is a media player, or a smart speaker with microphones", () => {
    expect(deviceTypeOf(["media"])).toBe("media-player");
    expect(deviceTypeOf(["media", "sensor"])).toBe("media-player");
    expect(deviceTypeOf(["media", "audio"])).toBe("smart-speaker");
    expect(fitsType("smart-speaker", new Set(["media", "audio"]))).toBe(true);
    expect(fitsType("smart-speaker", new Set(["media"]))).toBe(false);
    expect(fitsType("smart-speaker", new Set(["sensor"]))).toBe(false);
  });

  it("shows under Media, keeps whether it played and was on, and has its own permissions", () => {
    expect(deviceCategoryOf("media")?.id).toBe("media");
    expect(historyFields.media).toEqual(["playing", "on"]);
    expect(permissionWords(readPermission("media"))?.title).toBe(
      "See your media players",
    );
    expect(permissionWords(controlPermission("media"))?.title).toBe(
      "Control your media players",
    );
  });
});
