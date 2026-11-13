import { defineAction, type AppDefinition } from "@meetsanctum/app-sdk";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCorePeer, type CorePeer } from "../src/core-peer.js";
import { createRunnerFixture, digest, testApp } from "./runner-fixture.js";

// A runner whose core goes, as when it restarts or updates: the app stops
// there, its process and database stay, and it says hello to the next core,
// which starts it again. Nothing of one connection reaches the next.

const fixture = createRunnerFixture();

const gates = new Map<string, () => void>();
const waits = defineAction({
  id: "runner.wait",
  title: "Wait",
  tier: "read",
  input: z.object({ tag: z.string() }),
  output: z.string(),
  run: async (_ctx, { tag }) => {
    await new Promise<void>((open) => gates.set(tag, open));
    return tag;
  },
});

// The app's container, once its first core has started it.
async function running(
  app: AppDefinition,
  options: { awayWithinMs?: number; stopWithinMs?: number } = {},
) {
  const load = vi.fn(async () => ({ app }));
  fixture.peer = await createCorePeer({ socket: fixture.socket });
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
async function nextCore(): Promise<CorePeer> {
  await fixture.peer!.close();
  fixture.peer = await createCorePeer({ socket: fixture.socket });
  return fixture.peer;
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
    await new Promise((done) => setTimeout(done, 50));

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
