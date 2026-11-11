import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describeDriver } from "@meetsanctum/app-testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import lampsDriver from "./fixtures/apps/lamps/index.js";
import {
  lampsCore,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { post, sharedClient, type TestCore } from "./support.js";

// Apps using places and devices through their context: the app must hold the
// permission, and the actor behind the call must be allowed what it does.

function call(core: TestCore, token: string, action: string, input: object) {
  return post(core, `/api/apps/test.panel/actions/${action}`, input, {
    token,
  });
}

describe("an app with places.read and light permissions", () => {
  it("reads the home and the lights, and nothing else", async () => {
    const { core, maya, lamp } = await lampsCore();
    await post(core, "/api/places/rooms/add", { name: "Kitchen" }, maya);

    const overview = (
      await call(core, maya.token, "panel.overview", {})
    ).json();

    expect(overview.home).toBe("Home");
    expect(overview.rooms).toEqual([
      { id: expect.any(String), name: "Kitchen", floorId: null },
    ]);
    // The kettle plug is a switch, which the panel may not read.
    expect(overview.devices.map((device: { id: string }) => device.id)).toEqual(
      [lamp],
    );
  });

  it("switches a light as the person behind the call", async () => {
    const { core, maya, lamp } = await lampsCore();

    const switched = await call(core, maya.token, "panel.command", {
      device: lamp,
      capability: "light",
      command: { on: true },
    });

    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ sync: "pending" });
    expect(radio.received.map(({ actor }) => actor)).toEqual([
      { kind: "user", id: maya.person.id },
    ]);
    await settled();
    const shown = await call(core, maya.token, "panel.show", { device: lamp });
    expect(shown.json().capabilities[0]).toMatchObject({
      sync: "synced",
      state: { on: true },
    });
  });

  it("cannot reach a kind it does not hold", async () => {
    const { core, maya, plug } = await lampsCore();

    const switched = await call(core, maya.token, "panel.command", {
      device: plug,
      capability: "power",
      command: { on: true },
    });
    const shown = await call(core, maya.token, "panel.show", { device: plug });

    expect(switched.statusCode).toBe(404);
    expect(shown.statusCode).toBe(404);
    expect(radio.received).toEqual([]);
  });

  it("sees and switches every device when a shared client calls it", async () => {
    const { core, lamp } = await lampsCore();
    const kitchen = sharedClient(core);

    const overview = await call(core, kitchen.token, "panel.overview", {});
    const switched = await call(core, kitchen.token, "panel.command", {
      device: lamp,
      capability: "light",
      command: { on: true },
    });

    expect(overview.json().devices).toHaveLength(1);
    expect(switched.statusCode).toBe(200);
  });

  it("lets anyone switch lights through it", async () => {
    const { core, lamp } = await lampsCore();
    const sam = personWithClient(core, "Sam");

    const switched = await call(core, sam.token, "panel.command", {
      device: lamp,
      capability: "light",
      command: { on: true },
    });

    expect(switched.statusCode).toBe(200);
  });
});

describe("an app without the permission", () => {
  it("fails, since using what it does not hold is its own mistake", async () => {
    const peek = defineAction({
      id: "nosy.peek",
      title: "Peek",
      tier: "read",
      input: z.object({ what: z.enum(["places", "devices", "register"]) }),
      output: z.unknown(),
      async run(ctx, input) {
        if (input.what === "places") return ctx.places.list();
        if (input.what === "devices") return ctx.devices.list();
        return ctx.devices.register({
          key: "fake",
          name: "Front door",
          capabilities: [{ id: "power", kind: "switch" }],
        });
      },
    });
    const nosy = defineApp({
      id: "test.nosy",
      name: "Nosy",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [peek],
      events: [],
    });
    const { core, maya } = await lampsCore({
      apps: [{ app: nosy, origin: "system" }],
    });

    for (const what of ["places", "devices", "register"]) {
      const asked = await post(
        core,
        "/api/apps/test.nosy/actions/nosy.peek",
        { what },
        maya,
      );
      expect(asked.statusCode).toBe(500);
    }
    expect(core.devices.list()).toHaveLength(2);
    expect(core.logs.join("\n")).toMatch(/does not hold places.read/);
  });
});

describe("an action that timed out", () => {
  it("commands nothing afterwards", async () => {
    const slow = defineAction({
      id: "slow.switch",
      title: "Switch, slowly",
      tier: "write",
      input: z.object({ device: z.string() }),
      output: z.unknown(),
      async run(ctx, input) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return ctx.devices.command({
          device: input.device,
          capability: "light",
          command: { on: true },
        });
      },
    });
    const app = defineApp({
      id: "test.slow",
      name: "Slow",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [{ id: "devices.control:light", reason: "For the test." }],
      actions: [slow],
      events: [],
    });
    const { core, maya, lamp } = await lampsCore({
      apps: [{ app, origin: "system" }],
      appTimeoutMs: 10,
    });

    const asked = await post(
      core,
      "/api/apps/test.slow/actions/slow.switch",
      { device: lamp },
      maya,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(asked.json()).toEqual({ error: "timeout" });
    expect(radio.received).toEqual([]);
  });
});

describe("lifecycle hooks", () => {
  it("start apps with the core and stop them when it closes", async () => {
    const { core } = await lampsCore();

    expect(radio.started).toBe(1);
    await core.apps.close();
    expect(radio.stopped).toBe(1);
  });

  it("keep a failing app from holding up the others", async () => {
    const broken = defineApp({
      id: "test.broken",
      name: "Broken",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [],
      events: [],
      async start() {
        throw new Error("no radio");
      },
    });
    const { core } = await lampsCore({
      apps: [{ app: broken, origin: "system" }],
    });

    expect(radio.started).toBe(1);
    expect(core.logs).toContain("apps: test.broken did not start (no radio)");
  });
});

// The fixture driver passes the capability suite a driver app must pass,
// playing its pretend radio's side.
describeDriver({
  app: lampsDriver,
  kinds: ["light", "switch", "button", "sensor", "occupancy"],
  async setUp() {
    radio.reset();
  },
  add: (kind) => radio.add(`${kind}-${radio.gadgets.size + 1}`, kind),
  unplug: (key) => radio.unplug(key),
  press: (key, action) => radio.pressButton(key, action),
});
