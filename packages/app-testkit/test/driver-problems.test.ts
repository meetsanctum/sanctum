import {
  defineApp,
  type AppContext,
  type DriverRepairResult,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createDriverCore } from "../src/index.js";

// The suite's driver core keeps what a driver says is wrong with its devices
// as the core does, and hands it Repair's answers.

function setup(refusal = "wrongKey") {
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
        await ctx.devices.register({
          key: "plug",
          name: "Plug",
          manufacturer: null,
          model: null,
          capabilities: [],
        });
      },
      driver: {
        async command() {},
        problems: {
          keyMismatch: {
            words: "Its key doesn't match",
            repair: { asks: ["key"] },
          },
        },
        questions: {
          key: {
            label: "Key",
            kind: "secret",
            refusals: { wrongKey: "That key doesn't match." },
          },
        },
        async repair(ctx, { key, answers }): Promise<DriverRepairResult> {
          if (answers.key !== "right") {
            return { refused: { question: "key", refusal } };
          }
          await ctx.devices.problem({ key, problem: null });
        },
      },
    }),
  );
  return { core, context: () => context };
}

describe("the suite's device problems", () => {
  it("keeps a declared problem and repairs it with the right answer", async () => {
    const { core, context } = setup();
    await core.start();
    await context().devices.problem({ key: "plug", problem: "keyMismatch" });
    expect(core.problems.get("plug")?.words).toBe("Its key doesn't match");

    expect(await core.repair("plug", { key: "wrong" })).toEqual({
      refused: { question: "key", refusal: "wrongKey" },
    });
    expect(await core.repair("plug", { key: "right" })).toBeUndefined();
    expect(core.problems.has("plug")).toBe(false);
    expect(core.refused).toEqual([]);
  });

  it("refuses a problem the driver doesn't declare, and a refusal it doesn't", async () => {
    const { core, context } = setup("tooShort");
    await core.start();

    await expect(
      context().devices.problem({ key: "plug", problem: "unheardOf" }),
    ).rejects.toThrow("declares no problem unheardOf");
    await context().devices.problem({ key: "plug", problem: "keyMismatch" });
    await expect(core.repair("plug", { key: "wrong" })).rejects.toThrow(
      "words it doesn't declare",
    );
    expect(core.refused).toHaveLength(2);
  });
});
