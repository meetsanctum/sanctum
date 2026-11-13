import {
  defineAction,
  type AppContext,
  type AppDefinition,
} from "@meetsanctum/app-sdk";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCorePeer,
  type CorePeer,
  type PeerCalls,
} from "../src/core-peer.js";
import { createRunnerFixture, digest, testApp } from "./runner-fixture.js";

// A runner whose core goes, as when it restarts or updates: the app stops
// there, its process and database stay, and it says hello to the next core,
// which starts it again. Nothing of one connection reaches the next.

const fixture = createRunnerFixture();

const gates = new Map<string, () => void>();
// The calls whose work has finished, so their answers are on their way.
const finished = new Set<string>();
const waits = defineAction({
  id: "runner.wait",
  title: "Wait",
  tier: "read",
  input: z.object({ tag: z.string() }),
  output: z.string(),
  run: async (_ctx, { tag }) => {
    await new Promise<void>((open) => gates.set(tag, open));
    finished.add(tag);
    return tag;
  },
});

// The app's container, once its first core has started it.
async function running(
  app: AppDefinition,
  options: {
    awayWithinMs?: number;
    stopWithinMs?: number;
    resumeWithinMs?: number;
  } = {},
  calls: PeerCalls = {},
) {
  const load = vi.fn(async () => ({ app }));
  fixture.peer = await createCorePeer({ socket: fixture.socket, calls });
  fixture.session = runSession({
    appId: app.id,
    socket: fixture.socket,
    database: fixture.database,
    package: { version: app.version, manifest: digest, load },
    ...options,
  });
  await fixture.peer.hello;
  fixture.peer.welcome();
  await fixture.peer.prepared;
  expect(
    await fixture.peer.call({ kind: "start", reason: "started" }),
  ).toMatchObject({ ok: true });
  return { load };
}

// The core goes, and the next one listens on the same socket.
async function nextCore(calls: PeerCalls = {}): Promise<CorePeer> {
  await fixture.peer!.close();
  fixture.peer = await createCorePeer({ socket: fixture.socket, calls });
  return fixture.peer;
}

// The next core, once it has the app's connection ready.
async function readyNextCore(calls: PeerCalls = {}) {
  const next = await nextCore(calls);
  await next.hello;
  next.welcome();
  await next.prepared;
  return next;
}

