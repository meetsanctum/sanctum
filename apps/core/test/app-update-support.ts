import { toStaticManifest, type AppDefinition } from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { coreSocketName } from "@meetsanctum/app-sdk/protocol";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";

import { appUpdates, appVersions } from "../src/app-host/schema.js";
import { cleanUps } from "./app-apart-support.js";
import { fakeManager, testCore, type TestCore } from "./support.js";

// Apps that run apart at several versions, with a container as a session in this
// process: a core is started on one version, then another on the next, as a core
// update brings it, with the same data.

export const folderOf = (app: AppDefinition) => `${app.version}+test`;

// A home whose app runs apart at one version after another. The runner
// migrates its database from migrationsFolder, as its package brings them.
export async function versions(options: { migrationsFolder?: string } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-versions-"));
  cleanUps.push(() => rm(folder, { recursive: true, force: true }));
  const fake = fakeManager();
  const staged = new Map<string, AppDefinition>();
  const packageOf = (
    definition: AppDefinition,
    folder = folderOf(definition),
  ) => {
    staged.set(folder, definition);
    const text = JSON.stringify(toStaticManifest(definition));
    return {
      apart: {
        manifest: JSON.parse(text),
        digest: manifestDigest(text),
        folder,
      },
      origin: "official" as const,
    };
  };
  let dataDir: string | undefined;
  // How many more times a package can't be read.
  let unreadable = 0;
  const containers: string[] = [];
  let container: ReturnType<typeof runSession> | undefined;
  const stopContainer = async () => {
    const session = container;
    container = undefined;
    await session?.shutdown(50);
  };

  const runContainer = (definition: AppDefinition, onLoad?: () => void) => {
    const text = JSON.stringify(toStaticManifest(definition));
    const session = runSession({
      appId: definition.id,
      socket: join(folder, definition.id, coreSocketName),
      database: join(folder, "app.db"),
      package: {
        version: definition.version,
        manifest: manifestDigest(text),
        load: async () => {
          onLoad?.();
          return {
            app: definition,
            ...(options.migrationsFolder
              ? { migrationsFolder: options.migrationsFolder }
              : {}),
          };
        },
      },
    });
    container = session;
    cleanUps.push(() => session.shutdown(50));
  };
  const manager = {
    ...fake.manager,
    async startAppContainer(_app: string, spec: { folder: string }) {
      await stopContainer();
      containers.push(spec.folder);
      runContainer(staged.get(spec.folder)!);
    },
    async stopAppContainer() {
      await stopContainer();
    },
    // The manager stops it first, as the real one does.
    async beginAppUpdate(
      ...args: Parameters<typeof fake.manager.beginAppUpdate>
    ) {
      await stopContainer();
      await fake.manager.beginAppUpdate(...args);
    },
    async undoAppUpdate(
      ...args: Parameters<typeof fake.manager.undoAppUpdate>
    ) {
      await stopContainer();
      await fake.manager.undoAppUpdate(...args);
    },
    appContainer: async () => ({
      state: container ? ("running" as const) : ("stopped" as const),
    }),
  };

  let latest: TestCore | undefined;

  // A core with this version of the app, as its image would bring it. There's only
  // ever one core, so the one before has gone.
  async function coreWith(
    definition: AppDefinition,
    options: {
      onTrial?: boolean;
      folder?: string;
      beforeLoad?: () => Promise<void>;
      retryAfterMs?: number;
      quietMs?: number;
      // Its package in the core's process too, as an official app ships until it moves.
      inProcess?: AppDefinition;
      // Only that, as a release from before apps ran apart.
      isInProcessOnly?: boolean;
    } = {},
  ) {
    await latest?.apps.close();
    const core: TestCore = await testCore({
      ...(dataDir ? { dataDir } : {}),
      appSockets: folder,
      appTimeoutMs: 2_000,
      supervision: {
        restartPausesMs: [1],
        waitPausesMs: [5],
        connectWithinMs: 5_000,
        quietMs: options.quietMs,
      },
      appUpdates: {
        turnPauseMs: 5,
        catchUpPauseMs: 5,
        retryAfterMs: options.retryAfterMs ?? 60_000,
        loadPackage: async (_appId, version) => {
          if (unreadable > 0) {
            unreadable -= 1;
            throw new Error("The package can't be read just now");
          }
          await options.beforeLoad?.();
          const older = staged.get(version);
          if (!older) throw new Error(`Nothing is staged in ${version}`);
          return packageOf(older, version);
        },
      },
      manager,
      apart: options.isInProcessOnly
        ? []
        : [packageOf(definition, options.folder)],
      ...(options.inProcess || options.isInProcessOnly
        ? {
            apps: [
              {
                app: options.inProcess ?? definition,
                origin: "official" as const,
              },
            ],
          }
        : {}),
      ...(options.onTrial ? { onTrial: true } : {}),
    });
    dataDir = core.dataDir;
    latest = core;
    cleanUps.push(() => core.apps.close());
    return core;
  }

  return {
    coreWith,
    containers,
    calls: fake.calls,
    manager,
    journal: fake.updates,
    stopContainer,
    // A container running without this asking the manager for it, which says when
    // the core has welcomed it.
    runContainer,
    stage: (definition: AppDefinition) => void packageOf(definition),
    packagesUnreadableFor: (times: number) => {
      unreadable = times;
    },
    packageOf,
    // A power cut: the core and its app go with no goodbye.
    async powerCut(core: TestCore) {
      await core.apps.close();
      await stopContainer();
    },
  };
}

export const stateOf = (core: TestCore, id: string) =>
  core.apps.list().find((app) => app.id === id)!;

export const running = (core: TestCore, id: string) =>
  vi.waitFor(() => expect(stateOf(core, id).state).toBe("running"), {
    timeout: 4_000,
  });

export const rowOf = (core: TestCore) =>
  core.db.select().from(appUpdates).get();

export const committedOf = (core: TestCore) =>
  core.db.select().from(appVersions).get();
