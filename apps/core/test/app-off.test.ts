import {
  defineAction,
  defineApp,
  registerPermission,
  sunType,
  type AppContext,
  type StopInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAppsOff } from "../src/app-host/off.js";
import { base, supervised, useCleanUps } from "./app-apart-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

// Someone turning an app off in its settings: it doesn't run, what it adds leaves
// every screen, a driver's devices are offline and its data stays, until someone turns
// it on. Its container stops while it's off.

useCleanUps();

const sunDay = (date: string) => ({
  date,
  sunrise: `${date}T06:18:00.000Z`,
  sunset: `${date}T16:12:00.000Z`,
  solarNoon: `${date}T11:15:00.000Z`,
});
const sunState = {
  date: "2026-10-29",
  timeZone: "Europe/Zurich",
  days: ["2026-10-29", "2026-10-30", "2026-10-31"].map(sunDay),
};

const settle = () => new Promise((done) => setTimeout(done, 20));

const stateOf = (core: TestCore, id: string) =>
  core.apps.list().find((app) => app.id === id)?.state;

const turn = (
  core: TestCore,
  maya: Awaited<ReturnType<typeof claimed>>,
  id: string,
  off: boolean,
) => post(core, `/api/apps/${id}/off`, { off }, maya);

function lamp(said: string[], stops: StopInfo[] = []) {
  return defineApp({
    ...base,
    id: "test.lamp",
    permissions: [{ id: "places.read", reason: "For the test.", needed: true }],
    actions: [
      defineAction({
        id: "lamp.ping",
        title: "Ping",
        tier: "read",
        input: z.object({}),
        output: z.unknown(),
        run: async () => "pong",
      }),
    ],
    start: async () => void said.push("start"),
    stop: async (_ctx, info) => {
      said.push("stop");
      stops.push(info);
    },
  });
}

