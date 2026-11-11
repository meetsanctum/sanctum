import {
  defineApp,
  registerPermission,
  toStaticManifest,
  type AppDefinition,
} from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import {
  coreCallMethods,
  coreSocketName,
  createMessageReader,
  protocolVersion,
  type CoreMessage,
} from "@meetsanctum/app-sdk/protocol";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { appVersions } from "../src/app-host/schema.js";
import { base, cleanUps, useCleanUps } from "./app-apart-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

useCleanUps();

// The core's end with the real core behind it and no runner in the way: whatever
// an app's own code sends down its socket.
describe("what arrives on an app's socket", () => {
  const nosy = defineApp({
    ...base,
    id: "test.socket",
    permissions: [],
    actions: [],
  });
  const driver = defineApp({
    ...base,
    id: "test.socket",
    permissions: [
      { id: registerPermission, reason: "For the test." },
      { id: "people.read", reason: "For the test." },
      { id: "places.read", reason: "For the test." },
      { id: "places.location", reason: "For the test." },
      { id: "devices.read:light", reason: "For the test." },
      { id: "devices.control:light", reason: "For the test." },
      { id: "workflows.manage", reason: "For the test." },
    ],
    actions: [],
    driver: { command: async () => undefined },
  });

  // The app as the socket sees it, past saying hello: it has its start's call.
  async function onSocket(app: AppDefinition, dataDir?: string) {
    const folder = await mkdtemp(join(tmpdir(), "sanctum-apart-"));
    cleanUps.push(() => rm(folder, { recursive: true, force: true }));
    const text = JSON.stringify(toStaticManifest(app));
    const core = await testCore({
      ...(dataDir ? { dataDir } : {}),
      appSockets: folder,
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
    const socket = connect(join(folder, app.id, coreSocketName));
    cleanUps.push(async () => void socket.destroy());
    socket.on("error", () => undefined);
    const heard: CoreMessage[] = [];
    socket.on(
      "data",
      createMessageReader({
        message: (value) => heard.push(value as CoreMessage),
        violation: () => undefined,
      }),
    );
    const say = (message: unknown) =>
      socket.write(`${JSON.stringify(message)}\n`);
    say({
      type: "hello",
      protocol: protocolVersion,
      app: app.id,
      version: app.version,
      manifest: manifestDigest(text),
    });
    await vi.waitFor(() => expect(heard[0]?.type).toBe("welcome"));
    say({ type: "ready" });
    await vi.waitFor(() =>
      expect(heard.some(({ type }) => type === "call")).toBe(true),
    );
    const start = heard.find((message) => message.type === "call") as Extract<
      CoreMessage,
      { type: "call" }
    >;
    let last = 0;
    return {
      core,
      start,
      say,
      heard,
      async ask(method: string, params: unknown[] = []) {
        last += 1;
        const id = last;
        say({ type: "request", id, call: start.id, method, params });
        await vi.waitFor(
          () =>
            expect(
              heard.some(
                (message) => message.type === "reply" && message.id === id,
              ),
            ).toBe(true),
          { interval: 2 },
        );
        return (
          heard.find(
            (message) => message.type === "reply" && message.id === id,
          ) as Extract<CoreMessage, { type: "reply" }>
        ).outcome;
      },
    };
  }

  describe("after a change of version", () => {
    // A core that last ran an older version of it.
    const updating = async () => {
      const before = await testCore();
      before.db
        .insert(appVersions)
        .values({
          appId: nosy.id,
          version: "0.9.0",
          startedAt: new Date(),
        })
        .run();
      return onSocket(nosy, before.dataDir);
    };
    const versionOf = (core: TestCore) =>
      core.db.select().from(appVersions).get()?.version;
    const answer = (
      { say, start }: Awaited<ReturnType<typeof updating>>,
      value?: unknown,
    ) =>
      say({
        type: "answer",
        call: start.id,
        outcome: { ok: true, ...(value === undefined ? {} : { value }) },
      });
    const updateOf = ({ start }: Awaited<ReturnType<typeof updating>>) =>
      (start.body as { update: string }).update;

    it("names the update it asks the app to commit", async () => {
      const socket = await updating();

      expect(socket.start.body).toMatchObject({
        kind: "start",
        reason: "updated",
        from: "0.9.0",
        update: expect.any(String),
      });
    });

    it("commits when the app says this update's data is on the disk", async () => {
      const socket = await updating();

      answer(socket, { synced: updateOf(socket) });

      await vi.waitFor(() => expect(versionOf(socket.core)).toBe("1.0.0"));
      expect(socket.core.db.select().from(appVersions).get()?.updateId).toBe(
        updateOf(socket),
      );
    });

    it.each([
      ["says nothing of its data", undefined],
      ["names another update", { synced: "another" }],
      ["says something else", "synced"],
    ])("doesn't commit when it %s", async (_how, value) => {
      const socket = await updating();

      answer(socket, value);
      await vi.waitFor(() =>
        expect(socket.core.logs.join()).toContain(
          "didn't say its data is on the disk",
        ),
      );

      expect(versionOf(socket.core)).toBe("0.9.0");
    });

    it("sweeps nothing when it doesn't commit", async () => {
      const socket = await updating();
      socket.core.entities.publish(nosy.id, {
        type: "test.note",
        key: "kept",
        name: "Kept",
        state: {},
      });

      answer(socket);
      await vi.waitFor(() =>
        expect(socket.core.logs.join()).toContain(
          "didn't say its data is on the disk",
        ),
      );

      expect(socket.core.entities.list({ app: nosy.id })).toHaveLength(1);
    });

    it("counts what the app claims, whatever it says of itself", async () => {
      const socket = await updating();
      socket.core.entities.publish(nosy.id, {
        type: "test.note",
        key: "unclaimed",
        name: "Unclaimed",
        state: {},
      });

      answer(socket, { synced: updateOf(socket) });
      await vi.waitFor(() => expect(versionOf(socket.core)).toBe("1.0.0"));

      expect(socket.core.entities.list({ app: nosy.id })).toEqual([]);
    });
  });

  it("issues the start call as the app itself, whatever the app says", async () => {
    const { start } = await onSocket(nosy);

    expect(start).toMatchObject({
      type: "call",
      actor: { kind: "app", id: "test.socket" },
      body: { kind: "start" },
    });
  });

  it.each([
    ["people", []],
    ["places", []],
    ["location", []],
    ["devices", []],
    ["device", ["device:1"]],
    ["command", [{ device: "device:1", capability: "x", command: {} }]],
    ["register", [{ key: "a", name: "A", capabilities: [] }]],
    ["report", [{ key: "a", states: {} }]],
    ["present", [{ keys: [] }]],
    ["press", [{ key: "a", capability: "b", action: "c" }]],
    ["release", [{ key: "a", capability: "b" }]],
    ["firmware", [{ key: "a", update: null }]],
    ["joining", [{ key: "a", stage: "joined" }]],
    ["putWorkflow", [{ key: "a" }]],
    ["removeWorkflow", ["a"]],
    ["workflows", []],
    ["entities", ["weather"]],
    ["serviceConnection", ["mosquitto"]],
    ["fetch", [{ url: "https://example.com" }]],
  ])(
    "refuses %s to an app that doesn't hold what it needs",
    async (method, params) => {
      const { ask } = await onSocket(nosy);

      expect(await ask(method, params)).toMatchObject({ ok: false });
    },
  );

  it("can't ask in another app's name, and what it does is its own", async () => {
    const { ask, core } = await onSocket(driver);
    const lamp = {
      key: "lamp",
      name: "Lamp",
      capabilities: [{ id: "light", kind: "switch", features: {} }],
    };

    expect(
      await ask("register", [{ ...lamp, driver: "sanctum.zigbee" }]),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unrecognized key"),
    });

    expect(await ask("register", [lamp])).toMatchObject({ ok: true });
    expect(core.db.all(sql`select driver from devices`)).toEqual([
      { driver: "test.socket" },
    ]);
  });

  it("answers anything at all, and the core goes on", async () => {
    const garbage: unknown[] = [
      null,
      0,
      -1,
      1.5,
      "",
      "x",
      true,
      [],
      [[]],
      {},
      { key: {} },
      { key: "x".repeat(5_000) },
      { device: [], capability: {}, command: "on" },
      JSON.parse('{"__proto__":{"polluted":true},"key":"a"}'),
      { constructor: { prototype: { polluted: true } } },
    ];
    const { ask, core } = await onSocket(driver);

    for (const method of coreCallMethods) {
      for (const value of garbage) {
        const outcome = await ask(method, [value]);
        expect(typeof outcome.ok, `${method}(${JSON.stringify(value)})`).toBe(
          "boolean",
        );
      }
      expect(await ask(method, [])).toBeDefined();
    }

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const maya = await claimed(core);
    expect(
      (await post(core, "/api/places/rooms/add", { name: "Office" }, maya))
        .statusCode,
    ).toBe(200);
  }, 30_000);
});
