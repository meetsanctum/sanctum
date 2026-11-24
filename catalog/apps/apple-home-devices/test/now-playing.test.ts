import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Picture } from "../src/boxes.js";
import type { FakeBox } from "./fake-boxes.js";
import { added, gym, home, livingRoom, stateOf, timings } from "./homes.js";

// What an added Apple TV plays, its picture and playback, through its
// player connection, against fake boxes.

const appleEpochMs = Date.UTC(2001, 0, 1);

/** A JPEG's header, 600 × 338, told apart by its last byte. */
function jpeg(mark: number): Picture {
  const data = Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x01,
    0x52,
    0x02,
    0x58,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
    mark,
  ]);
  return { type: "image/jpeg", data };
}

const hashOf = (picture: Picture) =>
  createHash("sha256").update(picture.data).digest("hex");

const film = {
  app: { id: "com.apple.TVWatchList", name: "TV" },
  title: "Comeback: Season 2",
  kind: "video" as const,
  duration: 135,
  position: 59.8,
  positionAt: appleEpochMs + 817_214_933_605,
  artwork: true,
};

async function playing(box: FakeBox) {
  const made = await home(box);
  await added(made.core, box);
  await made.core.until(() => box.players.length === 1, "player open");
  return made;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("what plays", () => {
  it("reports the item, its app and where it is", async () => {
    const box = livingRoom();
    box.picture = jpeg(1);
    const { core } = await playing(box);
    box.play(film);
    await core.until(
      () => stateOf(core, box)?.media?.title !== undefined,
      "said",
    );
    expect(stateOf(core, box)).toEqual({
      on: true,
      activity: "playing",
      app: { id: "com.apple.TVWatchList", name: "TV" },
      media: {
        title: "Comeback: Season 2",
        type: "video",
        duration: 135,
        position: 59.8,
        positionAt: new Date(film.positionAt).toISOString(),
        artwork: hashOf(box.picture),
      },
    });
    expect(core.blobs.has(hashOf(box.picture))).toBe(true);
  });

  it("tells music and episodes, and leaves out words past the limits", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({
      app: { id: "com.apple.Music", name: "Music" },
      title: "x".repeat(300),
      artist: "  ",
      kind: "music",
      season: 2.5,
    });
    await core.until(() => stateOf(core, box)?.media !== undefined, "music");
    expect(stateOf(core, box)?.media).toEqual({
      title: "x".repeat(256),
      type: "music",
    });
    box.play({
      app: { id: "com.apple.TVWatchList", name: "TV" },
      title: "Pilot",
      series: "Severance",
      season: 1,
      episode: 1,
      kind: "video",
    });
    await core.until(
      () => stateOf(core, box)?.media?.type === "episode",
      "episode",
    );
    expect(stateOf(core, box)?.media).toMatchObject({
      series: "Severance",
      season: 1,
      episode: 1,
    });
  });

  it("says an app that plays without words, as Netflix does", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({ app: { id: "com.netflix.Netflix", name: "Netflix" } });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    expect(stateOf(core, box)).toEqual({
      on: true,
      activity: "playing",
      app: { id: "com.netflix.Netflix", name: "Netflix" },
      media: null,
    });
  });

  it("takes stopped as idle and keeps a seek's activity", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({ ...film, artwork: false });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    box.play({ ...film, artwork: false, state: "seeking" });
    await wait(30);
    expect(stateOf(core, box)?.activity).toBe("playing");
    box.play({ ...film, artwork: false, state: "stopped" });
    await core.until(() => stateOf(core, box)?.activity === "idle", "idle");
    expect(stateOf(core, box)).toMatchObject({ app: null, media: null });
  });
});

