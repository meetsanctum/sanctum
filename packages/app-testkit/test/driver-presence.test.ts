import { defineApp, type AppContext } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { createDriverCore } from "../src/index.js";

// Availability in the suite's core follows a device as the core's does: it
// starts unknown, the driver's reports and what it says it still has change
// it, and a removed device is forgotten.

async function setup() {
  let context!: AppContext;
  const remove = vi.fn(async () => {});
  const core = createDriverCore(
    defineApp({
      id: "test.presence",
      name: "Presence",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [{ id: "devices.register", reason: "For the test." }],
      actions: [],
      events: [],
      async start(ctx) {
        context = ctx;
      },
      driver: { command: async () => {}, remove },
    }),
  );
  await core.start();
  const register = () =>
    context.devices.register({
      key: "lamp",
      name: "Lamp",
      capabilities: [{ id: "light", kind: "light" }],
    });
  await register();
  return { core, context, register, remove };
}

describe("the suite's device availability", () => {
  it("starts unknown and preserves availability across registration and presence", async () => {
    const { core, context, register } = await setup();
    expect(core.availability.get("lamp")).toBe("unknown");
    await context.devices.report({ key: "lamp", availability: "online" });
    await register();
    await context.devices.present({ keys: ["lamp", "not-registered"] });
    expect([...core.availability]).toEqual([["lamp", "online"]]);
    await context.devices.present({ keys: [] });
    expect(core.availability.get("lamp")).toBe("offline");
    await register();
    await context.devices.present({ keys: ["lamp"] });
    expect(core.availability.get("lamp")).toBe("offline");
  });

  it("forgets a removed device so later presence cannot bring it back offline", async () => {
    const { core, context, register } = await setup();
    await context.devices.report({ key: "lamp", availability: "online" });
    await core.remove("lamp");
    await context.devices.present({ keys: [] });
    expect(core.registered.has("lamp")).toBe(false);
    expect(core.availability.has("lamp")).toBe(false);
    await register();
    expect(core.availability.get("lamp")).toBe("unknown");
  });

  it("does not mark a device offline while it is being removed", async () => {
    const { core, context, remove } = await setup();
    await context.devices.report({ key: "lamp", availability: "online" });
    const during: (string | undefined)[] = [];
    remove.mockImplementationOnce(async () => {
      await context.devices.present({ keys: [] });
      during.push(core.availability.get("lamp"));
    });

    await core.remove("lamp");

    expect(during).toEqual(["online"]);
    expect(core.availability.has("lamp")).toBe(false);
  });

  it("keeps a device when its driver refuses removal", async () => {
    const { core, context, remove } = await setup();
    await context.devices.report({ key: "lamp", availability: "online" });
    remove.mockRejectedValueOnce(new Error("Device did not answer"));
    await expect(core.remove("lamp")).rejects.toThrow("Device did not answer");
    expect(core.registered.has("lamp")).toBe(true);
    expect(core.availability.get("lamp")).toBe("online");
  });
});