describe("turning an app off", () => {
  it("stops it, says so, and refuses its calls", async () => {
    const said: string[] = [];
    const stops: StopInfo[] = [];
    const app = lamp(said, stops);
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);

    const answer = await turn(core, maya, app.id, true);
    await settle();

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ state: "off" });
    expect(said).toEqual(["start", "stop"]);
    expect(stops).toEqual([{ reason: "off" }]);
    expect(core.apps.isRunning(app.id)).toBe(false);
    expect(
      (await post(core, `/api/apps/${app.id}/actions/lamp.ping`, {}, maya))
        .statusCode,
    ).toBe(503);
  });

  it("tells clients only a system app can't be turned off", async () => {
    const app = lamp([]);
    const core = await testCore({ apps: [{ app, origin: "official" }] });

    expect(core.apps.list().find(({ id }) => id === app.id)).not.toHaveProperty(
      "alwaysOn",
    );
  });

  it("starts it again when someone turns it on, asking nothing", async () => {
    const said: string[] = [];
    const app = lamp(said);
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);
    await turn(core, maya, app.id, true);
    await settle();

    const answer = await turn(core, maya, app.id, false);
    await expect.poll(() => said).toEqual(["start", "stop", "start"]);
    await expect.poll(() => stateOf(core, app.id)).toBe("running");

    expect(answer.statusCode).toBe(200);
    expect(
      (await post(core, `/api/apps/${app.id}/actions/lamp.ping`, {}, maya))
        .statusCode,
    ).toBe(200);
  });

  it("stays off across a restart, without starting it", async () => {
    const said: string[] = [];
    const app = lamp(said);
    const first = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(first);
    await turn(first, maya, app.id, true);
    await settle();
    said.length = 0;

    const again = await testCore({
      apps: [{ app, origin: "official" }],
      dataDir: first.dataDir,
    });

    expect(said).toEqual([]);
    expect(stateOf(again, app.id)).toBe("off");
  });

  it("says off rather than paused, and a permission coming back doesn't start it", async () => {
    const said: string[] = [];
    const app = lamp(said);
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);
    const principal = core.auth.clients.authenticate(maya.token)!;
    await turn(core, maya, app.id, true);
    await settle();
    said.length = 0;

    await core.apps.setPermission({
      principal,
      appId: app.id,
      permission: "places.read",
      granted: false,
    });
    await settle();
    expect(stateOf(core, app.id)).toBe("off");
    await core.apps.setPermission({
      principal,
      appId: app.id,
      permission: "places.read",
      granted: true,
    });
    await settle();

    expect(said).toEqual([]);
    expect(stateOf(core, app.id)).toBe("off");
  });

  it("comes back if someone turns it on while it's still stopping", async () => {
    let began!: () => void;
    const stopping = new Promise<void>((done) => {
      began = done;
    });
    let finish!: () => void;
    const finished = new Promise<void>((done) => {
      finish = done;
    });
    const said: string[] = [];
    const app = defineApp({
      ...base,
      id: "test.lamp",
      permissions: [],
      actions: [],
      start: async () => void said.push("start"),
      stop: async () => {
        said.push("stop");
        began();
        await finished;
      },
    });
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);
    await settle();

    await turn(core, maya, app.id, true);
    await stopping;
    await turn(core, maya, app.id, false);
    finish();
    await expect.poll(() => said).toEqual(["start", "stop", "start"]);
    await expect.poll(() => stateOf(core, app.id)).toBe("running");
  });

  it("changes nothing when it's already as asked", async () => {
    const said: string[] = [];
    const app = lamp(said);
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);

    await turn(core, maya, app.id, false);
    await settle();

    expect(said).toEqual(["start"]);
  });

  it.each([true, false])(
    "keeps its state when saving the choice fails (off: %s)",
    async (off) => {
      const said: string[] = [];
      const app = lamp(said);
      const core = await testCore({ apps: [{ app, origin: "official" }] });
      const maya = await claimed(core);
      if (!off) {
        await turn(core, maya, app.id, true);
        await vi.waitFor(() => expect(said).toEqual(["start", "stop"]));
      }
      core.db.$client.exec(`
        CREATE TRIGGER refuse_app_choice BEFORE ${off ? "INSERT" : "DELETE"} ON apps_off
        BEGIN SELECT RAISE(ABORT, 'The choice could not be saved'); END;
      `);

      try {
        expect((await turn(core, maya, app.id, off)).statusCode).toBe(500);
        expect(stateOf(core, app.id)).toBe(off ? "running" : "off");
        expect(core.apps.isRunning(app.id)).toBe(off);
      } finally {
        core.db.$client.exec("DROP TRIGGER refuse_app_choice");
      }

      expect((await turn(core, maya, app.id, off)).statusCode).toBe(200);
      await vi.waitFor(() => expect(core.apps.isRunning(app.id)).toBe(!off));
      expect(stateOf(core, app.id)).toBe(off ? "off" : "running");
    },
  );

  it("refuses a system app, and a body that makes no sense", async () => {
    const said: string[] = [];
    const app = lamp(said);
    const core = await testCore({ apps: [{ app, origin: "system" }] });
    const maya = await claimed(core);

    expect(core.apps.list().find(({ id }) => id === app.id)?.alwaysOn).toBe(
      true,
    );
    expect((await turn(core, maya, app.id, true)).statusCode).toBe(403);
    expect(
      (await post(core, `/api/apps/${app.id}/off`, { off: "yes" }, maya))
        .statusCode,
    ).toBe(400);
    expect(stateOf(core, app.id)).toBe("running");
  });

  it("goes to the activity log", async () => {
    const app = lamp([]);
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);

    await turn(core, maya, app.id, true);
    await settle();
    await turn(core, maya, app.id, false);
    await settle();

    expect(core.activity.recent().map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["turn-off", "turn-on"]),
    );
  });

  describe("a driver", () => {
    const driver = defineApp({
      ...base,
      id: "test.driver",
      permissions: [{ id: registerPermission, reason: "For the test." }],
      actions: [],
      driver: { command: async () => undefined },
      start: async (ctx: AppContext) => {
        await ctx.devices.register({
          key: "lamp",
          name: "Lamp",
          capabilities: [{ id: "light", kind: "switch", features: {} }],
        } as never);
        await ctx.devices.report({
          key: "lamp",
          availability: "online",
          states: { light: { on: false } },
        } as never);
      },
    });

    it("has its devices offline even if the core stopped just after the choice", async () => {
      const apps = [{ app: driver, origin: "official" as const }];
      const before = await testCore({ apps });
      await settle();
      expect(before.devices.list()[0]?.availability).toBe("online");
      createAppsOff(before.db, { now: () => new Date() }).set(driver.id, true);

      const again = await testCore({ apps, dataDir: before.dataDir });

      expect(again.devices.list()[0]).toMatchObject({
        availability: "offline",
        leftAt: null,
      });
    });

    it("has its devices offline while it's off, still paired, and back after", async () => {
      const core = await testCore({
        apps: [{ app: driver, origin: "official" }],
      });
      const maya = await claimed(core);
      await settle();
      const [device] = core.devices.list();
      expect(device?.availability).toBe("online");

      await turn(core, maya, driver.id, true);
      await settle();
      expect(core.devices.get(device!.id)).toMatchObject({
        availability: "offline",
        leftAt: null,
      });

      await turn(core, maya, driver.id, false);
      await expect
        .poll(() => core.devices.get(device!.id))
        .toMatchObject({ availability: "online", leftAt: null });
    });

    it("refuses a command for its device while it's off", async () => {
      const core = await testCore({
        apps: [{ app: driver, origin: "official" }],
      });
      const maya = await claimed(core);
      await settle();
      const [device] = core.devices.list();
      await turn(core, maya, driver.id, true);
      await settle();

      const answer = await post(
        core,
        "/api/devices/command",
        { device: device!.id, capability: "light", command: { on: true } },
        maya,
      );

      expect(answer.statusCode).toBe(503);
    });
  });

  it("hides what it brought from other apps, and keeps it for when it's back", async () => {
    const sky = defineApp({
      ...base,
      id: "test.sky",
      permissions: [],
      actions: [],
      provides: { entities: [sunType] },
      start: async (ctx: AppContext) => {
        await ctx.entities.publish({
          type: sunType.id,
          key: "home",
          name: "Sun",
          state: sunState,
        });
      },
    });
    let reader!: AppContext;
    const garden = defineApp({
      ...base,
      id: "test.garden",
      permissions: [
        {
          id: `entities.read:${sunType.id}`,
          reason: "For the test.",
          needed: true,
        },
      ],
      actions: [],
      start: async (ctx: AppContext) => {
        reader = ctx;
      },
    });
    const core = await testCore({
      apps: [
        { app: sky, origin: "official" },
        { app: garden, origin: "official" },
      ],
    });
    const maya = await claimed(core);
    await settle();
    const read = async () =>
      (await reader.entities.list(sunType.id)).map(({ app }) => app);
    expect(await read()).toEqual(["test.sky"]);

    await turn(core, maya, sky.id, true);
    await settle();
    expect(await read()).toEqual([]);
    // Its data stays: the home still holds what it published.
    expect(core.entities.list({ app: sky.id })).toHaveLength(1);

    await turn(core, maya, sky.id, false);
    await settle();
    expect(await read()).toEqual(["test.sky"]);
  });
});

