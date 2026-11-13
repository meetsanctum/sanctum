import {
  defineAction,
  defineApp,
  toStaticManifest,
  type AppDefinition,
} from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { coreSocketName } from "@meetsanctum/app-sdk/protocol";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { base, cleanUps, running, useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import { running as runningIn, versions } from "./app-update-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

// An app apart through a core restart, as for an update of the core: its
// container goes on. Its runner stops the app there as the core goes, keeping
// its process and database, and says hello to the next core, which starts it
// again, in the same container when the manager keeps it. What the runner does
// on its own while no core is there is in app-testkit's runner tests.

useCleanUps();

const sockets = async () => {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-restart-"));
  cleanUps.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
};

// A core with this app's package on these sockets, as each core starts.
async function coreOn(folder: string, app: AppDefinition, dataDir?: string) {
  const text = JSON.stringify(toStaticManifest(app));
  const core = await testCore({
    ...(dataDir ? { dataDir } : {}),
    appSockets: folder,
    appTimeoutMs: 2_000,
    supervision: { restartPausesMs: [1] },
    apart: [
      {
        apart: {
          manifest: JSON.parse(text) as ReturnType<typeof toStaticManifest>,
          digest: manifestDigest(text),
          folder: "1.0.0+test",
        },
        origin: "official",
      },
    ],
  });
  cleanUps.push(() => core.apps.close());
  return core;
}

// The app's container, which outlives the cores it serves.
function containerFor(folder: string, app: AppDefinition) {
  const text = JSON.stringify(toStaticManifest(app));
  let loads = 0;
  const session = runSession({
    appId: app.id,
    socket: join(folder, app.id, coreSocketName),
    database: join(folder, "app.db"),
    package: {
      version: app.version,
      manifest: manifestDigest(text),
      load: async () => {
        loads += 1;
        return { app };
      },
    },
  });
  cleanUps.push(() => session.shutdown(50));
  return { session, loads: () => loads };
}

const gates = new Map<string, () => void>();
const opened = (tag: string) =>
  new Promise<void>((open) => gates.set(tag, open));

const app = (seen: string[]) =>
  defineApp({
    ...base,
    id: "test.restarted",
    permissions: [],
    actions: [
      defineAction({
        id: "restarted.wait",
        title: "Wait",
        tier: "read",
        input: z.object({ tag: z.string() }),
        output: z.string(),
        run: async (_ctx, { tag }) => {
          await opened(tag);
          return tag;
        },
      }),
    ],
    start: async (_ctx, info) => void seen.push(`start ${info.reason}`),
    stop: async (_ctx, info) => void seen.push(`stop ${info.reason}`),
  });

const wait = (core: TestCore, token: string, tag: string) =>
  post(
    core,
    "/api/apps/test.restarted/actions/restarted.wait",
    { tag },
    {
      token,
    },
  );

describe("an app apart through a core restart", () => {
  it("stops in its container as the core goes, and starts again there for the next", async () => {
    const seen: string[] = [];
    const definition = app(seen);
    const folder = await sockets();
    const first = await coreOn(folder, definition);
    const { session, loads } = containerFor(folder, definition);
    await running(first, definition.id);

    await first.apps.close();
    await vi.waitFor(() => expect(seen.at(-1)).toBe("stop restarting"));
    const next = await coreOn(folder, definition);

    await running(next, definition.id);
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)).toMatch(/^start /);
    // The same process, its package loaded and its database opened once.
    expect(loads()).toBe(1);
    const { token } = await claimed(next);
    const answer = wait(next, token, "after");
    await vi.waitFor(() => expect(gates.has("after")).toBe(true));
    gates.get("after")!();
    expect((await answer).statusCode).toBe(200);
    void session;
  });

  it("goes on with a resume, hearing what it follows from the next core", async () => {
    const seen: string[] = [];
    const definition = defineApp({
      ...app(seen),
      settings: z.object({
        days: z.number().int().min(1).default(7).meta({ title: "Days" }),
      }),
      start: async (ctx, info) => {
        seen.push(`start ${info.reason}`);
        await ctx.events.on("settings.changed", async ({ settings }) => {
          seen.push(`days ${(settings as { days: number }).days}`);
        });
      },
      resume: async (_ctx, info) => void seen.push(`resume ${info.reason}`),
    });
    const folder = await sockets();
    // The core's own data, which a restart keeps.
    const data = await sockets();
    const first = await coreOn(folder, definition, data);
    containerFor(folder, definition);
    await running(first, definition.id);

    await first.apps.close();
    const next = await coreOn(folder, definition, data);
    await running(next, definition.id);
    const maya = await claimed(next);
    await post(
      next,
      `/api/apps/${definition.id}/settings/update`,
      { days: 3 },
      maya,
    );

    await vi.waitFor(() => expect(seen.at(-1)).toBe("days 3"));
    expect(seen).toEqual([seen[0], "resume started", "days 3"]);
    expect(seen[0]).toMatch(/^start /);
  });

  it("answers nothing of one core's calls to the next, whose calls may have the same ids", async () => {
    const seen: string[] = [];
    const definition = app(seen);
    const folder = await sockets();
    const first = await coreOn(folder, definition);
    containerFor(folder, definition);
    await running(first, definition.id);
    const before = await claimed(first);
    void wait(first, before.token, "old");
    await vi.waitFor(() => expect(gates.has("old")).toBe(true));

    await first.apps.close();
    const next = await coreOn(folder, definition);
    await running(next, definition.id);
    const { token } = await claimed(next);
    const tags = ["a", "b", "c", "d", "e"];
    const answers = tags.map((tag) => wait(next, token, tag));
    await vi.waitFor(() =>
      expect(tags.every((tag) => gates.has(tag))).toBe(true),
    );
    // The old call's answer comes now, on the next core's connection.
    gates.get("old")!();
    await new Promise((done) => setTimeout(done, 50));
    for (const tag of tags) gates.get(tag)!();

    expect(
      (await Promise.all(answers)).map((each) => each.json() as unknown),
    ).toEqual(tags);
  });
});

describe("the next core", () => {
  it("takes over the container a core before it left running", async () => {
    const home = await versions();
    const seen: string[] = [];
    const definition = version("1.0.0", {
      start: async () => void seen.push("start"),
    });
    await runningIn(await home.coreWith(definition), id);

    await runningIn(await home.coreWith(definition), id);

    expect(home.containers).toEqual(["1.0.0+test"]);
    expect(seen).toEqual(["start", "start"]);
  });

  it("gives another version a container of its own", async () => {
    const home = await versions();
    await runningIn(await home.coreWith(version("1.0.0")), id);

    await runningIn(await home.coreWith(version("1.1.0")), id);

    expect(home.containers).toEqual(["1.0.0+test", "1.1.0+test"]);
  });
});
