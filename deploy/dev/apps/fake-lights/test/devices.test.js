import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createDriverCore } from "@meetsanctum/app-testkit";

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

test("brings its lights and contact sensors as what they are", () => {
  assert.equal(typeOf("floor"), "light");
  assert.equal(typeOf("balcony-door"), "contact");
  assert.deepEqual(core.refused, []);
});

test("reports a new episode when the TV box skips forwards or backwards", async () => {
  assert.equal(typeOf("tv-box"), "media-player");
  const episode = core.latest("tv-box", "player").media.episode;
  await core.command("tv-box", "player", "media", { playback: "next" });
  assert.equal(core.latest("tv-box", "player").media.episode, episode + 1);
  assert.equal(core.latest("tv-box", "player").media.position, 0);
  await core.command("tv-box", "player", "media", { playback: "previous" });
  assert.equal(core.latest("tv-box", "player").media.episode, episode);
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
