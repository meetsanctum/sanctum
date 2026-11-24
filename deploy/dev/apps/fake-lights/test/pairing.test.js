import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createDriverCore } from "@meetsanctum/app-testkit";

import app from "../index.js";
import { createPairing, secondCodeMs } from "../pairing.js";

// The TV box that asks two codes once adding starts, and Repair that pairs it
// again once a later run has lost its pairing.

let core;

beforeEach(async () => {
  core = createDriverCore(app);
  await core.start();
});

afterEach(async () => {
  await core.stop();
  core.close();
});

test("adds the TV box with two codes, a wrong first one showing a new one", async () => {
  const adding = await core.startAdd("den-tv");
  assert.deepEqual(
    adding.asks.map(({ id, kind, length }) => [id, kind, length]),
    [["firstCode", "code", 4]],
  );

  await adding.answer({ firstCode: "0000" });
  assert.deepEqual(adding.state.refused, {
    question: "firstCode",
    refusal: "wrongCode",
  });
  await adding.answer({ firstCode: "1234" });
  assert.equal(adding.asks[0].lasts.seconds, 35);
  await adding.answer({ secondCode: "5678" });

  assert.deepEqual(adding.state, { kind: "done" });
  assert.equal(core.registered.get("den-tv").type, "media-player");
  await core.command("den-tv", "player", "media", { on: true });
  assert.equal(core.latest("den-tv", "player").on, true);
  assert.deepEqual(core.refused, []);
});

test("closes the pairing it opened as adding is cancelled", async () => {
  const adding = await core.startAdd("den-tv");
  await adding.cancel();

  const again = await core.startAdd("den-tv");
  assert.deepEqual(
    again.asks.map(({ id }) => id),
    ["firstCode"],
  );
});

test("starts a later run with the TV box's pairing lost, which Repair sets right", async () => {
  const adding = await core.startAdd("den-tv");
  await adding.answer({ firstCode: "1234" });
  await adding.answer({ secondCode: "5678" });
  await core.stop();
  await core.start();

  assert.equal(core.problems.get("den-tv")?.id, "pairingLost");
  const repairing = await core.startRepair("den-tv");
  await repairing.answer({ firstCode: "1234" });
  await repairing.answer({ secondCode: "5678" });

  assert.deepEqual(repairing.state, { kind: "done" });
  assert.equal(core.problems.has("den-tv"), false);
});

test("pairs once both codes match, a second code only while it lasts", () => {
  let now = 0;
  const pairing = createPairing({ now: () => now });
  const step = (answers, attempt = "a", again) =>
    pairing.step("tv", { answers, attempt, again });

  assert.deepEqual(step({}), { asks: ["firstCode"] });
  assert.deepEqual(step({ firstCode: "1234" }), { asks: ["secondCode"] });
  now += secondCodeMs + 1;
  assert.deepEqual(step({ secondCode: "5678" }), {
    refused: { question: "secondCode", refusal: "wrongCode" },
  });
  assert.equal(pairing.isOpen("tv"), false);

  step({});
  step({ firstCode: "1234" });
  now += secondCodeMs + 1;
  assert.deepEqual(step({}, "a", "secondCode"), { asks: ["secondCode"] });
  assert.equal(step({ secondCode: "5678" }), "paired");

  // A new attempt drops the one before, and Cancel closes its own only.
  step({}, "b");
  pairing.cancel("tv", "a");
  assert.equal(pairing.isOpen("tv"), true);
  pairing.cancel("tv", "b");
  assert.equal(pairing.isOpen("tv"), false);
});
