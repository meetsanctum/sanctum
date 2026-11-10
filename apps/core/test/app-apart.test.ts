import {
  ActionError,
  defineAction,
  defineApp,
  defineEvent,
  toStaticManifest,
  type AppContext,
  type AppDefinition,
  type CoreEvent,
} from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { coreSocketName } from "@meetsanctum/app-sdk/protocol";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { sql } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loadApartPackage } from "../src/app-host/loader.js";
import {
  apart,
  base,
  cleanUps,
  running,
  useCleanUps,
} from "./app-apart-support.js";
import { claimed, post, testCore } from "./support.js";

useCleanUps();

describe("an app that runs apart", () => {
  describe("its actions", () => {
    const app = (
      run: (ctx: AppContext) => Promise<{ said: string }> = async () => ({
        said: "hello",
      }),
    ) =>
      defineApp({
        ...base,
        id: "test.apart",
        permissions: [],
        actions: [
          defineAction({
            id: "apart.say",
            title: "Say",
            tier: "write",
            input: z.object({
              name: z.string().refine((name) => name !== "refused"),
            }),
            output: z.object({ said: z.string() }),
            run,
          }),
          defineAction({
            id: "apart.lies",
            title: "Lies",
            tier: "read",
            input: z.object({}),
            output: z.object({ said: z.string() }),
            run: async () => ({ said: "fine" }),
          }),
        ],
      });

    it("runs one for a person through the gate", async () => {
      const run = vi.fn(async (ctx: AppContext) => ({
        said: `hello ${ctx.actor.kind}`,
      }));
      const { core } = await apart(app(run));
      const maya = await claimed(core);
      await running(core, "test.apart");

      const answer = await post(
        core,
        "/api/apps/test.apart/actions/apart.say",
        { name: "Maya" },
        maya,
      );

      expect(answer.statusCode).toBe(200);
      expect(await answer.json()).toEqual({ said: "hello user" });
    });

    it("checks input against the manifest before it crosses", async () => {
      const run = vi.fn(async () => ({ said: "hello" }));
      const { core } = await apart(app(run));
      const maya = await claimed(core);
      await running(core, "test.apart");

      const answer = await post(
        core,
        "/api/apps/test.apart/actions/apart.say",
        { name: 7 },
        maya,
      );

      expect(answer.statusCode).toBe(400);
      expect(run).not.toHaveBeenCalled();
    });

    it("hears when the app's own schema refuses what the manifest allows", async () => {
      const run = vi.fn(async () => ({ said: "hello" }));
      const { core } = await apart(app(run));
      const maya = await claimed(core);
      await running(core, "test.apart");

      const answer = await post(
        core,
        "/api/apps/test.apart/actions/apart.say",
        { name: "refused" },
        maya,
      );

      expect(answer.statusCode).toBe(400);
      expect(run).not.toHaveBeenCalled();
    });

    it("checks what an action answers against the manifest", async () => {
      const lying = defineApp({
        ...base,
        id: "test.lying",
        permissions: [],
        actions: [
          defineAction({
            id: "lying.read",
            title: "Read",
            tier: "read",
            input: z.object({}),
            output: z.object({ count: z.number() }),
            run: async () => ({ count: 1 }),
          }),
        ],
      });
      const { core } = await apart(
        {
          ...lying,
          actions: lying.actions.map((action) => ({
            ...action,
            output: z.unknown(),
            run: async () => ({ count: "many" }),
          })),
        } as AppDefinition,
        {},
        lying,
      );
      const maya = await claimed(core);
      await running(core, "test.lying");

      const answer = await post(
        core,
        "/api/apps/test.lying/actions/lying.read",
        {},
        maya,
      );

      expect(answer.statusCode).toBe(500);
    });

    it("keeps a refusal's code", async () => {
      const { core } = await apart(
        app(
          vi.fn(async () => {
            throw new ActionError("conflict");
          }),
        ),
      );
      const maya = await claimed(core);
      await running(core, "test.apart");

      const answer = await post(
        core,
        "/api/apps/test.apart/actions/apart.say",
        { name: "Maya" },
        maya,
      );

      expect(answer.statusCode).toBe(409);
    });
  });

  describe("what it may do", () => {
    it("is refused what it doesn't hold, by the core", async () => {
      const app = defineApp({
        ...base,
        id: "test.nosy",
        permissions: [],
        actions: [
          defineAction({
            id: "nosy.read",
            title: "Read",
            tier: "read",
            input: z.object({}),
            output: z.unknown(),
            run: (ctx) => ctx.people.list(),
          }),
        ],
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, "test.nosy");

      const answer = await post(
        core,
        "/api/apps/test.nosy/actions/nosy.read",
        {},
        maya,
      );

      expect(answer.statusCode).toBe(500);
      expect(core.logs.join("\n")).toContain("does not hold people.read");
    });

    it("gets what it holds", async () => {
      const app = defineApp({
        ...base,
        id: "test.reads",
        permissions: [{ id: "people.read", reason: "For the test." }],
        actions: [
          defineAction({
            id: "reads.people",
            title: "Read",
            tier: "read",
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => (await ctx.people.list()).length,
          }),
        ],
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, "test.reads");

      const answer = await post(
        core,
        "/api/apps/test.reads/actions/reads.people",
        {},
        maya,
      );

      expect(await answer.json()).toBe(1);
    });

    it("stops and starts in its container as its grants change", async () => {
      const seen: string[] = [];
      const app = defineApp({
        ...base,
        id: "test.grants",
        permissions: [
          { id: "people.read", reason: "For the test.", needed: true },
        ],
        actions: [],
        start: async () => void seen.push("start"),
        stop: async () => void seen.push("stop"),
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, app.id);
      const grant = (granted: boolean) =>
        core.apps.setPermission({
          principal: core.auth.clients.authenticate(maya.token)!,
          appId: app.id,
          permission: "people.read",
          granted,
        });

      await grant(false);
      await vi.waitFor(() => expect(seen).toEqual(["start", "stop"]));
      expect(core.apps.isRunning(app.id)).toBe(false);

      await grant(true);
      await vi.waitFor(() => expect(seen).toEqual(["start", "stop", "start"]));
      await running(core, app.id);
    });

    it("emits only once an action has succeeded", async () => {
      const said = defineEvent({
        id: "emits.said",
        payload: z.object({ word: z.string() }),
      });
      const app = defineApp({
        ...base,
        id: "test.emits",
        permissions: [],
        events: [said],
        actions: [
          defineAction({
            id: "emits.fails",
            title: "Fails",
            tier: "write",
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              await ctx.events.emit(said, { word: "failed" });
              throw new Error("It broke");
            },
          }),
          defineAction({
            id: "emits.works",
            title: "Works",
            tier: "write",
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              await ctx.events.emit(said, { word: "worked" });
            },
          }),
        ],
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, app.id);
      const handedOn = vi.spyOn(core.workflows, "appEvent");

      expect(
        (await post(core, "/api/apps/test.emits/actions/emits.fails", {}, maya))
          .statusCode,
      ).toBe(500);
      expect(handedOn).not.toHaveBeenCalled();
      expect(
        (await post(core, "/api/apps/test.emits/actions/emits.works", {}, maya))
          .statusCode,
      ).toBe(200);

      expect(handedOn.mock.calls.map(([event]) => event.payload)).toEqual([
        { word: "worked" },
      ]);
    });

    it("can't emit what isn't in its manifest", async () => {
      const unlisted = defineEvent({
        id: "strays.said",
        payload: z.object({}),
      });
      const app = defineApp({
        ...base,
        id: "test.strays",
        permissions: [],
        actions: [
          defineAction({
            id: "strays.emits",
            title: "Emits",
            tier: "write",
            input: z.object({}),
            output: z.unknown(),
            run: (ctx) => ctx.events.emit(unlisted, {}),
          }),
        ],
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, app.id);

      expect(
        (
          await post(
            core,
            "/api/apps/test.strays/actions/strays.emits",
            {},
            maya,
          )
        ).statusCode,
      ).toBe(500);
      expect(core.logs.join("\n")).toContain("has no event strays.said");
    });
  });

  describe("its start", () => {
    it("reads one home however often it reads, and hears what changed from then", async () => {
      const releases: (() => void)[] = [];
      const reads: string[][] = [];
      const heard: CoreEvent[] = [];
      const app = defineApp({
        ...base,
        id: "test.snapshot",
        permissions: [{ id: "places.read", reason: "For the test." }],
        actions: [],
        start: async (ctx) => {
          reads.push((await ctx.places.list()).rooms.map(({ name }) => name));
          await new Promise<void>((done) => releases.push(done));
          // It follows only now, after the room was added.
          await ctx.events.on("place.added", async (event) => {
            heard.push(event);
          });
          reads.push((await ctx.places.list()).rooms.map(({ name }) => name));
        },
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await vi.waitFor(() => expect(releases).toHaveLength(1));

      await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
      releases[0]!();

      await vi.waitFor(() => expect(heard).toHaveLength(1));
      expect(reads).toEqual([[], []]);
      expect(heard[0]).toMatchObject({
        name: "place.added",
        place: { name: "Office" },
      });
    });

    it("reads the home as it is again once it has started", async () => {
      const app = defineApp({
        ...base,
        id: "test.live",
        permissions: [{ id: "places.read", reason: "For the test." }],
        actions: [
          defineAction({
            id: "live.rooms",
            title: "Rooms",
            tier: "read",
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) =>
              (await ctx.places.list()).rooms.map(({ name }) => name),
          }),
        ],
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, app.id);

      await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
      const answer = await post(
        core,
        "/api/apps/test.live/actions/live.rooms",
        {},
        maya,
      );

      expect(await answer.json()).toEqual(["Office"]);
    });

    it("holds nothing back for what it doesn't follow, and hears nothing of it", async () => {
      const heard: string[] = [];
      const app = defineApp({
        ...base,
        id: "test.follows",
        permissions: [{ id: "places.read", reason: "For the test." }],
        actions: [],
        start: async (ctx) => {
          await ctx.events.on("place.changed", async (event) => {
            heard.push(event.name);
          });
        },
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, app.id);

      await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
      await new Promise((done) => setTimeout(done, 30));

      expect(heard).toEqual([]);
    });

    it("hears its own settings change, needing no permission", async () => {
      const heard: CoreEvent[] = [];
      const app = defineApp({
        ...base,
        id: "test.tuned",
        permissions: [],
        settings: z.object({
          days: z.number().int().min(1).default(7).meta({ title: "Days" }),
        }),
        actions: [],
        start: async (ctx) => {
          await ctx.events.on("settings.changed", async (event) => {
            heard.push(event);
          });
        },
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, app.id);

      await post(
        core,
        `/api/apps/${app.id}/settings/update`,
        { days: 3 },
        maya,
      );

      await vi.waitFor(() =>
        expect(heard).toEqual([
          {
            name: "settings.changed",
            settings: { days: 3 },
            before: { days: 7 },
          },
        ]),
      );
    });

    it("hears events in order, one at a time, after its start", async () => {
      const order: string[] = [];
      let handling = 0;
      let most = 0;
      const app = defineApp({
        ...base,
        id: "test.order",
        permissions: [{ id: "places.read", reason: "For the test." }],
        actions: [],
        start: async (ctx) => {
          await ctx.events.on("place.added", async (event) => {
            handling += 1;
            most = Math.max(most, handling);
            await new Promise((done) => setTimeout(done, 5));
            order.push((event.place as { name: string }).name);
            handling -= 1;
          });
        },
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await running(core, app.id);

      for (const name of ["One", "Two", "Three"]) {
        await post(core, "/api/places/rooms/add", { name }, maya);
      }

      await vi.waitFor(() => expect(order).toEqual(["One", "Two", "Three"]));
      expect(most).toBe(1);
    });

    it("holds its calls until it has started", async () => {
      let release!: () => void;
      const seen: string[] = [];
      const app = defineApp({
        ...base,
        id: "test.waits",
        permissions: [],
        actions: [
          defineAction({
            id: "waits.act",
            title: "Act",
            tier: "read",
            input: z.object({}),
            output: z.unknown(),
            run: async () => void seen.push("action"),
          }),
        ],
        start: async () => {
          await new Promise<void>((done) => (release = done));
          seen.push("started");
        },
      });
      const { core } = await apart(app);
      const maya = await claimed(core);
      await vi.waitFor(() => expect(release).toBeDefined());

      const answer = post(
        core,
        "/api/apps/test.waits/actions/waits.act",
        {},
        maya,
      );
      await new Promise((done) => setTimeout(done, 20));
      expect(seen).toEqual([]);
      release();

      expect((await answer).statusCode).toBe(200);
      expect(seen).toEqual(["started", "action"]);
    });
  });

  describe("its connection", () => {
    const app = (seen: string[]) =>
      defineApp({
        ...base,
        id: "test.conn",
        permissions: [],
        actions: [
          defineAction({
            id: "conn.act",
            title: "Act",
            tier: "read",
            input: z.object({}),
            output: z.unknown(),
            run: async () => "ran",
          }),
        ],
        start: async () => void seen.push("start"),
        stop: async () => void seen.push("stop"),
      });

    it("isn't there until it connects, and calls say so", async () => {
      const definition = app([]);
      const folder = await mkdtemp(join(tmpdir(), "sanctum-apart-"));
      cleanUps.push(() => rm(folder, { recursive: true, force: true }));
      const text = JSON.stringify(toStaticManifest(definition));
      const core = await testCore({
        appSockets: folder,
        // A call waits for an app on its way, as long as a call may.
        appTimeoutMs: 50,
        apart: [
          {
            apart: {
              manifest: JSON.parse(text),
              digest: manifestDigest(text),
              folder: "1.0.0+test",
            },
            origin: "official",
          },
        ],
      });
      cleanUps.push(() => core.apps.close());
      const maya = await claimed(core);

      expect(core.apps.isRunning(definition.id)).toBe(false);
      expect(
        core.apps.list().find(({ id }) => id === definition.id)?.state,
      ).toBe("starting");
      expect(
        (await post(core, "/api/apps/test.conn/actions/conn.act", {}, maya))
          .statusCode,
      ).toBe(503);
    });

    it("stops the app when it goes, and starts it when another connects", async () => {
      const seen: string[] = [];
      const { core, session, reconnect } = await apart(app(seen), {
        appTimeoutMs: 50,
      });
      const maya = await claimed(core);
      await running(core, "test.conn");
      const states: string[] = [];
      const unsubscribe = core.auth.connections.add(
        core.auth.clients.authenticate(maya.token)!,
        {
          close() {},
          send(message) {
            const update = JSON.parse(String(message));
            if (update.type === "app" && update.app.id === "test.conn") {
              states.push(update.app.state);
            }
          },
        },
      );
      cleanUps.push(async () => unsubscribe());

      await session.shutdown(100);
      await vi.waitFor(() =>
        expect(core.apps.isRunning("test.conn")).toBe(false),
      );
      expect(["restarting", "starting"]).toContain(
        core.apps.list().find(({ id }) => id === "test.conn")?.state,
      );
      expect(states).toContain("restarting");
      expect(seen).toEqual(["start", "stop"]);
      expect(
        (await post(core, "/api/apps/test.conn/actions/conn.act", {}, maya))
          .statusCode,
      ).toBe(503);

      reconnect();

      await running(core, "test.conn");
      await vi.waitFor(() => expect(states.at(-1)).toBe("running"));
      expect(seen).toEqual(["start", "stop", "start"]);
      expect(
        (await post(core, "/api/apps/test.conn/actions/conn.act", {}, maya))
          .statusCode,
      ).toBe(200);
    });

    it("refuses a version other than the one it expects, and keeps the app stopped", async () => {
      const seen: string[] = [];
      const definition = app(seen);
      const { core, session, folder } = await apart(definition);
      await running(core, definition.id);
      await session.shutdown(100);
      await vi.waitFor(() =>
        expect(core.apps.isRunning(definition.id)).toBe(false),
      );

      const other = runSession({
        appId: definition.id,
        socket: join(folder, definition.id, coreSocketName),
        database: join(folder, "other.db"),
        package: {
          version: "9.9.9",
          manifest: "d".repeat(64),
          load: async () => ({ app: definition }),
        },
      });

      expect(await other.finished).toMatchObject({
        code: 1,
        reason: expect.stringContaining("expects 1.0.0"),
      });
      expect(core.apps.isRunning(definition.id)).toBe(false);
    });
  });

  describe("its package", () => {
    it("is read from the folder of the version it runs, importing nothing", async () => {
      const folder = await mkdtemp(join(tmpdir(), "sanctum-packages-"));
      cleanUps.push(() => rm(folder, { recursive: true, force: true }));
      const staged = join(folder, "test.apart", "1.0.0+abc");
      await mkdir(staged, { recursive: true });
      const text = JSON.stringify({ id: "test.apart", version: "1.0.0" });
      await writeFile(join(staged, "sanctum-app.json"), text);

      expect(
        await loadApartPackage(folder, "test.apart", "1.0.0+abc", "official"),
      ).toEqual({
        apart: {
          manifest: { id: "test.apart", version: "1.0.0" },
          digest: manifestDigest(text),
          folder: "1.0.0+abc",
        },
        origin: "official",
      });
      await expect(
        loadApartPackage(folder, "test.other", "1.0.0+abc", "official"),
      ).rejects.toThrow("ENOENT");
    });

    it("refuses a folder holding another app", async () => {
      const folder = await mkdtemp(join(tmpdir(), "sanctum-packages-"));
      cleanUps.push(() => rm(folder, { recursive: true, force: true }));
      const staged = join(folder, "test.apart", "1.0.0+abc");
      await mkdir(staged, { recursive: true });
      await writeFile(
        join(staged, "sanctum-app.json"),
        JSON.stringify({ id: "test.other", version: "1.0.0" }),
      );

      await expect(
        loadApartPackage(folder, "test.apart", "1.0.0+abc", "official"),
      ).rejects.toThrow("holds test.other");
    });
  });

  // Its database stays on its side: nothing crosses for a statement.
  it("runs its own statements in its own database", async () => {
    const app = defineApp({
      ...base,
      id: "test.db",
      permissions: [],
      actions: [
        defineAction({
          id: "db.count",
          title: "Count",
          tier: "read",
          input: z.object({}),
          output: z.unknown(),
          run: async (ctx) =>
            ctx.storage.db.all(sql`select 1 as one`) as Promise<unknown>,
        }),
      ],
    });
    const { core } = await apart(app);
    const maya = await claimed(core);
    await running(core, app.id);

    const answer = await post(
      core,
      "/api/apps/test.db/actions/db.count",
      {},
      maya,
    );

    expect(await answer.json()).toEqual([[1]]);
  });
});