describe("turning an app off, in its own container", () => {
  const app = (stops: StopInfo[] = []) =>
    defineApp({
      ...base,
      id: "test.boxed",
      permissions: [],
      actions: [],
      stop: async (_ctx, info) => void stops.push(info),
    });

  it("runs its stop hook, then stops its container, which frees its memory", async () => {
    const stops: StopInfo[] = [];
    const {
      core,
      running,
      stateOf: info,
      containers,
    } = await supervised(app(stops));
    const maya = await claimed(core);
    await running();

    const answer = await turn(core, maya, "test.boxed", true);

    expect(answer.json()).toMatchObject({ state: "off" });
    await vi.waitFor(() => expect(stops[0]).toEqual({ reason: "off" }));
    await new Promise((done) => setTimeout(done, 50));
    // It isn't a failure, and nothing starts it again.
    expect(info().state).toBe("off");
    expect(info().run?.failures).toBeUndefined();
    expect(containers()).toBe(1);
  });

  it("starts a new container when someone turns it on", async () => {
    const {
      core,
      running,
      stateOf: info,
      containers,
    } = await supervised(app());
    const maya = await claimed(core);
    await running();
    await turn(core, maya, "test.boxed", true);
    await vi.waitFor(() => expect(info().state).toBe("off"));
    await new Promise((done) => setTimeout(done, 50));

    await turn(core, maya, "test.boxed", false);

    await running();
    expect(containers()).toBe(2);
    expect(info().run?.failures).toBeUndefined();
  });

  it("stops a driver's container even if marking its devices offline fails", async () => {
    const stopping = vi.fn(async () => undefined);
    const driver = defineApp({
      ...base,
      id: "test.driver",
      permissions: [{ id: registerPermission, reason: "For the test." }],
      actions: [],
      driver: { command: async () => undefined },
    });
    const { core, running } = await supervised(driver, {
      beforeStop: stopping,
    });
    const maya = await claimed(core);
    await running();
    const marking = vi
      .spyOn(core.devices, "markDriverOffline")
      .mockImplementation(() => {
        throw new Error("The database is locked");
      });

    try {
      await turn(core, maya, driver.id, true);
      await vi.waitFor(() => expect(stopping).toHaveBeenCalledTimes(1));
      expect(marking).toHaveBeenCalledWith(driver.id);
    } finally {
      marking.mockRestore();
    }
  });

  it("doesn't count the requested stop as a crash if turned on while its container stops", async () => {
    let began!: () => void;
    const stopping = new Promise<void>((resolve) => {
      began = resolve;
    });
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const {
      core,
      running,
      stateOf: info,
      containers,
      crash,
    } = await supervised(app(), {
      beforeStop: async () => {
        began();
        await stopped;
      },
    });
    const maya = await claimed(core);
    await running();

    try {
      await turn(core, maya, "test.boxed", true);
      await stopping;
      await turn(core, maya, "test.boxed", false);
    } finally {
      finish();
    }

    await running();
    expect(containers()).toBe(2);
    expect(info().run?.failures).toBeUndefined();
    await crash();
    await vi.waitFor(() => expect(info().run?.failures).toBe(1));
    await running();
  });

  it("doesn't stop a removed app's container after removal has finished", async () => {
    const stopping = vi.fn(async () => undefined);
    const { core, running } = await supervised(app(), {
      beforeStop: stopping,
    });
    const maya = await claimed(core);
    await running();

    core.apps.setOff({
      principal: core.auth.clients.authenticate(maya.token)!,
      appId: "test.boxed",
      off: true,
    });
    await core.apps.remove("test.boxed");

    expect(stopping).not.toHaveBeenCalled();
  });

  it("forgets what it had been through", async () => {
    const { core, running, crash, stateOf: info } = await supervised(app());
    const maya = await claimed(core);
    await running();
    await crash();
    await vi.waitFor(() => expect(info().run?.failures).toBe(1));
    await running();

    await turn(core, maya, "test.boxed", true);
    await new Promise((done) => setTimeout(done, 50));
    await turn(core, maya, "test.boxed", false);
    await running();

    expect(info().run?.failures).toBeUndefined();
    expect(info().run?.lastFailure).toBeUndefined();
  });

  it("comes back if someone turns it on while it's still stopping", async () => {
    let began!: () => void;
    const stopping = new Promise<void>((done) => {
      began = done;
    });
    let finish!: () => void;
    const finished = new Promise<void>((done) => {
      finish = done;
    });
    const boxed = defineApp({
      ...base,
      id: "test.boxed",
      permissions: [],
      actions: [],
      stop: async () => {
        began();
        await finished;
      },
    });
    const { core, running, stateOf: info } = await supervised(boxed);
    const maya = await claimed(core);
    await running();

    await turn(core, maya, "test.boxed", true);
    await stopping;
    await turn(core, maya, "test.boxed", false);
    finish();

    await running();
    await new Promise((done) => setTimeout(done, 100));
    expect(info().state).toBe("running");
    expect(core.apps.isRunning("test.boxed")).toBe(true);
  });

  it("stays off if someone turns it on and off again while it's stopping", async () => {
    let began!: () => void;
    const stopping = new Promise<void>((done) => {
      began = done;
    });
    let finish!: () => void;
    const finished = new Promise<void>((done) => {
      finish = done;
    });
    const boxed = defineApp({
      ...base,
      id: "test.boxed",
      permissions: [],
      actions: [],
      stop: async () => {
        began();
        await finished;
      },
    });
    const { core, running, stateOf: info } = await supervised(boxed);
    const maya = await claimed(core);
    await running();

    await turn(core, maya, "test.boxed", true);
    await stopping;
    await turn(core, maya, "test.boxed", false);
    await turn(core, maya, "test.boxed", true);
    finish();

    await new Promise((done) => setTimeout(done, 100));
    expect(info().state).toBe("off");
    expect(core.apps.isRunning("test.boxed")).toBe(false);
  });

  it("doesn't wait for one that's off, as it does for one coming back", async () => {
    const boxed = defineApp({
      ...base,
      id: "test.boxed",
      permissions: [],
      actions: [
        defineAction({
          id: "boxed.ping",
          title: "Ping",
          tier: "read",
          input: z.object({}),
          output: z.unknown(),
          run: async () => "pong",
        }),
      ],
    });
    const { core, running } = await supervised(boxed);
    const maya = await claimed(core);
    await running();
    await turn(core, maya, "test.boxed", true);

    const began = Date.now();
    const answer = await post(
      core,
      "/api/apps/test.boxed/actions/boxed.ping",
      {},
      maya,
    );

    expect(answer.statusCode).toBe(503);
    expect(Date.now() - began).toBeLessThan(1_000);
  });
});
