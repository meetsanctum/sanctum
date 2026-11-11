import { defineApp } from "@meetsanctum/app-sdk";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { claimed, post, testCore } from "./support.js";

// An app's starts and stops racing its grants: a pause that arrives while a
// resumed start is still running ends what that start set going at once and
// lets none of its queued events through, and removing or closing waits for a
// stop hook still running before the app's storage closes.

function hold<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ending an app while it pauses", () => {
  it("drops queued events when it pauses during a resumed start", async () => {
    const stopping = hold<void>();
    const starting = hold<void>();
    const release = hold<void>();
    const heard: string[] = [];
    let isRestart = false;
    const app = defineApp({
      id: "test.events",
      name: "Events",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [
        { id: "people.read", reason: "For the test.", needed: true },
        { id: "places.read", reason: "For the test." },
      ],
      actions: [],
      events: [],
      async start(ctx) {
        await ctx.events.on("place.added", async (event) => {
          heard.push(event.name);
        });
        if (isRestart) {
          starting.resolve();
          await release.promise;
        }
        isRestart = true;
      },
      async stop() {
        stopping.resolve();
      },
    });
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);
    const grant = (granted: boolean) =>
      core.apps.setPermission({
        principal: core.auth.clients.authenticate(maya.token)!,
        appId: app.id,
        permission: "people.read",
        granted,
      });
    await grant(false);
    await stopping.promise;
    await grant(true);
    await starting.promise;
    await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
    await grant(false);
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await core.apps.remove(app.id);

    expect(heard).toEqual([]);
  });

  it("aborts requests as soon as it pauses during a resumed start", async () => {
    const stopping = hold<void>();
    const requested = hold<AbortSignal>();
    const release = hold<void>();
    let isRestart = false;
    const app = defineApp({
      id: "test.starting",
      name: "Starting",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [
        { id: "places.read", reason: "For the test.", needed: true },
        { id: "net:api.example.com", reason: "For the test." },
      ],
      actions: [],
      events: [],
      async start(ctx) {
        if (isRestart) await ctx.net.fetch({ url: "https://api.example.com" });
        isRestart = true;
      },
      async stop() {
        stopping.resolve();
      },
    });
    const core = await testCore({
      apps: [{ app, origin: "official" }],
      fetch: async (_url, init) => {
        requested.resolve(init!.signal!);
        await release.promise;
        return new Response("{}");
      },
    });
    const maya = await claimed(core);
    const grant = (granted: boolean) =>
      core.apps.setPermission({
        principal: core.auth.clients.authenticate(maya.token)!,
        appId: app.id,
        permission: "places.read",
        granted,
      });
    await grant(false);
    await stopping.promise;
    await grant(true);
    const signal = await requested.promise;
    await grant(false);
    await new Promise((resolve) => setImmediate(resolve));
    const isAborted = signal.aborted;
    release.resolve();
    await core.apps.remove(app.id);

    expect(isAborted).toBe(true);
  });

  it("remove lets a resumed start end before its stop hook runs", async () => {
    const stopped = hold<void>();
    const starting = hold<void>();
    const release = hold<void>();
    const said: string[] = [];
    let isRestart = false;
    const app = defineApp({
      id: "test.resuming",
      name: "Resuming",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [
        { id: "places.read", reason: "For the test.", needed: true },
      ],
      actions: [],
      events: [],
      async start() {
        if (isRestart) {
          starting.resolve();
          await release.promise;
          said.push("started");
        }
        isRestart = true;
      },
      async stop() {
        said.push("stop");
        stopped.resolve();
      },
    });
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const maya = await claimed(core);
    const grant = (granted: boolean) =>
      core.apps.setPermission({
        principal: core.auth.clients.authenticate(maya.token)!,
        appId: app.id,
        permission: "places.read",
        granted,
      });
    await grant(false);
    await stopped.promise;
    await grant(true);
    await starting.promise;

    const removing = core.apps.remove(app.id);
    await new Promise((resolve) => setImmediate(resolve));
    const saidWhileStarting = [...said];
    release.resolve();
    await removing;

    expect(saidWhileStarting).toEqual(["stop"]);
    expect(said).toEqual(["stop", "started", "stop"]);
  });

  it.each(["remove", "close"] as const)(
    "%s waits for the stop hook before closing storage",
    async (operation) => {
      const stopping = hold<void>();
      const release = hold<void>();
      let hasRead = false;
      const app = defineApp({
        id: "test.lifecycle",
        name: "Lifecycle",
        version: "0.1.0",
        core: "^1.0.0",
        permissions: [
          { id: "places.read", reason: "For the test.", needed: true },
        ],
        actions: [],
        events: [],
        async stop(ctx) {
          stopping.resolve();
          await release.promise;
          await ctx.storage.db.get(sql`SELECT 1`);
          hasRead = true;
        },
      });
      const core = await testCore({ apps: [{ app, origin: "official" }] });
      const maya = await claimed(core);
      await core.apps.setPermission({
        principal: core.auth.clients.authenticate(maya.token)!,
        appId: app.id,
        permission: "places.read",
        granted: false,
      });
      await stopping.promise;

      let hasEnded = false;
      const ending = (
        operation === "remove" ? core.apps.remove(app.id) : core.apps.close()
      ).then(() => {
        hasEnded = true;
      });
      // Neither operation may finish while the hook still owns storage.
      await new Promise((resolve) => setImmediate(resolve));
      const hasEndedBeforeHook = hasEnded;
      release.resolve();
      await ending;
      await new Promise((resolve) => setImmediate(resolve));

      expect(hasEndedBeforeHook).toBe(false);
      expect(hasRead).toBe(true);
      expect(core.logs.join("\n")).not.toContain("did not stop");
    },
  );
});
