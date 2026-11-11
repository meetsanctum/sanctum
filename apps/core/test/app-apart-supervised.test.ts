import {
  defineAction,
  defineApp,
  NotReady,
  registerPermission,
  type AppContext,
  type AppDefinition,
  type StartInfo,
  type StopInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { base, supervised, useCleanUps } from "./app-apart-support.js";
import { claimed, post } from "./support.js";

// The real host, its real supervisor and the real runner, with a container as a
// session in this process: what starts, what it's told and what comes after a
// failure. A real container's crash, hang and memory are in apps/manager's
// real-image test.

useCleanUps();

const recording = (
  id: string,
  starts: StartInfo[],
  stops: StopInfo[] = [],
  extra: Partial<AppDefinition> = {},
) =>
  defineApp({
    ...base,
    id,
    permissions: [],
    actions: [],
    start: async (_ctx, info) => void starts.push(info),
    stop: async (_ctx, info) => void stops.push(info),
    ...extra,
  });

describe("an app that runs apart, supervised", () => {
  it("starts its container by itself, and runs once its start returns", async () => {
    const starts: StartInfo[] = [];
    const { running, stateOf, containers } = await supervised(
      recording("test.boots", starts),
    );

    await running();

    expect(containers()).toBe(1);
    expect(starts).toEqual([{ reason: "added" }]);
    expect(stateOf().run).toEqual({ since: expect.any(String) });
  });

  describe("telling its hooks why", () => {
    it("waits for a resumed start to finish before saying it runs", async () => {
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let starts = 0;
      const app = recording("test.resumes", [], [], {
        permissions: [
          { id: "people.read", reason: "For the test.", needed: true },
        ],
        start: async () => {
          starts += 1;
          if (starts === 2) await resumed;
        },
      });
      const { core, running, stateOf } = await supervised(app);
      const maya = await claimed(core);
      await running();
      const principal = core.auth.clients.authenticate(maya.token)!;
      try {
        await core.apps.setPermission({
          principal,
          appId: app.id,
          permission: "people.read",
          granted: false,
        });
        await vi.waitFor(() => expect(stateOf().state).toBe("paused"));
        await core.apps.setPermission({
          principal,
          appId: app.id,
          permission: "people.read",
          granted: true,
        });
        await vi.waitFor(() => expect(starts).toBe(2));

        expect(stateOf().state).toBe("starting");
        expect(stateOf().run?.isFirstStart).toBeUndefined();
        expect(core.apps.isRunning(app.id)).toBe(false);
      } finally {
        resume();
      }
      await running();
    });

    it("says it was added, then started, then updated from its last version", async () => {
      const starts: StartInfo[] = [];
      const app = recording("test.reasons", starts);
      const first = await supervised(app);
      await first.running();
      await first.core.apps.close();

      const second = await supervised(app, { dataDir: first.core.dataDir });
      await second.running();
      await second.core.apps.close();

      const third = await supervised(app, {
        dataDir: first.core.dataDir,
        version: "1.1.0",
      });
      await third.running();

      expect(starts).toEqual([
        { reason: "added" },
        { reason: "started" },
        { reason: "updated", from: "1.0.0" },
      ]);
    });

    it("stays added until its first start has returned", async () => {
      const starts: StartInfo[] = [];
      let fails = true;
      const app = defineApp({
        ...base,
        id: "test.first",
        permissions: [],
        actions: [],
        start: async (_ctx, info) => {
          starts.push(info);
          if (fails) {
            fails = false;
            throw new Error("Not this time");
          }
        },
      });

      const { running } = await supervised(app);
      await running();

      expect(starts).toEqual([{ reason: "added" }, { reason: "added" }]);
    });

    it("says why it stops: paused, removing and shutdown", async () => {
      const stops: StopInfo[] = [];
      const app = defineApp({
        ...base,
        id: "test.stops",
        permissions: [
          { id: "people.read", reason: "For the test.", needed: true },
        ],
        actions: [],
        stop: async (_ctx, info) => void stops.push(info),
      });
      const { core, running } = await supervised(app);
      const maya = await claimed(core);
      await running();
      const grant = (granted: boolean) =>
        core.apps.setPermission({
          principal: core.auth.clients.authenticate(maya.token)!,
          appId: app.id,
          permission: "people.read",
          granted,
        });

      await grant(false);
      await vi.waitFor(() => expect(stops).toEqual([{ reason: "paused" }]));
      await grant(true);
      await running();
      await core.apps.remove(app.id);

      expect(stops).toEqual([{ reason: "paused" }, { reason: "removing" }]);
    });
  });

  describe("after a failure", () => {
    it("doesn't restart in the old container when a failed stop is still ending it", async () => {
      let resolveStopped!: (value: void) => void;
      const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      const starts: StartInfo[] = [];
      const app = recording("test.stopfails", starts, [], {
        permissions: [
          { id: "people.read", reason: "For the test.", needed: true },
        ],
        stop: async () => {
          throw new Error("Still running");
        },
      });
      const { core, running, containers } = await supervised(app, {
        beforeStop: () => stopped,
      });
      try {
        const maya = await claimed(core);
        await running();
        const principal = core.auth.clients.authenticate(maya.token)!;
        const grant = (granted: boolean) =>
          core.apps.setPermission({
            principal,
            appId: app.id,
            permission: "people.read",
            granted,
          });
        await grant(false);
        await vi.waitFor(() =>
          expect(
            core.apps.list().find(({ id }) => id === app.id)?.run?.lastFailure,
          ).toBe("hung"),
        );
        await grant(true);
        await new Promise((done) => setTimeout(done, 30));

        expect(starts).toHaveLength(1);
        expect(containers()).toBe(1);
        expect(core.apps.isRunning(app.id)).toBe(false);
      } finally {
        resolveStopped();
      }
      await running();
      expect(containers()).toBe(2);
    });

    it("keeps a failed app failed when a needed permission is switched back on", async () => {
      let resolveStopped!: (value: void) => void;
      const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      let attempts = 0;
      const app = recording("test.failedgrants", [], [], {
        permissions: [
          { id: "people.read", reason: "For the test.", needed: true },
        ],
        start: async () => {
          attempts += 1;
          throw new Error("No luck");
        },
      });
      const { core, stateOf } = await supervised(app, {
        beforeStop: async () => {
          if (attempts === 5) await stopped;
        },
      });
      try {
        const maya = await claimed(core);
        await vi.waitFor(() => expect(stateOf().state).toBe("failed"));
        const principal = core.auth.clients.authenticate(maya.token)!;
        for (const granted of [false, true])
          await core.apps.setPermission({
            principal,
            appId: app.id,
            permission: "people.read",
            granted,
          });
        await new Promise((done) => setTimeout(done, 30));

        expect(attempts).toBe(5);
        expect(stateOf().state).toBe("failed");
      } finally {
        resolveStopped();
      }
    });

    it.each(["action", "driver"] as const)(
      "includes the restart wait in a %s call's deadline",
      async (kind) => {
        let resolveStarting!: (value: void) => void;
        const starting = new Promise<void>((resolve) => {
          resolveStarting = resolve;
        });
        let resolveEntered!: (value: void) => void;
        const entered = new Promise<void>((resolve) => {
          resolveEntered = resolve;
        });
        const work = async () => {
          await new Promise((done) => setTimeout(done, 200));
          return "ran";
        };
        const app = recording("test.deadline", [], [], {
          actions: [
            defineAction({
              id: "deadline.act",
              title: "Act",
              tier: "read",
              input: z.object({}),
              output: z.unknown(),
              run: work,
            }),
          ],
          ...(kind === "driver"
            ? {
                permissions: [
                  { id: registerPermission, reason: "For the test." },
                ],
                driver: {
                  command: async () => {
                    await work();
                  },
                },
              }
            : {}),
          start: async () => {
            resolveEntered();
            await starting;
          },
        });
        const { core } = await supervised(app, { appTimeoutMs: 300 });
        await entered;
        const result = (
          kind === "action"
            ? core.apps.invoke({
                actor: { kind: "app", id: app.id },
                appId: app.id,
                actionId: "deadline.act",
                input: {},
              })
            : core.apps.deliver(app.id, {} as never, {
                kind: "app",
                id: app.id,
              })
        ).then(
          () => "ok",
          (error: unknown) => (error as { code: string }).code,
        );
        await new Promise((done) => setTimeout(done, 200));
        resolveStarting();

        expect(await result).toBe("timeout");
      },
    );

    it("restarts in a new container when it crashes, and says what stopped it", async () => {
      const starts: StartInfo[] = [];
      const { running, crash, stateOf, containers } = await supervised(
        recording("test.again", starts),
      );
      await running();

      await crash();
      await vi.waitFor(() => expect(containers()).toBe(2));
      await running();

      expect(starts).toEqual([{ reason: "added" }, { reason: "started" }]);
      expect(stateOf().run).toMatchObject({
        failures: 1,
        lastFailure: "crashed",
      });
    });

    it("restarts in a new container when its start fails", async () => {
      let fails = true;
      const app = defineApp({
        ...base,
        id: "test.startfails",
        permissions: [],
        actions: [],
        start: async () => {
          if (fails) {
            fails = false;
            throw new Error("No luck");
          }
        },
      });

      const { running, stateOf, containers } = await supervised(app);
      await running();

      expect(containers()).toBe(2);
      expect(stateOf().run).toMatchObject({
        failures: 1,
        lastFailure: "failed_start",
      });
    });

    it("gives up after five, says so, and someone can restart it", async () => {
      let fails = true;
      const app = defineApp({
        ...base,
        id: "test.givesup",
        permissions: [],
        actions: [],
        start: async () => {
          if (fails) throw new Error("It never works");
        },
      });
      const { core, stateOf, containers, running } = await supervised(app);
      const maya = await claimed(core);

      await vi.waitFor(() => expect(stateOf().state).toBe("failed"), {
        timeout: 5_000,
      });
      expect(containers()).toBe(5);
      expect(stateOf().run).toMatchObject({
        failures: 5,
        lastFailure: "failed_start",
      });

      fails = false;
      const restarted = await post(
        core,
        "/api/apps/test.givesup/restart",
        {},
        maya,
      );

      expect(restarted.statusCode).toBe(200);
      await running();
      expect(stateOf().run?.failures).toBeUndefined();
    });

    it("refuses a restart unless it has been given up on", async () => {
      const { core, running } = await supervised(recording("test.fine", []));
      const maya = await claimed(core);
      await running();

      const refused = await post(core, "/api/apps/test.fine/restart", {}, maya);

      expect(refused.statusCode).toBe(409);
    });

    it("lets a call wait for it, and answers once it's back", async () => {
      let blocked = true;
      let release!: () => void;
      const app = defineApp({
        ...base,
        id: "test.waited",
        permissions: [],
        actions: [
          defineAction({
            id: "waited.act",
            title: "Act",
            tier: "read",
            input: z.object({}),
            output: z.unknown(),
            run: async () => "ran",
          }),
        ],
        start: async () => {
          if (blocked) await new Promise<void>((done) => (release = done));
          blocked = false;
        },
      });
      const { core, stateOf } = await supervised(app);
      const maya = await claimed(core);
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(stateOf().state).toBe("starting");

      const answer = post(
        core,
        "/api/apps/test.waited/actions/waited.act",
        {},
        maya,
      );
      const early = await Promise.race([
        answer.then(() => "answered"),
        new Promise((done) => setTimeout(done, 50, "waiting")),
      ]);
      expect(early).toBe("waiting");
      release();

      expect((await answer).statusCode).toBe(200);
    });

    it("refuses a call once its time runs out waiting", async () => {
      const app = defineApp({
        ...base,
        id: "test.slow",
        permissions: [],
        actions: [
          defineAction({
            id: "slow.act",
            title: "Act",
            tier: "read",
            input: z.object({}),
            output: z.unknown(),
            run: async () => "ran",
          }),
        ],
        start: () => new Promise<void>(() => undefined),
      });
      const { core } = await supervised(app, { appTimeoutMs: 30 });
      const maya = await claimed(core);

      const answer = await post(
        core,
        "/api/apps/test.slow/actions/slow.act",
        {},
        maya,
      );

      expect(answer.statusCode).toBe(503);
    });
  });

  describe("an app that isn't ready", () => {
    it("aborts the requests left by a start that isn't ready", async () => {
      let requested!: () => void;
      const asked = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const signals: AbortSignal[] = [];
      const app = recording("test.waitingnet", [], [], {
        permissions: [{ id: "net:api.example.com", reason: "For the test." }],
        start: async (ctx) => {
          void ctx.net
            .fetch({ url: "https://api.example.com/" })
            .catch(() => undefined);
          await asked;
          throw new NotReady("Not yet");
        },
      });
      const { stateOf } = await supervised(app, {
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init!.signal!;
            signals.push(signal);
            signal.addEventListener("abort", () => reject(signal.reason));
            requested();
          }),
      });
      await vi.waitFor(() => expect(stateOf().state).toBe("waiting"));

      expect(signals[0]?.aborted).toBe(true);
    });

    it("waits, says for what, tries again and counts nothing", async () => {
      let ready = false;
      const tries: StartInfo[] = [];
      const app = defineApp({
        ...base,
        id: "test.notready",
        permissions: [],
        actions: [],
        start: async (_ctx, info) => {
          tries.push(info);
          if (!ready) throw new NotReady("Waiting for Zigbee2MQTT");
        },
      });

      const { running, stateOf, containers } = await supervised(app);

      await vi.waitFor(() => expect(stateOf().state).toBe("waiting"));
      expect(stateOf().run).toMatchObject({
        waitingFor: "Waiting for Zigbee2MQTT",
      });
      await vi.waitFor(() => expect(tries.length).toBeGreaterThan(2));
      expect(containers()).toBe(1);

      ready = true;
      await running();

      expect(stateOf().run?.waitingFor).toBeUndefined();
      expect(stateOf().run?.failures).toBeUndefined();
      expect(containers()).toBe(1);
    });

    it("hears none of the core's events until it has started", async () => {
      let ready = false;
      const heard: string[] = [];
      const app = defineApp({
        ...base,
        id: "test.notyet",
        permissions: [{ id: "places.read", reason: "For the test." }],
        actions: [],
        start: async (ctx) => {
          await ctx.events.on("place.added", async (event) => {
            heard.push(event.name);
          });
          if (!ready) throw new NotReady("Not yet");
        },
      });
      const { core, stateOf, running } = await supervised(app);
      const maya = await claimed(core);
      await vi.waitFor(() => expect(stateOf().state).toBe("waiting"));

      await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
      await new Promise((done) => setTimeout(done, 30));
      expect(heard).toEqual([]);

      ready = true;
      await running();
      await post(core, "/api/places/rooms/add", { name: "Hall" }, maya);

      await vi.waitFor(() => expect(heard).toEqual(["place.added"]));
    });
  });

  describe("what shows of it going down", () => {
    const lamp = async (ctx: AppContext) => {
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
    };
    const driver = (start: (ctx: AppContext) => Promise<void>) =>
      defineApp({
        ...base,
        id: "test.quiet",
        permissions: [{ id: registerPermission, reason: "For the test." }],
        actions: [],
        driver: { command: async () => undefined },
        start,
      });

    it("says so even if a driver's devices can't be marked offline", async () => {
      let starts = 0;
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const { core, running, crash, stateOf } = await supervised(
        driver(async (ctx) => {
          starts += 1;
          if (starts === 1) await lamp(ctx);
          else await resumed;
        }),
        { supervision: { quietMs: 50 } },
      );
      await running();
      const marking = vi
        .spyOn(core.devices, "markDriverOffline")
        .mockImplementation(() => {
          throw new Error("The database is locked");
        });

      await crash();

      await vi.waitFor(() => expect(marking).toHaveBeenCalled());
      await vi.waitFor(() => expect(stateOf().run?.quiet).toBeUndefined());
      marking.mockRestore();
      resume();
      await running();
    });

    it("is quiet at first, then says so, and a driver's devices go offline", async () => {
      let starts = 0;
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const { core, running, crash, stateOf } = await supervised(
        driver(async (ctx) => {
          starts += 1;
          if (starts === 1) {
            await lamp(ctx);
          } else {
            await resumed;
            await ctx.devices.report({ key: "lamp", availability: "online" });
          }
        }),
        { supervision: { quietMs: 150 } },
      );
      await running();
      expect(stateOf().run?.quiet).toBeUndefined();
      expect(core.devices.list()[0]?.availability).toBe("online");

      await crash();
      await vi.waitFor(() => expect(stateOf().run?.quiet).toBe(true));
      expect(core.devices.list()[0]?.availability).toBe("online");

      await vi.waitFor(() => expect(stateOf().run?.quiet).toBeUndefined());
      expect(core.devices.list()[0]?.availability).toBe("offline");
      expect(core.devices.list()[0]?.leftAt).toBeNull();
      expect(
        core.activity
          .recent()
          .filter((entry) => entry.action === "device.left"),
      ).toEqual([]);

      resume();
      await running();
      expect(core.devices.list()[0]?.availability).toBe("online");
    });

    it("leaves a driver's devices alone through a restart that fixes itself", async () => {
      const { core, running, crash, stateOf } = await supervised(driver(lamp), {
        supervision: { quietMs: 3_000 },
      });
      await running();

      await crash();
      await vi.waitFor(() => expect(stateOf().run?.failures).toBe(1));
      await running();

      expect(core.devices.list()[0]?.availability).toBe("online");
      expect(stateOf().run?.quiet).toBeUndefined();
    });
  });

  it("removes its container along with the app", async () => {
    const { core, running } = await supervised(recording("test.removed", []));
    await running();

    await core.apps.remove("test.removed");

    expect(core.apps.has("test.removed")).toBe(false);
  });
});