describe("pictures", () => {
  it("waits a little for a new item's picture, and fetches it once", async () => {
    const box = livingRoom();
    box.picture = jpeg(2);
    let release!: () => void;
    box.pictureHold = new Promise((resolve) => (release = resolve));
    const { core } = await playing(box);
    const from = core.reports.length;
    box.play(film);
    await wait(timings.pictureWaitMs / 2);
    // Nothing yet: it waits for the picture.
    expect(core.reports.slice(from).some((r) => r.states.media)).toBe(false);
    release();
    await core.until(
      () => stateOf(core, box)?.media?.artwork === hashOf(box.picture!),
      "with its picture",
    );
    const said = core.reports
      .slice(from)
      .filter((report) => report.states.media);
    expect(said[0]?.states.media).toMatchObject({
      media: { artwork: hashOf(box.picture) },
    });
    box.play({ ...film, state: "paused" });
    await core.until(() => stateOf(core, box)?.activity === "paused", "paused");
    expect(box.pictures).toBe(1);
  });

  it("goes without a picture where the item has none", async () => {
    const box = livingRoom();
    box.picture = jpeg(3);
    const { core } = await playing(box);
    box.play({ ...film, artwork: false });
    await core.until(() => stateOf(core, box)?.media !== undefined, "said");
    expect(stateOf(core, box)?.media?.artwork).toBeUndefined();
    expect(box.pictures).toBe(0);
  });

  it("drops a picture that comes after the item changed", async () => {
    const box = livingRoom();
    box.picture = jpeg(4);
    let release!: () => void;
    box.pictureHold = new Promise((resolve) => (release = resolve));
    const { core } = await playing(box);
    box.play(film);
    await wait(5);
    box.play({ ...film, title: "Family: Season 1", artwork: false });
    release();
    await core.until(
      () => stateOf(core, box)?.media?.title === "Family: Season 1",
      "the next item",
    );
    await wait(30);
    expect(stateOf(core, box)?.media?.artwork).toBeUndefined();
    expect(core.blobs.size).toBe(0);
  });

  it("puts a picture again for an item that comes back", async () => {
    const box = livingRoom();
    box.picture = jpeg(5);
    const { core } = await playing(box);
    box.play(film);
    const hash = hashOf(box.picture);
    await core.until(() => stateOf(core, box)?.media?.artwork === hash, "A");
    box.play({ ...film, title: "Family: Season 1", artwork: false });
    await core.until(
      () => stateOf(core, box)?.media?.title === "Family: Season 1",
      "B",
    );
    // The core lets it go once nothing names it.
    core.blobs.delete(hash);
    box.play(film);
    await core.until(
      () => stateOf(core, box)?.media?.artwork === hash,
      "A again",
    );
    expect(core.blobs.has(hash)).toBe(true);
    expect(box.pictures).toBe(1);
  });
});

describe("playback", () => {
  it("sends playback, and nothing for play while it plays", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({ ...film, artwork: false });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    const send = (command: Record<string, unknown>) =>
      core.command(box.key, "media", "media", command as never);
    await send({ activity: "playing" });
    await send({ activity: "paused" });
    await send({ activity: "playing" });
    await send({ position: 30 });
    await send({ playback: "next" });
    await send({ playback: "previous" });
    await send({ playback: "stop" });
    expect(box.sent).toEqual([
      "pause",
      "play",
      "seek 30",
      "next",
      "previous",
      "stop",
    ]);
  });

  it("refuses what the playing app doesn't take now", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.takes.set("seek", "no");
    box.takes.set("next", "unknown");
    box.play({ app: { id: "com.netflix.Netflix", name: "Netflix" } });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    await expect(
      core.command(box.key, "media", "media", { position: 30 }),
    ).rejects.toMatchObject({ name: "ActionError", code: "conflict" });
    // Where it hasn't said, it's sent.
    await core.command(box.key, "media", "media", { playback: "next" });
    expect(box.sent).toEqual(["next"]);
  });
});

