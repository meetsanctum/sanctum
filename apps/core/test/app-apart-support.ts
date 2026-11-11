import { toStaticManifest, type AppDefinition } from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { coreSocketName } from "@meetsanctum/app-sdk/protocol";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";

import { fakeManager, testCore, type TestCore } from "./support.js";

// An app running apart, as the host sees it: the real host and the real runner
// over a real socket, so everything the core does around a call holds for an app
// that isn't in its process. What's left to the container around them is in
// apps/manager's real-image test.

export const cleanUps: (() => Promise<unknown>)[] = [];

export function useCleanUps() {
  afterEach(async () => {
    for (const cleanUp of cleanUps.splice(0).reverse()) {
      await cleanUp();
    }
  });
}

// `declared` says what its manifest says, when its code does something else.
export async function apart(
  app: AppDefinition,
  options: Parameters<typeof testCore>[0] = {},
  declared: AppDefinition = app,
) {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-apart-"));
  cleanUps.push(() => rm(folder, { recursive: true, force: true }));
  const text = JSON.stringify(toStaticManifest(declared));
  const core = await testCore({
    ...options,
    supervision: { restartPausesMs: [1], ...options.supervision },
    appSockets: folder,
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
  const reconnect = () => {
    const session = runSession({
      appId: app.id,
      socket: join(folder, app.id, coreSocketName),
      database: join(folder, "app.db"),
      package: {
        version: app.version,
        manifest: manifestDigest(text),
        load: async () => ({ app }),
      },
    });
    cleanUps.push(() => session.shutdown(100));
    return session;
  };
  const session = reconnect();
  return { core, session, reconnect, folder };
}

export const running = (core: TestCore, id: string) =>
  vi.waitFor(() => expect(core.apps.isRunning(id)).toBe(true));

export const base = {
  name: "Apart",
  version: "1.0.0",
  core: "^1.0.0",
  events: [],
};

// A core keeping one app apart, whose containers come and go as it asks.
export async function supervised(
  app: AppDefinition,
  options: {
    version?: string;
    appTimeoutMs?: number;
    dataDir?: string;
    beforeStop?: () => Promise<void>;
    fetch?: typeof fetch;
    supervision?: { quietMs?: number };
    onTrial?: boolean;
  } = {},
) {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-super-"));
  cleanUps.push(() => rm(folder, { recursive: true, force: true }));
  const definition = options.version
    ? { ...app, version: options.version }
    : app;
  const text = JSON.stringify(toStaticManifest(definition));
  let container: ReturnType<typeof runSession> | undefined;
  let containers = 0;
  const { manager } = fakeManager();
  const core = await testCore({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    appSockets: folder,
    appTimeoutMs: options.appTimeoutMs ?? 2_000,
    fetch: options.fetch,
    onTrial: options.onTrial,
    supervision: {
      restartPausesMs: [1],
      waitPausesMs: [5],
      connectWithinMs: 5_000,
      ...options.supervision,
    },
    manager: {
      ...manager,
      async startAppContainer() {
        containers += 1;
        const session = runSession({
          appId: definition.id,
          socket: join(folder, definition.id, coreSocketName),
          database: join(folder, "app.db"),
          package: {
            version: definition.version,
            manifest: manifestDigest(text),
            load: async () => ({ app: definition }),
          },
        });
        container = session;
        cleanUps.push(() => session.shutdown(50));
      },
      async stopAppContainer() {
        await options.beforeStop?.();
        await container?.shutdown(50);
        container = undefined;
      },
      appContainer: async () => ({
        state: container ? "running" : "stopped",
      }),
    },
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
  const stateOf = () =>
    core.apps.list().find(({ id }) => id === definition.id)!;
  return {
    core,
    stateOf,
    containers: () => containers,
    running: () =>
      vi.waitFor(() => expect(stateOf().state).toBe("running"), {
        timeout: 4_000,
      }),
    // It stops by itself, as one that crashed does.
    async crash() {
      const session = container;
      container = undefined;
      await session?.shutdown(50);
    },
  };
}
