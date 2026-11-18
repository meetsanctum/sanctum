import { defineApp, type CoreEvent } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { createDriverCore } from "../src/index.js";

// The suite's core hands each event to the handlers of the driver's
// current start, every one of them even when one fails.

const event: CoreEvent = {
  name: "permissions.changed",
  granted: [],
  before: [],
};

describe("the suite's driver event handlers", () => {
  it("delivers events only to the current start's handlers", async () => {
    const heard = vi.fn();
    const core = createDriverCore(
      defineApp({
        id: "sanctum.example",
        name: "Example",
        version: "0.1.0",
        core: "^2.0.0",
        permissions: [],
        actions: [],
        events: [],
        async start(ctx) {
          await ctx.events.on("permissions.changed", heard);
        },
      }),
    );
    await core.start();
    await core.deliver(event);
    expect(heard).toHaveBeenCalledTimes(1);

    await core.stop();
    await core.deliver(event);
    expect(heard).toHaveBeenCalledTimes(1);

    await core.start();
    await core.deliver(event);
    expect(heard).toHaveBeenCalledTimes(2);
    await core.stop();
  });

  it("runs the other handlers when one fails, then reports the first failure", async () => {
    const heard = vi.fn();
    const failure = new Error("The first handler failed");
    const core = createDriverCore(
      defineApp({
        id: "sanctum.example",
        name: "Example",
        version: "0.1.0",
        core: "^2.0.0",
        permissions: [],
        actions: [],
        events: [],
        async start(ctx) {
          await ctx.events.on("permissions.changed", async () => {
            throw failure;
          });
          await ctx.events.on("permissions.changed", heard);
        },
      }),
    );
    await core.start();

    await expect(core.deliver(event)).rejects.toBe(failure);
    expect(heard).toHaveBeenCalledOnce();
    await core.stop();
  });
});
