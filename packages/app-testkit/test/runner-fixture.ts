import {
  defineAction,
  defineApp,
  registerPermission,
  type AppContext,
  type AppDefinition,
} from "@meetsanctum/app-sdk";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { sql as raw } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { z } from "zod";

import {
  createCorePeer,
  type CorePeer,
  type PeerCalls,
} from "../src/core-peer.js";

export const digest = "a".repeat(64);
type Hooks = Partial<Pick<AppDefinition, "start" | "stop" | "driver">>;

export function testApp(
  actions: AppDefinition["actions"] = [],
  hooks: Hooks = {},
): AppDefinition {
  return defineApp({
    id: "test.runner",
    name: "Runner test",
    version: "1.2.3",
    core: "^1.0.0",
    summary: "An app for a runner's tests",
    permissions: hooks.driver
      ? [{ id: registerPermission, reason: "To bring its devices" }]
      : [],
    actions,
    events: [],
    ...hooks,
  });
}

export const statement = (name: string) =>
  defineAction({
    id: name,
    title: name,
    tier: "write",
    input: z.object({}),
    output: z.unknown(),
    run: async () => undefined,
  });

export const sql = (ctx: AppContext, statement: string) =>
  ctx.storage.db.all(raw.raw(statement));

// Each test file owns a runner speaking over a real Unix socket and a database
// migrated in the same way as an app's package.
export function createRunnerFixture() {
  const fixture = {
    folder: "",
    socket: "",
    database: "",
    peer: undefined as CorePeer | undefined,
    session: undefined as ReturnType<typeof runSession> | undefined,
  };

  beforeEach(async () => {
    fixture.folder = await mkdtemp(join(tmpdir(), "sanctum-runner-"));
    fixture.socket = join(fixture.folder, "core.sock");
    fixture.database = join(fixture.folder, "data", "app.db");
  });

  afterEach(async () => {
    await fixture.session?.shutdown(100);
    await fixture.peer?.close();
    fixture.session = undefined;
    fixture.peer = undefined;
    await rm(fixture.folder, { recursive: true, force: true });
  });

  async function migrations() {
    const migrationsFolder = join(fixture.folder, "migrations");
    await mkdir(join(migrationsFolder, "meta"), { recursive: true });
    await writeFile(
      join(migrationsFolder, "0000_things.sql"),
      "CREATE TABLE `things` (`name` text PRIMARY KEY NOT NULL);",
    );
    await writeFile(
      join(migrationsFolder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          {
            idx: 0,
            version: "6",
            when: 1,
            tag: "0000_things",
            breakpoints: true,
          },
        ],
      }),
    );
    return migrationsFolder;
  }

  async function connected(
    app: AppDefinition,
    calls: PeerCalls = {},
    {
      migrate = true,
      deadlineMs,
    }: { migrate?: boolean; deadlineMs?: number } = {},
  ) {
    const migrationsFolder = migrate ? await migrations() : undefined;
    fixture.peer = await createCorePeer({
      socket: fixture.socket,
      calls,
      deadlineMs,
    });
    fixture.session = runSession({
      appId: app.id,
      socket: fixture.socket,
      database: fixture.database,
      package: {
        version: app.version,
        manifest: digest,
        load: async () => ({
          app,
          ...(migrationsFolder ? { migrationsFolder } : {}),
        }),
      },
    });
    await fixture.peer.hello;
    fixture.peer.welcome();
    expect(await fixture.peer.prepared).toEqual({ ready: true });
    return fixture.peer;
  }

  return Object.assign(fixture, { migrations, connected });
}
