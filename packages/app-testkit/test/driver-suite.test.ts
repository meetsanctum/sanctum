import {
  ActionError,
  defineApp,
  type AppContext,
  type CapabilityKind,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createDriverCore, describeDriver } from "../src/index.js";

// The smallest driver that meets the contract: its devices live in memory
// and answer at once.

type Thing = { kind: CapabilityKind; state: Record<string, unknown> };
const things = new Map<string, Thing>();
let ctx: AppContext | undefined;

const memory = defineApp({
  id: "test.memory",
  name: "Memory",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [{ id: "devices.register", reason: "For the test." }],
  actions: [],
  events: [],
  async start(context) {
    ctx = context;
  },
  async stop() {
    ctx = undefined;
    things.clear();
  },
  driver: {
    async command(_ctx, { key, capability, command }) {
      const thing = things.get(key);
      if (!thing) {
        throw new ActionError("not_found");
      }
      const { transitionSeconds: _, ...fields } = command as Record<
        string,
        unknown
      >;
      Object.assign(thing.state, fields);
      if ("colorTemperature" in fields) {
        thing.state.colorMode = "temperature";
      }
      if ("hue" in fields) {
        thing.state.colorMode = "color";
      }
      await ctx!.devices.report({ key, states: { [capability]: thing.state } });
    },
  },
});

async function add(kind: CapabilityKind) {
  const key = `${kind}-${things.size + 1}`;
  things.set(key, { kind, state: { on: false } });
  if (kind === "button") {
    await ctx!.devices.register({
      key,
      name: key,
      capabilities: [
        { id: "button", kind, features: { actions: ["single", "double"] } },
      ],
    });
    return key;
  }
  await ctx!.devices.register({
    key,
    name: key,
    capabilities: [
      kind === "light"
        ? { id: "light", kind, features: { brightness: true, color: true } }
        : { id: "power", kind: "switch" as const },
    ],
  });
  await ctx!.devices.report({
    key,
    availability: "online",
    states: { [kind === "light" ? "light" : "power"]: { on: false } },
  });
  return key;
}

describeDriver({
  app: memory,
  kinds: ["light", "switch", "button"],
  add,
  async unplug(key) {
    await ctx!.devices.report({ key, availability: "offline" });
  },
  async press(key, action) {
    await ctx!.devices.press({ key, capability: "button", action });
  },
});

describe("the suite's core", () => {
  it("marks an offline remote online when it presses without a state report", async () => {
    const core = createDriverCore(memory);
    await core.start();
    try {
      const key = await add("button");
      await ctx!.devices.report({ key, availability: "offline" });
      await ctx!.devices.press({ key, capability: "button", action: "single" });
      expect(core.availability.get(key)).toBe("online");
    } finally {
      await core.stop();
    }
  });
  it("refuses what the core would refuse, and remembers it", async () => {
    const core = createDriverCore(memory);
    await core.start();
    const key = await add("light");

    await expect(
      ctx!.devices.report({ key, states: { light: { isOn: true } } }),
    ).rejects.toThrow(/light state refused/);
    await expect(
      ctx!.devices.report({ key: "someone-else", availability: "online" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(core.refused).toHaveLength(2);
    await core.stop();
  });

  it("refuses a press its button does not declare, and one of no button", async () => {
    const core = createDriverCore(memory);
    await core.start();
    const remote = await add("button");
    const lamp = await add("light");

    await expect(
      ctx!.devices.press({ key: remote, capability: "button", action: "hold" }),
    ).rejects.toThrow(/does not declare hold/);
    await expect(
      ctx!.devices.press({ key: lamp, capability: "light", action: "single" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(core.presses).toEqual([]);
    expect(core.refused).toHaveLength(2);
    await core.stop();
  });
});
