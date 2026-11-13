import { defineAction, defineApp, type AppInfo } from "@meetsanctum/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createActivity } from "../src/activity/activity.js";
import { lampsCore, radio } from "./devices-support.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";
import { runsOf, steps, trigger } from "./workflows-support.js";

// An app paused for a permission it needs: switching one off stops the app,
// refuses its actions, jobs, workflows and driver calls, and lets what was
// under way finish first; switching it back on starts it again. The household's
// choice stays across restarts.

const lamp = {
  said: [] as string[],
  // While set, Ping waits for it.
  hold: undefined as Promise<void> | undefined,
  // How many Pings have reached the app.
  pings: 0,
  // While set, its stop hook waits for it.
  stopHold: undefined as Promise<void> | undefined,
  reset() {
    this.said.length = 0;
    this.hold = undefined;
    this.pings = 0;
    this.stopHold = undefined;
  },
};

beforeEach(() => lamp.reset());

const ping = defineAction({
  id: "lamp.ping",
  title: "Ping",
  tier: "read",
  input: z.object({}),
  output: z.object({ places: z.number() }),
  async run(ctx) {
    lamp.pings += 1;
    await lamp.hold;
    return { places: (await ctx.places.list()).rooms.length };
  },
});

const glow = defineAction({
  id: "lamp.glow",
  title: "Glow",
  tier: "write",
  input: z.object({}),
  output: z.object({}),
  async run() {
    lamp.said.push("glow");
    return {};
  },
});

// A job at 12:05 and a workflow at 12:01, each glowing.
const plan = defineAction({
  id: "lamp.plan",
  title: "Plan",
  tier: "write",
  input: z.object({}),
  output: z.object({ workflow: z.string() }),
  async run(ctx) {
    await ctx.jobs.schedule({
      key: "glow",
      action: glow,
      input: {},
      when: { at: "2026-10-26T12:05:00Z" },
    });
    const kept = await ctx.workflows.put("noon", {
      name: "Noon",
      graph: steps(trigger("at", "time", { time: "12:01" }), {
        id: "glow",
        kind: "step",
        app: "test.lamp",
        piece: "lamp.glow",
        config: {},
      }),
    });
    return { workflow: kept.id };
  },
});

const lampPackage = {
  origin: "official" as const,
  app: defineApp({
    id: "test.lamp",
    name: "Lamp",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [
      { id: "places.read", reason: "To light each room.", needed: true },
      { id: "people.read", reason: "To greet who comes home." },
      { id: "workflows.manage", reason: "To glow at noon.", needed: true },
    ],
    actions: [ping, glow, plan],
    events: [],
    provides: { steps: [glow] },
    async start() {
      lamp.said.push("start");
    },
    async stop() {
      lamp.said.push("stop");
      await lamp.stopHold;
    },
  }),
};

async function lampCore(dataDir?: string) {
  const core = await testCore({ apps: [lampPackage], dataDir });
  const maya = await claimed(core);
  return { core, maya };
}

function grant(
  core: TestCore,
  token: string,
  permission: string,
  granted: boolean,
) {
  return post(
    core,
    "/api/apps/test.lamp/permissions/update",
    { permission, granted },
    { token },
  );
}

const call = (core: TestCore, token: string, action: string) =>
  post(core, `/api/apps/test.lamp/actions/${action}`, {}, { token });

async function lampInfo(core: TestCore, token: string) {
  const listed = (await get(core, "/api/apps", { token })).json() as AppInfo[];
  return listed.find((app) => app.id === "test.lamp")!;
}

// A grant is answered before the app has stopped or runs again, so the tests
// wait for the one they go on from, however long a slow runner takes: its
// stop hook has run, or it takes calls again, which is after its start hook.
// Its listed state would not do for that: paused does not say its stop hook
// has run, and starting can still mean a stop from before is under way.
const stopped = () => expect.poll(() => lamp.said.at(-1)).toBe("stop");
const running = (core: TestCore, appId = "test.lamp") =>
  expect.poll(() => core.apps.isRunning(appId)).toBe(true);

