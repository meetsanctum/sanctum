import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import app from "../index.js";

let context;
let reports;

beforeEach(async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  reports = [];
  context = {
    devices: {
      list: async () => [],
      register: async ({ key }) => ({ id: key }),
      report: async (report) => reports.push(structuredClone(report)),
      present: async () => {},
      found: async () => {},
    },
    blobs: { put: async () => ({ hash: "0".repeat(64) }) },
  };
  await app.start(context);
  t.after(() => app.stop());
  await app.driver.command(context, {
    key: "floor",
    command: { on: false, brightness: 100 },
  });
  reports.length = 0;
});

const floorReports = () => reports.filter(({ key }) => key === "floor");

test("reports a blink after its request context has ended", async (t) => {
  let isOpen = true;
  let lateReports = 0;
  const request = {
    devices: {
      async report(report) {
        if (!isOpen) {
          lateReports += 1;
          throw new Error("This request has ended");
        }
        await context.devices.report(report);
      },
    },
  };
  await app.driver.identify(request, { key: "floor" });
  isOpen = false;

  t.mock.timers.tick(2_000);

  assert.equal(lateReports, 0);
  assert.ok(floorReports().some(({ states }) => states.light.on));
  assert.equal(floorReports().at(-1).states.light.on, false);
});

test("a command during a blink keeps its state", async (t) => {
  await app.driver.identify(context, { key: "floor" });
  t.mock.timers.tick(100);
  await app.driver.command(context, {
    key: "floor",
    command: { on: true, brightness: 17 },
  });

  t.mock.timers.tick(2_000);

  assert.equal(floorReports().at(-1).states.light.on, true);
  assert.equal(floorReports().at(-1).states.light.brightness, 17);
});

test("stopping cancels a blink and keeps the state for its next start", async (t) => {
  await app.driver.identify(context, { key: "floor" });
  t.mock.timers.tick(100);
  await app.stop();
  reports.length = 0;

  t.mock.timers.tick(2_000);
  assert.equal(reports.length, 0);

  await app.start(context);
  assert.equal(floorReports().at(-1).states.light.on, false);
});

test("another blink restores the original state", async (t) => {
  await app.driver.identify(context, { key: "floor" });
  t.mock.timers.tick(100);
  await app.driver.identify(context, { key: "floor" });

  t.mock.timers.tick(2_000);

  assert.equal(floorReports().at(-1).states.light.on, false);
});