describe("an app's runner when the core goes", () => {
  it("stops the app as for a restart, and is ready at once for the next core", async () => {
    const seen: string[] = [];
    const { load } = await running(
      testApp([], {
        start: async (_ctx, info) => void seen.push(`start ${info.reason}`),
        stop: async (_ctx, info) => void seen.push(`stop ${info.reason}`),
      }),
    );

    const next = await nextCore();
    await vi.waitFor(() => expect(seen.at(-1)).toBe("stop restarting"));
    await next.hello;
    next.welcome();

    expect(await next.prepared).toEqual({ ready: true });
    expect(await next.call({ kind: "start", reason: "started" })).toMatchObject(
      { ok: true },
    );
    expect(seen).toEqual(["start started", "stop restarting", "start started"]);
    // Its package loaded and its database opened once, in the one process.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("answers nothing of one core's calls to the next, whose calls have the same ids", async () => {
    await running(testApp([waits]));
    const old = fixture.peer!.issue({
      kind: "action",
      action: "runner.wait",
      input: { tag: "old" },
    });
    await vi.waitFor(() => expect(gates.has("old")).toBe(true));

    const next = await nextCore();
    await next.hello;
    next.welcome();
    await next.prepared;
    await next.call({ kind: "start", reason: "started" });
    const now = next.issue({
      kind: "action",
      action: "runner.wait",
      input: { tag: "new" },
    });
    await vi.waitFor(() => expect(gates.has("new")).toBe(true));
    expect(now.id).toBe(old.id);
    gates.get("old")!();
    await vi.waitFor(() => expect(finished.has("old")).toBe(true));
    // Whatever the runner sent for it has arrived by the heartbeat's answer.
    await next.beat();

    expect(next.answered.has(now.id)).toBe(false);
    expect(next.lateAnswers).toEqual([]);
    gates.get("new")!();
    expect(await now.answer).toEqual({ ok: true, value: "new" });
  });

  it("fails the app's calls at once while no core is there", async () => {
    let failure: unknown;
    await running(
      testApp([], {
        stop: async (ctx) => {
          failure = await ctx.places.list().catch((error: unknown) => error);
        },
      }),
    );

    await fixture.peer!.close();

    await vi.waitFor(() => expect(failure).toBeInstanceOf(Error));
    expect(String(failure)).toContain("connection to the core has gone");
  });

  it("discards calls still waiting for a start when the core goes", async () => {
    let finishStart!: () => void;
    const started = new Promise<void>((done) => (finishStart = done));
    const run = vi.fn(async () => "done");
    const app = testApp([{ ...waits, run }], { start: async () => started });
    await fixture.connected(app);
    fixture.peer!.issue({ kind: "start", reason: "started" });
    fixture.peer!.issue({
      kind: "action",
      action: waits.id,
      input: { tag: "old" },
    });
    // A heartbeat is handled after both calls have reached the runner.
    await fixture.peer!.beat();
    const next = await nextCore();
    await new Promise((done) => setTimeout(done, 50));
    finishStart();
    await next.hello;
    next.welcome();
    await next.prepared;
    await next.call({ kind: "start", reason: "started" });

    expect(run).not.toHaveBeenCalled();
    expect(next.requests).toEqual([]);
  });

  it("discards remaining event handlers when their core goes", async () => {
    let finishHandler!: () => void;
    const blocked = new Promise<void>((done) => (finishHandler = done));
    const first = vi.fn(async () => blocked);
    const second = vi.fn(async () => undefined);
    await fixture.connected(
      testApp([], {
        start: async (ctx) => {
          await ctx.events.on("place.changed", first);
          await ctx.events.on("place.changed", second);
        },
      }),
      { follow: async () => undefined },
    );
    await fixture.peer!.call({ kind: "start", reason: "started" });
    fixture.peer!.issue({
      kind: "event",
      event: { name: "place.changed" } as never,
    });
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));

    const next = await nextCore();
    await next.hello;
    next.welcome();
    await next.prepared;
    finishHandler();
    await new Promise((done) => setTimeout(done, 50));

    expect(second).not.toHaveBeenCalled();
    expect(next.requests).toEqual([]);
  });

  it("waits for the next core's start even when the previous core never started it", async () => {
    let finishStart!: () => void;
    const started = new Promise<void>((done) => (finishStart = done));
    const run = vi.fn(async () => "done");
    await fixture.connected(
      testApp([{ ...waits, run }], {
        start: async () => started,
      }),
    );

    const next = await nextCore();
    await next.hello;
    next.welcome();
    await next.prepared;
    const starting = next.issue({ kind: "start", reason: "started" });
    const action = next.issue({
      kind: "action",
      action: waits.id,
      input: { tag: "new" },
    });
    await next.beat();

    expect(run).not.toHaveBeenCalled();
    finishStart();
    expect(await starting.answer).toMatchObject({ ok: true });
    expect(await action.answer).toMatchObject({ ok: true, value: "done" });
  });

  it("ends when no core comes back in time", async () => {
    await running(testApp(), { awayWithinMs: 50 });

    await fixture.peer!.close();

    expect(await fixture.session!.finished).toMatchObject({
      code: 1,
      reason: expect.stringContaining("could not reach the core"),
    });
  });

  it("ends when its stop doesn't finish once the core has gone", async () => {
    await running(
      testApp([], { stop: () => new Promise<void>(() => undefined) }),
      { stopWithinMs: 50 },
    );

    await fixture.peer!.close();

    expect(await fixture.session!.finished).toMatchObject({
      code: 1,
      reason: expect.stringContaining("didn't stop in time"),
    });
  });

  it("ends when the next core refuses it", async () => {
    await running(testApp());

    const next = await nextCore();
    await next.hello;
    next.refuse("it is version 1.2.3, and this core expects 1.3.0");

    expect(await fixture.session!.finished).toMatchObject({
      code: 1,
      reason: expect.stringContaining("expects 1.3.0"),
    });
  });
});

