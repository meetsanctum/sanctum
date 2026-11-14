import {
  defineApp,
  type AppContext,
  type DriverAddResult,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createDriverCore } from "../src/index.js";

// The suite's driver core keeps the devices a driver says it found as the
// core shows them, and hands it Add's answers.

function setup(options: { refusal?: string; registers?: boolean } = {}) {
  const { refusal = "wrongKey", registers = true } = options;
  let context!: AppContext;
  const core = createDriverCore(
    defineApp({
      id: "sanctum.example",
      name: "Example",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [{ id: "devices.register", reason: "For the test." }],
      actions: [],
      events: [],
      async start(ctx) {
        context = ctx;
      },
      driver: {
        async command() {},
        questions: {
          key: {
            label: "Key",
            kind: "secret",
            refusals: { wrongKey: "That key doesn't match." },
          },
        },
        async add(ctx, { key, answers }): Promise<DriverAddResult> {
          if (key === "plug" && answers.key !== "right") {
            return { refused: { question: "key", refusal } };
          }
          if (!registers) return;
          await ctx.devices.register({
            key,
            name: key,
            manufacturer: null,
            model: null,
            capabilities: [],
          });
        },
      },
    }),
  );
  return { core, context: () => context };
}

describe("the suite's found devices", () => {
  it("lists them with what adding each asks, and adds one with the right answer", async () => {
    const { core, context } = setup();
    await core.start();
    await context().devices.found([
      { key: "sensor", name: "Sensor" },
      { key: "plug", name: "Plug", asks: ["key"] },
    ]);
    expect(core.found.map((each) => [each.key, each.asks.length])).toEqual([
      ["sensor", 0],
      ["plug", 1],
    ]);

    expect(await core.add("sensor")).toBeUndefined();
    expect(await core.add("plug", { key: "wrong" })).toEqual({
      refused: { question: "key", refusal: "wrongKey" },
    });
    expect(await core.add("plug", { key: "right" })).toBeUndefined();
    expect(core.found).toEqual([]);
    expect(core.registered.has("plug")).toBe(true);
    expect(core.refused).toEqual([]);
  });

  it("refuses what the driver doesn't declare, and an add that registers nothing", async () => {
    const { core, context } = setup({ refusal: "tooShort" });
    await core.start();

    await expect(
      context().devices.found([{ key: "plug", name: "Plug", asks: ["pin"] }]),
    ).rejects.toThrow(/doesn't declare/);
    await context().devices.found([
      { key: "plug", name: "Plug", asks: ["key"] },
    ]);
    await expect(core.add("plug", { key: "wrong" })).rejects.toThrow(
      /doesn't declare/,
    );

    const careless = setup({ registers: false });
    await careless.core.start();
    await careless.context().devices.found([{ key: "sensor", name: "Sensor" }]);
    await expect(careless.core.add("sensor")).rejects.toThrow(
      /without registering it/,
    );
  });
});
