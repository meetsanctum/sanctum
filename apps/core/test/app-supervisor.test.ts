import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledApp } from "../src/app-host/installed.js";
import { ManagerRefusal, ManagerUnavailable } from "../src/manager.js";
import { manifest, passes, setUp } from "./app-supervisor-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an app's supervisor", () => {
  describe("after failures", () => {
    it("pauses 1 s, 5 s, 30 s and then 2 min, stopping what is left first", async () => {
      const { entry, supervisor, started, stopped, phase, fail } = setUp();

      for (const [count, pause] of [
        [1, 1_000],
        [2, 5_000],
        [3, 30_000],
        [4, 120_000],
      ] as const) {
        started.length = 0;
        stopped.length = 0;
        fail();
        await passes(0);
        expect(phase()).toBe("restarting");
        expect(entry.supervision!.failures).toHaveLength(count);
        expect(stopped).toEqual([manifest.id]);
        await passes(pause - 1);
        expect(started).toEqual([]);
        await passes(1);
        expect(started).toEqual([manifest.id]);
        expect(phase()).toBe("starting");
        supervisor.started(entry);
      }
    });

    it("gives up at the fifth in ten minutes, and tries nothing more", async () => {
      const { entry, started, stopped, phase, fail } = setUp();

      for (let count = 0; count < 5; count += 1) {
        fail();
        await passes(0);
        if (count < 4) await passes(1_000);
      }

      expect(phase()).toBe("failed");
      started.length = 0;
      await passes(3_600_000);
      expect(started).toEqual([]);
      expect(stopped.length).toBeGreaterThan(0);
      expect(entry.supervision!.lastFailure).toBe("failed_start");
    });

    it("says only the last ten minutes' as recent, and still which was last", async () => {
      const { entry, supervisor, fail } = setUp();
      entry.link = {
        isReady: () => false,
        isConnected: () => true,
      } as InstalledApp["link"];
      fail();
      expect(supervisor.restartsOf(entry).recent).toBe(1);

      await passes(10 * 60_000);

      const restarts = supervisor.restartsOf(entry);
      expect(restarts.recent).toBe(0);
      expect(restarts.last?.failure).toBe("failed_start");
    });

    it("forgets failures older than ten minutes", async () => {
      const { entry, supervisor, phase, fail } = setUp();

      for (let count = 0; count < 4; count += 1) {
        fail();
        await passes(0);
        await passes(120_000);
        supervisor.started(entry);
      }
      await passes(11 * 60_000);
      fail();
      await passes(0);

      expect(phase()).toBe("restarting");
      expect(entry.supervision!.failures).toHaveLength(1);
    });

    it("starts again when someone restarts it, with its failures forgotten", async () => {
      const { entry, supervisor, started, phase, fail } = setUp();
      for (let count = 0; count < 5; count += 1) {
        fail();
        await passes(0);
        if (count < 4) await passes(1_000);
      }
      started.length = 0;

      await supervisor.restart(entry);

      expect(started).toEqual([manifest.id]);
      expect(phase()).toBe("starting");
      expect(entry.supervision!.failures).toEqual([]);
    });

    it("counts a refusal from the manager as a failed start", async () => {
      const { entry, supervisor, phase } = setUp({
        startAppContainer: async () => {
          throw new ManagerRefusal("Its data is damaged", 409);
        },
      });

      await supervisor.launch(entry);
      await passes(0);

      expect(phase()).toBe("restarting");
      expect(entry.supervision!.lastFailure).toBe("failed_start");
    });
  });

  describe("a connection that goes", () => {
    it("stops the app and says it hung", async () => {
      const { entry, supervisor, gone, phase } = setUp();
      supervisor.started(entry);

      supervisor.lost(entry, true);
      await passes(0);

      expect(gone).toHaveBeenCalledWith(entry);
      expect(phase()).toBe("restarting");
      expect(entry.supervision!.lastFailure).toBe("hung");
    });

    it("says it ran out of memory when the kernel says so", async () => {
      const { entry, supervisor } = setUp({
        appContainer: async () => ({ state: "stopped", outOfMemory: true }),
      });
      supervisor.started(entry);

      supervisor.lost(entry, false);
      await passes(0);

      expect(entry.supervision!.lastFailure).toBe("out_of_memory");
    });

    it("waits a moment for the kernel's word on one killed outright", async () => {
      let outOfMemory = false;
      const { entry, supervisor } = setUp({
        appContainer: async () => ({
          state: "stopped",
          exitCode: 137,
          outOfMemory,
        }),
      });
      supervisor.started(entry);

      supervisor.lost(entry, false);
      await passes(0);
      expect(entry.supervision!.lastFailure).toBeUndefined();
      outOfMemory = true;
      await passes(100);

      expect(entry.supervision!.lastFailure).toBe("out_of_memory");
    });

    it("says one killed outright by anything else crashed, once that moment has passed", async () => {
      const { entry, supervisor } = setUp({
        appContainer: async () => ({ state: "stopped", exitCode: 137 }),
      });
      supervisor.started(entry);

      supervisor.lost(entry, false);
      await passes(1_900);
      expect(entry.supervision!.lastFailure).toBeUndefined();
      await passes(200);

      expect(entry.supervision!.lastFailure).toBe("crashed");
    });

    it("says it crashed otherwise, and waits a little for how it stopped", async () => {
      let state: "running" | "stopped" = "running";
      const { entry, supervisor } = setUp({
        appContainer: async () => ({ state }),
      });
      supervisor.started(entry);

      supervisor.lost(entry, false);
      await passes(0);
      expect(entry.supervision!.lastFailure).toBeUndefined();
      state = "stopped";
      await passes(100);

      expect(entry.supervision!.lastFailure).toBe("crashed");
    });

    it("counts one failure when hearing of it comes after the next launch", async () => {
      const { entry, supervisor, fail } = setUp();
      supervisor.started(entry);
      (entry.link as unknown as { isConnected: () => boolean }).isConnected =
        () => true;

      fail();
      await passes(1_000);
      expect(entry.supervision!.phase).toBe("starting");
      supervisor.lost(entry, false);
      await passes(5_000);

      expect(entry.supervision!.failures).toHaveLength(1);
      expect(entry.supervision!.phase).toBe("starting");
    });

    it("counts one failure when the core itself stopped it", async () => {
      const { entry, supervisor, fail } = setUp();
      supervisor.started(entry);

      fail();
      supervisor.lost(entry, false);
      await passes(0);

      expect(entry.supervision!.failures).toHaveLength(1);
    });
  });

  describe("an app that says what it waits for", () => {
    it("begins a new waiting sequence after a failed run", () => {
      const { entry, supervisor, fail } = setUp();
      supervisor.notReady(entry, "Not yet");
      supervisor.notReady(entry, "Not yet");
      fail();

      expect(entry.supervision).toMatchObject({
        retries: 0,
        waitingFor: undefined,
      });
    });

    it("tries again after 5 s, 30 s, 2 min and then every 5 min, counting nothing", async () => {
      const { entry, supervisor, reconciled, phase } = setUp();

      for (const pause of [5_000, 30_000, 120_000, 300_000, 300_000]) {
        reconciled.mockClear();
        supervisor.notReady(entry, "Waiting for Zigbee2MQTT");
        expect(phase()).toBe("waiting");
        expect(entry.supervision!.waitingFor).toBe("Waiting for Zigbee2MQTT");
        await passes(pause - 1);
        expect(reconciled).not.toHaveBeenCalled();
        await passes(1);
        expect(reconciled).toHaveBeenCalledTimes(1);
      }

      expect(entry.supervision!.failures).toEqual([]);
    });

    it("keeps when it began waiting", async () => {
      const { entry, supervisor } = setUp();
      supervisor.notReady(entry, "Waiting for Zigbee2MQTT");
      const since = entry.supervision!.since;

      await passes(5_000);
      supervisor.notReady(entry, "Waiting for Zigbee2MQTT");

      expect(entry.supervision!.since).toBe(since);
    });

    it("runs, and starts its count of tries again, once its start returns", async () => {
      const { entry, supervisor, phase } = setUp();
      supervisor.notReady(entry, "Waiting for Zigbee2MQTT");

      supervisor.started(entry);

      expect(phase()).toBe("running");
      expect(entry.supervision).toMatchObject({
        retries: 0,
        waitingFor: undefined,
      });
    });

    it("waits for the manager when it can't run apps yet, without counting", async () => {
      const startAppContainer = vi.fn(async () => ({ kept: false }));
      let can = false;
      const { entry, supervisor, phase } = setUp({
        startAppContainer,
        capabilities: () => ({
          appContainers: can,
          memoryLimits: true,
          discovery: false,
        }),
      });

      await supervisor.launch(entry);
      expect(phase()).toBe("waiting");
      expect(startAppContainer).not.toHaveBeenCalled();

      can = true;
      await passes(5_000);

      expect(startAppContainer).toHaveBeenCalledTimes(1);
      expect(entry.supervision!.failures).toEqual([]);
    });

    it("waits when the manager doesn't answer, without counting", async () => {
      const { entry, supervisor, phase } = setUp({
        startAppContainer: async () => {
          throw new ManagerUnavailable("The manager did not answer");
        },
      });

      await supervisor.launch(entry);

      expect(phase()).toBe("waiting");
      expect(entry.supervision!.failures).toEqual([]);
    });
  });

  describe("how long it stays quiet", () => {
    it("distinguishes its uninterrupted first start from one after a pause", async () => {
      const { entry, supervisor } = setUp();
      await supervisor.launch(entry);
      supervisor.ready(entry);
      await passes(30_000);
      expect(entry.supervision).toMatchObject({
        isFirstStart: true,
        quiet: false,
      });

      supervisor.started(entry);
      supervisor.starting(entry);
      await passes(30_000);
      expect(entry.supervision).toMatchObject({
        isFirstStart: false,
        quiet: false,
      });
    });

    it("no longer treats its first start as uninterrupted once it waits", () => {
      const { entry, supervisor } = setUp();
      supervisor.notReady(entry, "Waiting for Zigbee2MQTT");
      expect(entry.supervision!.isFirstStart).toBe(false);
    });

    it("is quiet for 30 s from going down, through every phase on the way back", async () => {
      const { entry, supervisor, settled, fail } = setUp();
      supervisor.started(entry);
      expect(entry.supervision!.quiet).toBe(false);

      fail();
      await passes(0);
      expect(entry.supervision).toMatchObject({
        phase: "restarting",
        quiet: true,
      });

      await passes(1_000);
      expect(entry.supervision).toMatchObject({
        phase: "starting",
        quiet: true,
      });
      await passes(29_000);

      expect(entry.supervision!.quiet).toBe(false);
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it("is over for good once it's back, so a restart that fixes itself never shows", async () => {
      const { entry, supervisor, settled, fail } = setUp();
      supervisor.started(entry);
      fail();
      await passes(1_000);

      supervisor.started(entry);
      await passes(60_000);

      expect(entry.supervision!.quiet).toBe(false);
      expect(settled).not.toHaveBeenCalled();
    });

    it("shows at once when it's given up on", async () => {
      const { entry, settled, fail } = setUp();

      for (let count = 0; count < 5; count += 1) {
        fail();
        await passes(0);
        if (count < 4) await passes(1_000);
      }

      expect(entry.supervision).toMatchObject({
        phase: "failed",
        quiet: false,
      });
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it("tells someone what it waits for only after 5 minutes", async () => {
      const { entry, supervisor } = setUp();
      supervisor.notReady(entry, "Waiting for Zigbee2MQTT");

      await passes(5 * 60_000 - 1);
      expect(entry.supervision!.attention).toBe(false);
      await passes(1);
      expect(entry.supervision!.attention).toBe(true);

      supervisor.started(entry);
      expect(entry.supervision!.attention).toBe(false);
    });

    it("keeps counting those 5 minutes while it's tried again", async () => {
      const { entry, supervisor } = setUp();
      supervisor.notReady(entry, "Waiting for Zigbee2MQTT");

      await passes(5_000);
      supervisor.notReady(entry, "Waiting for Zigbee2MQTT");
      await passes(5 * 60_000 - 5_000);

      expect(entry.supervision!.attention).toBe(true);
    });
  });

  describe("a call that comes while it isn't running", () => {
    it("waits for it to be back", async () => {
      const { entry, supervisor } = setUp();
      const arriving = supervisor.arrives(entry, 30_000);

      supervisor.started(entry);

      await expect(arriving).resolves.toBe(true);
    });

    it("stops waiting at its deadline", async () => {
      const { entry, supervisor } = setUp();
      const arriving = supervisor.arrives(entry, 30_000);

      await passes(30_000);

      await expect(arriving).resolves.toBe(false);
    });

    it("doesn't wait for one that was given up on", async () => {
      const { entry, supervisor, fail } = setUp();
      for (let count = 0; count < 5; count += 1) {
        fail();
        await passes(0);
        if (count < 4) await passes(1_000);
      }

      await expect(supervisor.arrives(entry, 30_000)).resolves.toBe(false);
    });

    it("stops waiting when the app goes away", async () => {
      const { entry, supervisor } = setUp();
      const arriving = supervisor.arrives(entry, 30_000);

      supervisor.end(entry);

      await expect(arriving).resolves.toBe(false);
    });
  });

  describe("work that outlives its run", () => {
    it("starts one that said hello while its container was asked for, after a wait that wasn't its own", async () => {
      let resolveStarting!: () => void;
      const starting = new Promise<void>((resolve) => {
        resolveStarting = resolve;
      });
      const { entry, supervisor, reconciled } = setUp({
        startAppContainer: () => starting.then(() => ({ kept: true })),
      });
      // It waited for the manager to come back, and that wait is over.
      supervisor.waits(entry, "Waiting for its data to come back");
      const launched = supervisor.launch(entry);
      await passes(0);
      // The one that goes on says hello before the manager answers.
      entry.link = { isReady: () => true } as InstalledApp["link"];
      supervisor.ready(entry);
      expect(reconciled).not.toHaveBeenCalled();

      resolveStarting();
      await launched;

      expect(reconciled).toHaveBeenCalledTimes(1);
    });

    it("keeps a NotReady retry's pause when the manager answers after the app", async () => {
      let resolveStarting!: () => void;
      const starting = new Promise<void>((resolve) => {
        resolveStarting = resolve;
      });
      const { entry, supervisor, reconciled } = setUp({
        startAppContainer: () => starting.then(() => ({ kept: false })),
      });
      entry.link = { isReady: () => true } as InstalledApp["link"];
      supervisor.ready(entry);
      const launched = supervisor.launch(entry);
      await passes(0);
      supervisor.notReady(entry, "Not yet");
      resolveStarting();
      await launched;
      await passes(4_999);
      expect(reconciled).toHaveBeenCalledTimes(1);
      await passes(1);
      expect(reconciled).toHaveBeenCalledTimes(2);
    });

    it("still fails one that goes as it's replaced, if nothing says hello after", async () => {
      let resolveStarting!: () => void;
      const starting = new Promise<void>((resolve) => {
        resolveStarting = resolve;
      });
      const { entry, supervisor, phase } = setUp({
        startAppContainer: () => starting.then(() => ({ kept: false })),
      });
      const launched = supervisor.launch(entry);
      await passes(0);

      supervisor.lost(entry, false);
      expect(phase()).toBe("starting");
      expect(entry.supervision!.failures).toEqual([]);

      resolveStarting();
      await launched;
      await passes(60_000);
      expect(entry.supervision!.lastFailure).toBe("failed_start");
    });

    it("doesn't start again when a stop finishes after supervision ends", async () => {
      let resolveStopped!: (value: void) => void;
      const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      const { entry, supervisor, started, fail } = setUp({
        stopAppContainer: () => stopped,
      });
      fail();
      supervisor.end(entry);
      resolveStopped();
      await passes(120_000);

      expect(started).toEqual([]);
      expect(entry.supervision!.timer).toBeUndefined();
    });

    it.each([true, false])(
      "ignores a late container start after ending (success: %s)",
      async (succeeds) => {
        let resolveStarting!: (value: void) => void;
        let rejectStarting!: (reason: unknown) => void;
        const starting = new Promise<void>((resolve, reject) => {
          resolveStarting = resolve;
          rejectStarting = reject;
        });
        const { entry, supervisor } = setUp({
          startAppContainer: () => starting.then(() => ({ kept: false })),
        });
        const launched = supervisor.launch(entry);
        await passes(0);
        const ended = supervisor.end(entry);
        if (succeeds) resolveStarting();
        else rejectStarting(new ManagerUnavailable("Gone"));
        await launched;
        await ended;
        await passes(120_000);

        expect(entry.supervision!.timer).toBeUndefined();
        expect(entry.supervision!.failures).toEqual([]);
      },
    );

    it("ignores a crash diagnosis that arrives after ending", async () => {
      let resolveStatus!: (value: { state: "stopped" }) => void;
      const status = new Promise<{ state: "stopped" }>((resolve) => {
        resolveStatus = resolve;
      });
      const stopAppContainer = vi.fn(async () => undefined);
      const { entry, supervisor } = setUp({
        appContainer: () => status,
        stopAppContainer,
      });
      supervisor.started(entry);
      supervisor.lost(entry, false);
      supervisor.end(entry);
      resolveStatus({ state: "stopped" });
      await passes(120_000);

      expect(stopAppContainer).not.toHaveBeenCalled();
      expect(entry.supervision!.timer).toBeUndefined();
    });

    it("waits for its last container to stop before a manual restart", async () => {
      let resolveStopped!: (value: void) => void;
      const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      const { entry, supervisor, started, fail } = setUp({
        stopAppContainer: () => stopped,
      });
      entry.supervision!.failures = Array(4).fill(Date.now());
      fail();
      const restarted = supervisor.restart(entry);
      await passes(0);
      expect(started).toEqual([]);

      resolveStopped();
      await restarted;
      expect(started).toEqual([manifest.id]);
    });

    it("doesn't reconcile a failed app when an old connection gets ready", async () => {
      const { entry, supervisor, reconciled, fail } = setUp();
      entry.supervision!.failures = Array(4).fill(Date.now());
      fail();

      supervisor.ready(entry);

      expect(reconciled).not.toHaveBeenCalled();
    });

    it("ignores lifecycle callbacks once supervision ends", async () => {
      const { entry, supervisor, started, reconciled, fail } = setUp();
      supervisor.end(entry);
      supervisor.ready(entry);
      supervisor.notReady(entry, "Too late");
      fail();
      await passes(120_000);

      expect(started).toEqual([]);
      expect(reconciled).not.toHaveBeenCalled();
      expect(entry.supervision!.timer).toBeUndefined();
    });
  });
});