describe("an app with a resume when the core goes", () => {
  const home = { home: { id: "home" }, floors: [], rooms: [], zones: [] };
  // An app that follows the home's changes, and whose start's context the test
  // keeps, as an app's loops do.
  function resumable(
    seen: string[],
    hooks: { resume?: () => Promise<void> } = {},
  ) {
    let kept: AppContext | undefined;
    const app = testApp([], {
      start: async (ctx, info) => {
        kept = ctx;
        seen.push(`start ${info.reason}`);
        await ctx.events.on("place.changed", async () => {
          seen.push("place.changed");
        });
      },
      resume: async (_ctx, info) => {
        seen.push(`resume ${info.reason}`);
        await hooks.resume?.();
      },
      stop: async (_ctx, info) => void seen.push(`stop ${info.reason}`),
    });
    return { app, ctx: () => kept! };
  }

  it("goes on, its calls failing meanwhile, and resumes for the next core", async () => {
    const seen: string[] = [];
    const { app, ctx } = resumable(seen);
    const { load } = await running(app, {}, { follow: async () => undefined });

    await fixture.peer!.close();
    await vi.waitFor(async () =>
      expect(await ctx().places.list().catch(String)).toContain(
        "connection to the core has gone",
      ),
    );
    const next = await readyNextCore({
      follow: async () => undefined,
      places: async () => home as never,
    });
    const started = next.issue({ kind: "start", reason: "started" });

    expect(await started.answer).toMatchObject({ ok: true });
    expect(seen).toEqual(["start started", "resume started"]);
    // What it followed, followed again by the start it resumed in.
    expect(next.requests).toContainEqual({
      call: started.id,
      method: "follow",
      params: ["place.changed"],
    });
    // Its start's context goes on, now as the next core's.
    expect(await ctx().places.list()).toEqual(home);
    await next.call({
      kind: "event",
      event: { name: "place.changed" } as never,
    });
    expect(seen.at(-1)).toBe("place.changed");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts afresh, once what ran has stopped, for a start that isn't a restart", async () => {
    const seen: string[] = [];
    await running(resumable(seen).app, {}, { follow: async () => undefined });
    await fixture.peer!.close();
    const next = await readyNextCore({ follow: async () => undefined });

    expect(
      await next.call({ kind: "start", reason: "updated", from: "1.2.2" }),
    ).toMatchObject({ ok: true });

    expect(seen).toEqual(["start started", "stop restarting", "start updated"]);
  });

  it("stops when its resume fails, so the next start begins afresh", async () => {
    const seen: string[] = [];
    const { app } = resumable(seen, {
      resume: async () => {
        throw new Error("It can't catch up");
      },
    });
    await running(app, {}, { follow: async () => undefined });
    await fixture.peer!.close();
    const next = await readyNextCore({ follow: async () => undefined });

    expect(await next.call({ kind: "start", reason: "started" })).toMatchObject(
      { ok: false, message: expect.stringContaining("catch up") },
    );
    expect(await next.call({ kind: "start", reason: "started" })).toMatchObject(
      { ok: true },
    );

    expect(seen).toEqual([
      "start started",
      "resume started",
      "stop restarting",
      "start started",
    ]);
  });

  it("stops when the next core doesn't start it in time, as one it keeps stopped", async () => {
    const seen: string[] = [];
    await running(
      resumable(seen).app,
      { resumeWithinMs: 50 },
      { follow: async () => undefined },
    );
    await fixture.peer!.close();

    await readyNextCore();

    await vi.waitFor(() => expect(seen.at(-1)).toBe("stop restarting"));
    expect(seen).toEqual(["start started", "stop restarting"]);
  });
});
