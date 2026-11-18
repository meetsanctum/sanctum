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