describe("sleep and wake", () => {
  it("rests the player while the TV sleeps and opens a new one on a wake", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({ ...film, artwork: false });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    await core.command(box.key, "media", "media", { on: false });
    await core.until(() => stateOf(core, box)?.on === false, "off");
    expect(stateOf(core, box)).toEqual({
      on: false,
      activity: "idle",
      app: null,
      media: null,
    });
    expect(box.players).toHaveLength(0);
    const opened = box.playersOpened;
    await core.command(box.key, "media", "media", { on: true });
    await core.until(() => box.players.length === 1, "a new player");
    expect(box.playersOpened).toBe(opened + 1);
  });

  it("opens the player once Companion says something plays", async () => {
    const box = gym();
    box.tellsPower = false;
    const { core } = await playing(box);
    box.setPower(false);
    await core.until(() => stateOf(core, box)?.on === false, "off");
    expect(box.players).toHaveLength(0);
    // Woken by its own remote, to a film.
    box.on = true;
    box.play({ ...film, artwork: false });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    expect(stateOf(core, box)?.on).toBe(true);
  });

  it("keeps a sleeping TV off while Companion still offers its paused item", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({ ...film, artwork: false, state: "paused" });
    await core.until(() => stateOf(core, box)?.activity === "paused", "paused");
    await core.command(box.key, "media", "media", { on: false });
    // tvOS keeps a paused item's controls on Companion while it sleeps.
    box.playing = { ...box.playing, state: "paused" };
    await core.stop();
    await core.start();
    await core.discovered({ found: box.sightings(), lost: [] });
    await core.until(() => stateOf(core, box)?.on === false, "off");
    await wait(timings.wakeMs * 2);
    expect(stateOf(core, box)?.on).toBe(false);
    expect(box.players).toHaveLength(0);
  });

  it("doesn't take the player's off in the seconds after a wake", async () => {
    const box = livingRoom();
    box.tellsPower = false;
    const { core } = await playing(box);
    await core.command(box.key, "media", "media", { on: false });
    await core.until(() => stateOf(core, box)?.on === false, "off");
    await core.command(box.key, "media", "media", { on: true });
    // The TV still says off as the player opens, as both TVs do.
    box.on = false;
    await core.until(() => box.players.length === 1, "player open");
    await wait(20);
    expect(stateOf(core, box)?.on).toBe(true);
    box.setPower(true);
  });
});

describe("drops and restarts", () => {
  it("holds what plays while the player is tried again", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({ ...film, artwork: false });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    const from = core.reports.length;
    box.playerReachable = false;
    box.endSessions();
    await wait(timings.holdMs / 2);
    expect(
      core.reports.slice(from).some((r) => r.states.media?.activity === "idle"),
    ).toBe(false);
    await core.until(() => stateOf(core, box)?.activity === "idle", "idle");
    box.playerReachable = true;
    await core.until(() => stateOf(core, box)?.activity === "playing", "back");
  });

  it("says nothing of what plays until the player has spoken after a restart", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.play({ ...film, artwork: false });
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    await core.stop();
    const from = core.reports.length;
    await core.start();
    await core.discovered({ found: box.sightings(), lost: [] });
    await core.until(() => box.players.length === 1, "player again");
    await core.until(() => stateOf(core, box)?.activity === "playing", "plays");
    expect(
      core.reports.slice(from).some((r) => r.states.media?.activity === "idle"),
    ).toBe(false);
  });

  it("gives a TV added without playback its playback words on start", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    const playback = () => {
      const media = core.devices()[0]?.capabilities[0];
      return media?.kind === "media" ? media.features.playback : undefined;
    };
    await core.stop();
    const device = core.devices()[0]!;
    const media = device.capabilities[0]!;
    if (media.kind === "media") media.features.playback = [];
    expect(playback()).toEqual([]);
    await core.start();
    await core.discovered({ found: box.sightings(), lost: [] });
    await core.until(() => playback()?.length === 6, "playback words");
  });

  it("says the pairing is lost where the TV no longer knows AirPlay's keys", async () => {
    const box = livingRoom();
    const { core } = await playing(box);
    box.known.get("airplay")!.clear();
    box.endSessions();
    await core.until(
      () => core.problems.get(box.key)?.id === "pairingLost",
      "pairing lost",
    );
  });
});