// Long enough for a stop that must not come to have come.
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("switching off a permission an app needs", () => {
  it("pauses it: it stops, and its actions are refused, those that would change something logged", async () => {
    const { core, maya } = await lampCore();
    expect(lamp.said).toEqual(["start"]);

    const answered = await grant(core, maya.token, "places.read", false);
    await stopped();

    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({
      id: "test.lamp",
      permissions: ["people.read", "workflows.manage"],
      state: "paused",
    });
    expect(lamp.said).toEqual(["start", "stop"]);
    const refused = await call(core, maya.token, "lamp.ping");
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "unavailable" });
    expect((await call(core, maya.token, "lamp.glow")).statusCode).toBe(503);
    // Its pages keep reading it, which logs nothing.
    expect(
      createActivity(core.db)
        .recent()
        .filter((entry) => entry.source === "test.lamp")
        .map(({ action, outcome, reason }) => ({ action, outcome, reason })),
    ).toEqual([
      { action: "lamp.glow", outcome: "refused", reason: "unavailable" },
      { action: "permissions.update", outcome: "ok", reason: null },
    ]);
    expect((await lampInfo(core, maya.token)).state).toBe("paused");
  });

  it("starts it again once the permission is back on", async () => {
    const { core, maya } = await lampCore();
    await grant(core, maya.token, "places.read", false);
    await stopped();

    const answered = await grant(core, maya.token, "places.read", true);

    expect(answered.json()).toMatchObject({ state: "starting" });
    await expect
      .poll(async () => (await lampInfo(core, maya.token)).state)
      .toBe("running");
    expect(lamp.said).toEqual(["start", "stop", "start"]);
    expect((await call(core, maya.token, "lamp.ping")).json()).toEqual({
      places: 0,
    });
  });

  it("is starting, not running, once the permission is back on while it still stops", async () => {
    const { core, maya } = await lampCore();
    let release!: () => void;
    lamp.stopHold = new Promise((resolve) => (release = resolve));
    await grant(core, maya.token, "places.read", false);
    await stopped();

    const answered = await grant(core, maya.token, "places.read", true);

    expect(answered.json()).toMatchObject({ state: "starting" });
    expect((await lampInfo(core, maya.token)).state).toBe("starting");
    expect(core.apps.isRunning("test.lamp")).toBe(false);
    expect(lamp.said).toEqual(["start", "stop"]);
    // A call meanwhile waits for it, as for any app on its way back.
    const glowing = call(core, maya.token, "lamp.glow");
    release();

    expect((await glowing).statusCode).toBe(200);
    expect(lamp.said).toEqual(["start", "stop", "start", "glow"]);
    expect((await lampInfo(core, maya.token)).state).toBe("running");
  });

  it("is paused as before when the permission goes off again while it still stops", async () => {
    const { core, maya } = await lampCore();
    let release!: () => void;
    lamp.stopHold = new Promise((resolve) => (release = resolve));
    await grant(core, maya.token, "places.read", false);
    await stopped();
    const paused = await lampInfo(core, maya.token);
    core.advance(1_000);
    await grant(core, maya.token, "places.read", true);

    core.advance(1_000);
    await grant(core, maya.token, "places.read", false);
    release();

    // Once what was under way has ended, with nothing started.
    await vi.waitFor(() =>
      expect(
        core.logs.filter(
          (line) =>
            line === "apps: test.lamp is paused while places.read is off",
        ),
      ).toHaveLength(2),
    );
    expect(await lampInfo(core, maya.token)).toEqual(paused);
    expect(lamp.said).toEqual(["start", "stop"]);
  });

  it("lets a call under way finish before the app stops", async () => {
    const { core, maya } = await lampCore();
    let release!: () => void;
    lamp.hold = new Promise((resolve) => (release = resolve));
    // Ping waits for the hold, then reads places, which it still holds.
    const pinging = call(core, maya.token, "lamp.ping");
    await expect.poll(() => lamp.pings).toBe(1);

    await grant(core, maya.token, "workflows.manage", false);
    await aMoment();
    expect(lamp.said).toEqual(["start"]);
    release();

    expect((await pinging).json()).toEqual({ places: 0 });
    await stopped();
    expect(lamp.said).toEqual(["start", "stop"]);
  });

  it("holds back its jobs and its workflows until it runs again", async () => {
    const { core, maya } = await lampCore();
    const { workflow } = (await call(core, maya.token, "lamp.plan")).json();
    await grant(core, maya.token, "workflows.manage", false);
    await stopped();

    core.advance(2 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();
    expect(await runsOf(core, maya.token, workflow)).toEqual([]);
    const manual = await post(
      core,
      "/api/workflows/run",
      { id: workflow },
      maya,
    );
    expect(manual.json()).toMatchObject({
      error: "invalid_workflow",
      problems: [{ message: "The app test.lamp is paused" }],
    });
    core.advance(4 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();
    expect(lamp.said).toEqual(["start", "stop"]);

    // Both waited for it: the job and the workflow's 12:01.
    await grant(core, maya.token, "workflows.manage", true);
    await running(core);
    core.workflows.tick();
    await core.workflows.settled();
    expect(lamp.said).toEqual(["start", "stop", "start", "glow", "glow"]);
  });

  it("keeps it paused across restarts, without starting it", async () => {
    const first = await lampCore();
    await grant(first.core, first.maya.token, "places.read", false);
    await stopped();
    lamp.reset();

    const again = await testCore({
      apps: [lampPackage],
      dataDir: first.core.dataDir,
    });

    // Once its container has come, which it does paused.
    await vi.waitFor(() =>
      expect(again.logs).toContain(
        "apps: test.lamp is paused while places.read is off",
      ),
    );
    expect(lamp.said).toEqual([]);
    expect(again.apps.list()[0]).toMatchObject({ state: "paused" });
  });
});

