import { defineApp, type AppContext } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createDriverCore } from "../src/index.js";

// A driver reads its own devices from the suite's core as from the core's:
// whole, with the keys it registered them by and what it last said of
// their battery, whatever it said after.

describe("the suite's driver devices", () => {
  it("are read whole, with their keys and the battery last said", async () => {
    let context!: AppContext;
    const core = createDriverCore(
      defineApp({
        id: "test.devices",
        name: "Devices",
        version: "0.1.0",
        core: "^1.0.0",
        permissions: [{ id: "devices.register", reason: "For the test." }],
        actions: [],
        events: [],
        async start(ctx) {
          context = ctx;
        },
        driver: { command: async () => {} },
      }),
    );
    await core.start();
    await context.devices.register({
      key: "remote",
      name: "Remote",
      capabilities: [{ id: "light", kind: "light" }],
    });

    await context.devices.report({
      key: "remote",
      battery: 0,
      batteryLow: true,
    });
    await context.devices.report({
      key: "remote",
      states: { light: { on: true } },
    });

    expect(await context.devices.list()).toMatchObject([
      {
        id: "device:remote",
        key: "remote",
        battery: 0,
        batteryLow: true,
        shownAs: null,
        capabilities: [{ id: "light", state: { on: true } }],
      },
    ]);
  });
});
