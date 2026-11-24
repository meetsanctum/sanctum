import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createDriverCore } from "@meetsanctum/app-testkit";

import { seedRooms } from "../home.js";
import app from "../index.js";

// What it brings, as a core takes it: each device as what it is, so the core
// refuses none of them.

let core;

beforeEach(async () => {
  core = createDriverCore(app);
  await core.start();
});

afterEach(async () => {
  await core.stop();
  core.close();
});

const typeOf = (key) => core.registered.get(key)?.type;

test("brings its lights, plugs and sensors as what they are", () => {
  assert.equal(typeOf("floor"), "light");
  assert.equal(typeOf("coffee"), "plug");
  assert.equal(typeOf("balcony-door"), "contact");
  assert.equal(typeOf("hallway-motion"), "motion");
  assert.equal(typeOf("office-climate"), "sensor");
  assert.deepEqual(core.refused, []);
});

test("brings every device the seed puts in a room, and no other", () => {
  const seeded = Object.values(seedRooms).flat().sort();
  const brought = [...core.registered.values()]
    .map((device) => device.name)
    .sort();
  assert.equal(seeded.length, 60);
  assert.equal(Object.keys(seedRooms).length, 9);
  assert.deepEqual(brought, seeded);
});

test("reports only changed contact, motion and climate readings after startup", async (t) => {
  await core.stop();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  await core.start();
  const keys = ["balcony-door", "living-motion", "living-climate"];
  const from = core.reports.length;

  t.mock.timers.tick(5_000);
  assert.deepEqual(
    core.reports.slice(from).filter(({ key }) => keys.includes(key)),
    [],
  );

  for (let elapsed = 5_000; elapsed < 90_000; elapsed += 5_000) {
    t.mock.timers.tick(5_000);
    await Promise.resolve();
  }
  assert.deepEqual(core.latest("balcony-door", "contact"), { open: false });
  assert.deepEqual(core.latest("living-motion", "occupancy"), {
    motion: false,
  });
  assert.deepEqual(core.latest("living-climate", "temperature"), {
    value: 21.8,
  });
  assert.deepEqual(core.latest("living-climate", "humidity"), { value: 44 });
});

test("turns a plug on and off", async () => {
  await core.command("coffee", "power", "switch", { on: true });
  assert.deepEqual(core.latest("coffee", "power"), { on: true });
  await core.command("coffee", "power", "switch", { on: false });
  assert.deepEqual(core.latest("coffee", "power"), { on: false });
});

test("reports a new episode when the TV box skips forwards or backwards", async () => {
  assert.equal(typeOf("tv-box"), "media-player");
  const { episode, artwork } = core.latest("tv-box", "player").media;
  assert.equal(core.blobs.get(artwork)?.type, "image/png");
  await core.command("tv-box", "player", "media", { playback: "next" });
  assert.equal(core.latest("tv-box", "player").media.episode, episode + 1);
  assert.equal(core.latest("tv-box", "player").media.position, 0);
  assert.notEqual(core.latest("tv-box", "player").media.artwork, artwork);
  await core.command("tv-box", "player", "media", { playback: "previous" });
  assert.equal(core.latest("tv-box", "player").media.episode, episode);
  assert.equal(core.latest("tv-box", "player").media.artwork, artwork);
});

test("reports a fifth episode without the picture the core refuses", async () => {
  const { episode } = core.latest("tv-box", "player").media;
  assert.equal(episode % 5, 4);
  await core.command("tv-box", "player", "media", { playback: "next" });
  const { media } = core.latest("tv-box", "player");
  assert.equal(media.episode, episode + 1);
  assert.equal(media.artwork, undefined);
  await core.command("tv-box", "player", "media", { playback: "previous" });
});

test("drops a saved artwork hash if a fresh core can't keep the picture", async () => {
  assert.ok(core.latest("tv-box", "player").media.artwork);
  await core.stop();
  core.close();
  core = createDriverCore(app, { unanswered: ["putBlob"] });
  await core.start();
  assert.equal(core.latest("tv-box", "player").media.artwork, undefined);
});

test("reports the next episode when the actor cannot upload artwork", async () => {
  const { episode } = core.latest("tv-box", "player").media;
  const reports = [];
  await app.driver.command(
    {
      actor: { kind: "assistant-run", id: "agent", onBehalfOf: "resident" },
      devices: { report: async (report) => reports.push(report) },
      blobs: { put: async () => assert.fail("an agent cannot put artwork") },
    },
    {
      key: "tv-box",
      kind: "media",
      command: { playback: "next" },
    },
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].states.player.media.episode, episode + 1);
  assert.equal(reports[0].states.player.media.artwork, undefined);
});

test("a slow artwork upload cannot report an episode that was skipped", async () => {
  const reports = [];
  const slow = Promise.withResolvers();
  const command = {
    key: "tv-box",
    kind: "media",
    command: { playback: "next" },
  };
  const context = {
    actor: { kind: "user", id: "resident" },
    devices: { report: async (report) => reports.push(report) },
    blobs: { put: () => slow.promise },
  };
  const first = app.driver.command(context, command);
  const next = "a".repeat(64);
  await app.driver.command(
    { ...context, blobs: { put: async () => ({ hash: next }) } },
    command,
  );
  slow.resolve({ hash: "b".repeat(64) });
  await first;
  assert.deepEqual(
    reports.map(({ states }) => states.player.media.artwork),
    [next],
  );
});

test("lists what it found as what each is", () => {
  assert.deepEqual(
    core.found.map(({ key, type }) => [key, type]),
    [
      ["office-air", "sensor"],
      ["desk-plug", "plug"],
    ],
  );
});

test("adds a climate sensor with its readings, and a plug that turns on and off", async () => {
  await core.add("office-air");
  assert.equal(typeOf("office-air"), "sensor");
  assert.deepEqual(
    core.registered.get("office-air").capabilities.map(({ id }) => id),
    ["temperature", "humidity"],
  );
  assert.deepEqual(core.latest("office-air", "temperature"), { value: 22.5 });

  assert.deepEqual(await core.add("desk-plug", { key: "nope" }), {
    refused: { question: "key", refusal: "wrongKey" },
  });
  await core.add("desk-plug", { key: "sanctum" });
  assert.equal(typeOf("desk-plug"), "plug");
  await core.command("desk-plug", "power", "switch", { on: true });
  assert.deepEqual(core.latest("desk-plug", "power"), { on: true });
  await core.command("desk-plug", "power", "switch", { on: false });
  assert.deepEqual(core.latest("desk-plug", "power"), { on: false });

  assert.deepEqual(core.found, []);
  assert.deepEqual(core.refused, []);
});

test("starts with previously added devices even when their stored type is outdated", async () => {
  await core.add("office-air");
  await core.add("desk-plug", { key: "sanctum" });
  await core.stop();

  // The saved registration can predate the plug's switch capability.
  core.registered.set("desk-plug", {
    ...core.registered.get("desk-plug"),
    type: "contact",
    capabilities: [{ id: "contact", kind: "contact", features: {} }],
  });
  await core.start();

  assert.equal(typeOf("desk-plug"), "plug");
  for (const key of ["office-air", "desk-plug"]) {
    assert.ok(core.presented.at(-1).includes(key));
    assert.equal(
      core.devices().find((device) => device.key === key).availability,
      "online",
    );
  }
  assert.deepEqual(core.found, []);
  await core.command("desk-plug", "power", "switch", { on: true });
  assert.deepEqual(core.latest("desk-plug", "power"), { on: true });
});
