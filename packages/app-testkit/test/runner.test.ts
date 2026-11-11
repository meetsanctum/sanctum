import { defineAction, NotReady, type AppContext } from "@meetsanctum/app-sdk";
import {
  maxMessageBytes,
  protocolVersion,
} from "@meetsanctum/app-sdk/protocol";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import Database from "better-sqlite3";
import { access } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createCorePeer } from "../src/core-peer.js";
import {
  createRunnerFixture,
  digest,
  statement,
  testApp,
} from "./runner-fixture.js";

const fixture = createRunnerFixture();

describe("an app's runner", () => {
  it("names its protocol, version and manifest first", async () => {
    const load = vi.fn(async () => ({ app: testApp() }));
    fixture.peer = await createCorePeer({ socket: fixture.socket });
    fixture.session = runSession({
      appId: "test.runner",
      socket: fixture.socket,
      database: fixture.database,
      package: { version: "1.2.3", manifest: digest, load },
    });

    expect(await fixture.peer!.hello).toEqual({
      type: "hello",
      protocol: protocolVersion,
      app: "test.runner",
      version: "1.2.3",
      manifest: digest,
    });
    // Its code doesn't run until the core has welcomed it.
    expect(load).not.toHaveBeenCalled();
  });

  it("waits for the core to listen", async () => {
    fixture.session = runSession({
      appId: "test.runner",
      socket: fixture.socket,
      database: fixture.database,
      package: {
        version: "1.2.3",
        manifest: digest,
        load: async () => ({ app: testApp() }),
      },
    });
    await new Promise((done) => setTimeout(done, 300));

    fixture.peer = await createCorePeer({ socket: fixture.socket });

    expect((await fixture.peer!.hello).app).toBe("test.runner");
  });

  it("gives up when no core appears in time", async () => {
    fixture.session = runSession({
      appId: "test.runner",
      socket: fixture.socket,
      database: fixture.database,
      connectWithinMs: 50,
      package: {
        version: "1.2.3",
        manifest: digest,
        load: async () => ({ app: testApp() }),
      },
    });

    expect(await fixture.session!.finished).toMatchObject({
      code: 1,
      reason: expect.stringContaining("could not reach the core"),
    });
  });

  it("goes no further once the core refuses it, its data untouched", async () => {
    const load = vi.fn(async () => ({
      app: testApp(),
      migrationsFolder: await fixture.migrations(),
    }));
    fixture.peer = await createCorePeer({ socket: fixture.socket });
    fixture.session = runSession({
      appId: "test.runner",
      socket: fixture.socket,
      database: fixture.database,
      package: { version: "1.2.3", manifest: digest, load },
    });
    await fixture.peer!.hello;

    fixture.peer!.refuse("This version is not the one staged");

    expect(await fixture.session!.finished).toEqual({
      code: 1,
      reason:
        "The core refused test.runner: This version is not the one staged",
    });
    expect(load).not.toHaveBeenCalled();
    await expect(access(fixture.database)).rejects.toThrow("ENOENT");
  });

  it("opens and migrates its database before it says it is ready", async () => {
    await fixture.connected(testApp());

    const sqlite = new Database(fixture.database, { readonly: true });
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .all();
    sqlite.close();

    expect(tables).toContainEqual({ name: "things" });
  });

  it("says so when it can't get ready, and ends", async () => {
    fixture.peer = await createCorePeer({ socket: fixture.socket });
    fixture.session = runSession({
      appId: "test.runner",
      socket: fixture.socket,
      database: fixture.database,
      package: {
        version: "1.2.3",
        manifest: digest,
        load: async () => {
          throw new Error("Its entry has no app");
        },
      },
    });
    await fixture.peer!.hello;
    fixture.peer!.welcome();

    expect(await fixture.peer!.prepared).toEqual({
      ready: false,
      message: "Its entry has no app",
    });
    expect(await fixture.session!.finished).toMatchObject({ code: 1 });
  });

  it("refuses a package that holds another app", async () => {
    fixture.peer = await createCorePeer({ socket: fixture.socket });
    fixture.session = runSession({
      appId: "test.other",
      socket: fixture.socket,
      database: fixture.database,
      package: {
        version: "1.2.3",
        manifest: digest,
        load: async () => ({ app: testApp() }),
      },
    });
    await fixture.peer!.hello;
    fixture.peer!.welcome();

    expect(await fixture.peer!.prepared).toEqual({
      ready: false,
      message: "This package holds test.runner, not test.other",
    });
  });

  it("ends when the connection goes", async () => {
    await fixture.connected(testApp());

    fixture.peer!.drop();

    expect(await fixture.session!.finished).toEqual({
      code: 1,
      reason: "The connection to the core has gone",
    });
  });

  it("answers the core's heartbeat", async () => {
    const running = await fixture.connected(testApp());

    await running.beat();
    await running.beat();
  });

  it("ends at a line too long, or something it can't read", async () => {
    const running = await fixture.connected(testApp());

    running.sendRaw(`${"x".repeat(maxMessageBytes + 1)}`);

    expect(await fixture.session!.finished).toMatchObject({
      code: 1,
      reason: expect.stringContaining("over the limit"),
    });
  });

  it("ends at a message it doesn't understand", async () => {
    const running = await fixture.connected(testApp());

    running.sendRaw(`${JSON.stringify({ type: "nonsense" })}\n`);

    expect(await fixture.session!.finished).toMatchObject({
      code: 1,
      reason: "The core sent something this runner does not understand",
    });
  });

  describe("start and stop", () => {
    it("keeps queued calls waiting across a start that isn't ready", async () => {
      let resolveEntered!: (value: void) => void;
      const entered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      let resolveRelease!: (value: void) => void;
      const release = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      let attempts = 0;
      const running = await fixture.connected(
        testApp(
          [
            defineAction({
              ...statement("test.runner.act"),
              run: async () => "ran",
            }),
          ],
          {
            start: async () => {
              attempts += 1;
              if (attempts === 1) {
                resolveEntered();
                await release;
                throw new NotReady("Not yet");
              }
            },
          },
        ),
      );
      const first = running.call({ kind: "start", reason: "added" });
      await entered;
      const queued = running.call(
        { kind: "action", action: "test.runner.act", input: {} },
        { deadlineMs: 500 },
      );
      // Let the runner take the action before the start says it isn't ready.
      await new Promise((done) => setTimeout(done, 10));
      resolveRelease();
      expect(await first).toMatchObject({ ok: false, code: "not_ready" });
      expect(
        await running.call({ kind: "start", reason: "added" }),
      ).toMatchObject({ ok: true });

      expect(await queued).toEqual({ ok: true, value: "ran" });
    });

    it("runs its hooks with a context that lasts between them", async () => {
      const permissions = vi.fn(async () => ["devices.read:light"]);
      let kept: AppContext | undefined;
      const running = await fixture.connected(
        testApp([], {
          start: async (ctx) => {
            kept = ctx;
          },
          stop: async (ctx) => {
            await ctx.permissions.list();
          },
        }),
        { permissions },
      );

      const started = running.issue({ kind: "start", reason: "started" });
      expect(await started.answer).toMatchObject({ ok: true });
      expect(kept?.actor).toEqual({ kind: "app", id: "test" });
      // Long after start returned, what it kept still names its call.
      await kept!.permissions.list();

      expect(
        await running.call({ kind: "stop", reason: "shutdown" }),
      ).toMatchObject({ ok: true });
      expect(running.requests.map(({ call }) => call)).toEqual([
        started.id,
        started.id,
      ]);
      await expect(kept!.permissions.list()).rejects.toThrow("has ended");
    });

    it("lets calls wait for a slow start", async () => {
      const seen: string[] = [];
      let finish!: () => void;
      const running = await fixture.connected(
        testApp(
          [
            defineAction({
              ...statement("test.runner.act"),
              run: async () => {
                seen.push("action");
              },
            }),
          ],
          {
            start: async () => {
              await new Promise<void>((done) => (finish = done));
              seen.push("started");
            },
          },
        ),
      );

      const started = running.call({ kind: "start", reason: "started" });
      const acted = running.call({
        kind: "action",
        action: "test.runner.act",
        input: {},
      });
      await new Promise((done) => setTimeout(done, 20));
      expect(seen).toEqual([]);
      finish();

      await Promise.all([started, acted]);
      expect(seen).toEqual(["started", "action"]);
    });

    it("lets calls go on when start runs out of time, and fails ones it kept too long", async () => {
      const running = await fixture.connected(
        testApp(
          [
            defineAction({
              ...statement("test.runner.act"),
              run: async () => "ran",
            }),
          ],
          { start: () => new Promise<void>(() => undefined) },
        ),
      );

      void running.call(
        { kind: "start", reason: "started" },
        { deadlineMs: 30 },
      );
      const tooShort = running.call(
        { kind: "action", action: "test.runner.act", input: {} },
        { deadlineMs: 10 },
      );
      const inTime = running.call({
        kind: "action",
        action: "test.runner.act",
        input: {},
      });

      expect(await tooShort).toMatchObject({
        ok: false,
        message: "test.runner had not started in time",
      });
      expect(await inTime).toEqual({ ok: true, value: "ran" });
    });

    it("runs a start that comes during a stop after it, and calls after that", async () => {
      const seen: string[] = [];
      let finishStop!: () => void;
      const running = await fixture.connected(
        testApp(
          [
            defineAction({
              ...statement("test.runner.act"),
              run: async () => {
                seen.push("action");
              },
            }),
          ],
          {
            start: async () => {
              seen.push("start");
            },
            stop: async () => {
              seen.push("stop begins");
              await new Promise<void>((done) => (finishStop = done));
              seen.push("stop ends");
            },
          },
        ),
      );
      await running.call({ kind: "start", reason: "started" });
      seen.length = 0;

      const stopped = running.call({ kind: "stop", reason: "shutdown" });
      await vi.waitFor(() => expect(seen).toEqual(["stop begins"]));
      const started = running.call({ kind: "start", reason: "started" });
      const acted = running.call({
        kind: "action",
        action: "test.runner.act",
        input: {},
      });
      await new Promise((done) => setTimeout(done, 20));
      expect(seen).toEqual(["stop begins"]);
      finishStop();

      expect(await stopped).toMatchObject({ ok: true });
      expect(await started).toMatchObject({ ok: true });
      expect(await acted).toMatchObject({ ok: true });
      expect(seen).toEqual(["stop begins", "stop ends", "start", "action"]);
    });

    it("says its data is on the disk once a start on a new version returns", async () => {
      const told: unknown[] = [];
      const running = await fixture.connected(
        testApp([], { start: async (_ctx, info) => void told.push(info) }),
      );

      expect(
        await running.call({
          kind: "start",
          reason: "updated",
          from: "1.2.2",
          update: "update-1",
        }),
      ).toEqual({ ok: true, value: { synced: "update-1" } });
      // The update is the core's and the runner's, not the app's.
      expect(told).toEqual([{ reason: "updated", from: "1.2.2" }]);
    });

    it("says nothing of the kind for a start that fails", async () => {
      const running = await fixture.connected(
        testApp([], {
          start: async () => {
            throw new Error("It fell over");
          },
        }),
      );

      expect(
        await running.call({
          kind: "start",
          reason: "updated",
          from: "1.2.2",
          update: "update-1",
        }),
      ).toMatchObject({ ok: false, message: "It fell over" });
    });

    it("has nothing to say for a start with no update", async () => {
      const running = await fixture.connected(testApp());

      expect(await running.call({ kind: "start", reason: "started" })).toEqual({
        ok: true,
      });
    });

    it("fails a start in its own time while a stop hangs", async () => {
      const start = vi.fn(async () => undefined);
      let stopBegan!: () => void;
      const stopping = new Promise<void>((done) => {
        stopBegan = done;
      });
      const running = await fixture.connected(
        testApp([], {
          start,
          stop: () => {
            stopBegan();
            return new Promise<void>(() => undefined);
          },
        }),
      );
      await running.call({ kind: "start", reason: "started" });
      start.mockClear();

      void running.call({ kind: "stop", reason: "shutdown" });
      await stopping;

      expect(
        await running.call(
          { kind: "start", reason: "started" },
          { deadlineMs: 20 },
        ),
      ).toMatchObject({
        ok: false,
        message: "test.runner was still stopping",
      });
      expect(start).not.toHaveBeenCalled();
    });

    it("answers a second stop with the one under way", async () => {
      let stops = 0;
      let finishStop!: () => void;
      const running = await fixture.connected(
        testApp([], {
          stop: async () => {
            stops += 1;
            await new Promise<void>((done) => (finishStop = done));
          },
        }),
      );
      await running.call({ kind: "start", reason: "started" });

      const first = running.call({ kind: "stop", reason: "shutdown" });
      await vi.waitFor(() => expect(stops).toBe(1));
      const second = running.call({ kind: "stop", reason: "shutdown" });
      finishStop();

      expect(await first).toMatchObject({ ok: true });
      expect(await second).toMatchObject({ ok: true });
      expect(stops).toBe(1);
    });

    it("has nothing to do for a stop with nothing running", async () => {
      const stop = vi.fn(async () => undefined);
      const running = await fixture.connected(testApp([], { stop }));

      expect(
        await running.call({ kind: "stop", reason: "shutdown" }),
      ).toMatchObject({ ok: true });

      expect(stop).not.toHaveBeenCalled();
    });

    it("fails a call in its own time when no start comes", async () => {
      const running = await fixture.connected(
        testApp([
          defineAction({
            ...statement("test.runner.act"),
            run: async () => "ran",
          }),
        ]),
      );
      const act = () =>
        running.call(
          { kind: "action", action: "test.runner.act", input: {} },
          { deadlineMs: 20 },
        );
      const refused = {
        ok: false,
        message: "test.runner had not started in time",
      };

      expect(await act()).toMatchObject(refused);
      await running.call({ kind: "start", reason: "started" });
      expect(await act()).toEqual({ ok: true, value: "ran" });
      await running.call({ kind: "stop", reason: "shutdown" });
      expect(await act()).toMatchObject(refused);
    });

    it("says how a hook failed", async () => {
      const running = await fixture.connected(
        testApp([], {
          start: async () => {
            throw new Error("No broker");
          },
        }),
      );

      expect(await running.call({ kind: "start", reason: "started" })).toEqual({
        ok: false,
        message: "No broker",
      });
    });

    it("can start again after a stop", async () => {
      const starts = vi.fn(async () => undefined);
      const running = await fixture.connected(testApp([], { start: starts }));

      await running.call({ kind: "start", reason: "started" });
      await running.call({ kind: "stop", reason: "shutdown" });
      expect(
        await running.call({ kind: "start", reason: "started" }),
      ).toMatchObject({ ok: true });

      expect(starts).toHaveBeenCalledTimes(2);
    });

    it("refuses a second start while it runs", async () => {
      const running = await fixture.connected(testApp());

      await running.call({ kind: "start", reason: "started" });

      expect(
        await running.call({ kind: "start", reason: "started" }),
      ).toMatchObject({
        ok: false,
        message: "test.runner has already started",
      });
    });

    it("runs its stop hook once when the process is told to go", async () => {
      const stop = vi.fn(async () => undefined);
      const running = await fixture.connected(testApp([], { stop }));
      await running.call({ kind: "start", reason: "started" });

      expect(await fixture.session!.shutdown(1_000)).toEqual({
        code: 0,
        reason: "Stopped",
      });

      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("doesn't wait for a stop hook that hangs when told to go", async () => {
      const running = await fixture.connected(
        testApp([], { stop: () => new Promise<void>(() => undefined) }),
      );
      await running.call({ kind: "start", reason: "started" });

      expect(await fixture.session!.shutdown(20)).toMatchObject({ code: 0 });
    });

    it("doesn't run its stop hook again once the core called it", async () => {
      const stop = vi.fn(async () => undefined);
      const running = await fixture.connected(testApp([], { stop }));
      await running.call({ kind: "start", reason: "started" });
      await running.call({ kind: "stop", reason: "shutdown" });

      await fixture.session!.shutdown(1_000);

      expect(stop).toHaveBeenCalledTimes(1);
    });
  });
});