describe("switching off a permission an app may do without", () => {
  it("leaves it running", async () => {
    const { core, maya } = await lampCore();

    const answered = await grant(core, maya.token, "people.read", false);
    await aMoment();

    expect(answered.json()).toMatchObject({ state: "running" });
    expect(lamp.said).toEqual(["start"]);
    expect((await call(core, maya.token, "lamp.ping")).statusCode).toBe(200);
  });
});

describe("the grant route", () => {
  it("refuses what an app does not ask for, an app that is not there, and a body that is not a grant", async () => {
    const { core, maya } = await lampCore();

    expect(
      (await grant(core, maya.token, "devices.control:light", true)).json(),
    ).toEqual({ error: "invalid_request" });
    expect(
      (
        await post(
          core,
          "/api/apps/test.missing/permissions/update",
          { permission: "places.read", granted: false },
          maya,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          core,
          "/api/apps/test.lamp/permissions/update",
          { permission: "places.read", granted: "no" },
          maya,
        )
      ).json(),
    ).toEqual({ error: "invalid_request" });
    expect(
      (
        await post(
          core,
          "/api/apps/test.lamp/permissions/update",
          { permission: "places.read", granted: false },
          {},
        )
      ).statusCode,
    ).toBe(401);
  });
});

describe("a paused driver", () => {
  it("takes no commands and lets no devices join until it runs again", async () => {
    const { core, maya, lamp: kitchen } = await lampsCore();
    const command = () =>
      post(
        core,
        "/api/devices/command",
        { device: kitchen, capability: "light", command: { on: true } },
        maya,
      );
    await core.apps.setPermission({
      principal: core.auth.clients.authenticate(maya.token)!,
      appId: "test.lamps",
      permission: "devices.register",
      granted: false,
    });
    await expect.poll(() => radio.stopped).toBe(1);

    expect((await command()).json()).toEqual({ error: "unavailable" });
    expect(core.apps.pairingDrivers()).toEqual([]);

    await core.apps.setPermission({
      principal: core.auth.clients.authenticate(maya.token)!,
      appId: "test.lamps",
      permission: "devices.register",
      granted: true,
    });
    await running(core, "test.lamps");

    expect((await command()).statusCode).toBe(200);
    expect(radio.received.at(-1)?.command).toMatchObject({ key: "lamp-1" });
    expect([radio.started, radio.stopped]).toEqual([2, 1]);
  });
});
