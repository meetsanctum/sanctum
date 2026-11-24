import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describeDriver } from "@meetsanctum/app-testkit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { deviceViewOf } from "../src/app-host/calls.js";
import lampsDriver from "./fixtures/apps/lamps/index.js";
import {
  lampsCore,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { post, sharedClient, testCore, type TestCore } from "./support.js";

// Apps using places and devices through their context: the app must hold the
// permission, and the actor behind the call must be allowed what it does.

function call(core: TestCore, token: string, action: string, input: object) {
  return post(core, `/api/apps/test.panel/actions/${action}`, input, {
    token,
  });
}

describe("microphone grants", () => {
  it.each(["the app", "its page"])(
    "ends a pending microphone command from %s when control is revoked",
    async (source) => {
      const app = defineApp({
        id: "sanctum.example",
        name: "Example",
        version: "1.0.0",
        core: "^2.0.0",
        permissions: [
          {
            id: "devices.control:audio",
            reason: "Change microphone mute.",
            startsOn: true,
          },
        ],
        actions: [
          defineAction({
            id: "example.unmute",
            title: "Turn on microphones",
            tier: "write",
            input: z.object({ device: z.string() }),
            output: z.unknown(),
            run: (ctx, { device }) =>
              ctx.devices.command({
                device,
                capability: "audio",
                command: { muted: false },
              }),
          }),
        ],
        events: [],
      });
      const { core, maya } = await lampsCore({
        apps: [{ app, origin: "system" }],
        confirmMs: 300,
      });
      await radio.add("speaker", "audio");
      await radio.press("speaker", { muted: true });
      const [speaker] = core.devices
        .list()
        .filter((each) => each.type === "smart-speaker");
      radio.confirms = false;
      const device = speaker!.id;
      const sent =
        source === "the app"
          ? await post(
              core,
              "/api/apps/sanctum.example/actions/example.unmute",
              { device },
              maya,
            )
          : await post(
              core,
              "/api/devices/command",
              {
                device,
                capability: "audio",
                command: { muted: false },
              },
              { token: maya.token, headers: { "x-sanctum-app": app.id } },
            );
      expect(sent.statusCode).toBe(200);
      expect(sent.json().sync).toBe("pending");

      const changed = await post(
        core,
        "/api/apps/sanctum.example/permissions/update",
        { permission: "devices.control:audio", granted: false },
        maya,
      );
      expect(changed.statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(core.devices.get(device)?.capabilities[0]?.sync).toBe(
          "conflict",
        );
      });
      expect(radio.received).toHaveLength(1);
    },
  );

  it("hides wake word updates from an app that can only read playback", async () => {
    const core = await testCore();
    const { id } = core.devices.register("test.lamps", {
      key: "speaker",
      name: "Speaker",
      type: "smart-speaker",
      capabilities: [
        { id: "playback", kind: "media" },
        { id: "mics", kind: "audio" },
      ],
    });
    const view = deviceViewOf("sanctum.example", ["devices.read:media"]);
    core.devices.report("test.lamps", {
      key: "speaker",
      availability: "online",
      states: { playback: { activity: "idle" } },
    });
    const before = core.devices.get(id, view);
    expect(before?.lastSeenAt).toBe(core.now().toISOString());
    expect(before?.capabilities.map((part) => part.kind)).toEqual(["media"]);

    core.advance(1_000);
    const heardAt = core.now().toISOString();
    core.devices.report("test.lamps", {
      key: "speaker",
      states: { mics: { heardAt } },
    });

    expect(core.devices.get(id, view)).toEqual(before);
    expect(
      core.devices.get(id)?.capabilities.find((part) => part.kind === "audio")
        ?.observed,
    ).toEqual({ heardAt });
  });
});

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
    // The lamp says what it did only once the test has seen the answer.
    radio.confirms = false;

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
    radio.confirms = true;
    await radio.press("lamp-1", {});
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
          type: "switch",
          capabilities: [{ id: "power", kind: "switch" }],
        });
      },
    });
    const nosy = defineApp({
      id: "test.nosy",
      name: "Nosy",
      version: "0.1.0",
      core: "^2.0.0",
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
    let tried!: () => void;
    const hasTried = new Promise<void>((done) => (tried = done));
    const slow = defineAction({
      id: "slow.switch",
      title: "Switch, slowly",
      tier: "write",
      input: z.object({ device: z.string() }),
      output: z.unknown(),
      async run(ctx, input) {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        try {
          return await ctx.devices.command({
            device: input.device,
            capability: "light",
            command: { on: true },
          });
        } finally {
          tried();
        }
      },
    });
    const app = defineApp({
      id: "test.slow",
      name: "Slow",
      version: "0.1.0",
      core: "^2.0.0",
      permissions: [{ id: "devices.control:light", reason: "For the test." }],
      actions: [slow],
      events: [],
    });
    const { core, maya, lamp } = await lampsCore({
      apps: [{ app, origin: "system" }],
      // Time enough for the driver's start, which registers its devices,
      // also on a busy machine, and short of the action's wait.
      appTimeoutMs: 1_000,
    });

    const asked = await post(
      core,
      "/api/apps/test.slow/actions/slow.switch",
      { device: lamp },
      maya,
    );
    // Once its late command has had its answer from the core.
    await hasTried;

    expect(asked.json()).toEqual({ error: "timeout" });
    expect(radio.received).toEqual([]);
  });
});

describe("lifecycle hooks", () => {
  it("start apps with the core and stop them when it closes", async () => {
    const { core } = await lampsCore();

    expect(radio.started).toBe(1);
    await core.apps.close();
    // In its container, as its runner hears the core go.
    await vi.waitFor(() => expect(radio.stopped).toBe(1));
  });

  it("keep a failing app from holding up the others", async () => {
    const broken = defineApp({
      id: "test.broken",
      name: "Broken",
      version: "0.1.0",
      core: "^2.0.0",
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
  kinds: [
    "light",
    "switch",
    "button",
    "sensor",
    "motion",
    "contact",
    "media",
    "audio",
  ],
  async setUp() {
    radio.reset();
  },
  add: (kind) => radio.add(`${kind}-${radio.gadgets.size + 1}`, kind),
  unplug: (key) => radio.unplug(key),
  press: (key, action) => radio.pressButton(key, action),
});
