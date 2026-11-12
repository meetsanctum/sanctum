import { toStaticManifest, type StaticManifest } from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { coreSocketName } from "@meetsanctum/app-sdk/protocol";
import { runSession } from "@meetsanctum/app-sdk/runner-session";
import { join } from "node:path";

import type { ApartPackage, AppPackage } from "../src/app-host/host.js";
import type { TestManager } from "./support.js";

// The apps a test defines, run as the core runs every app: apart, each through
// the SDK's runner over a real socket. The runner runs in the test's own
// process as the app's container, so the app's code and the test share their
// variables. Its database is where the core keeps apps' files, so a core
// started again on the same data finds it.

type Session = ReturnType<typeof runSession>;

export function runnerApps(options: {
  dataDir: string;
  sockets: string;
  manager: TestManager;
}) {
  const { manager } = options;
  // The apps it runs, and each package it has staged, by its app and folder.
  const runs = new Set<string>();
  const staged = new Map<string, { pkg: AppPackage; digest: string }>();
  const stagedIn = (appId: string, folder: string) => `${appId}/${folder}`;
  const sessions = new Map<string, Session>();

  async function stopSession(appId: string) {
    const session = sessions.get(appId);
    sessions.delete(appId);
    await session?.shutdown(50);
  }

  // Its container, as the manager would start it from the folder the core
  // asks for, which after an update or going back is another package.
  async function startSession(appId: string, folder: string) {
    const found = staged.get(stagedIn(appId, folder));
    if (!found) throw new Error(`${appId} has no package in ${folder}`);
    await stopSession(appId);
    const { app, migrationsFolder } = found.pkg;
    const session = runSession({
      appId,
      socket: join(options.sockets, appId, coreSocketName),
      database: join(options.dataDir, "apps", `${appId}.db`),
      package: {
        version: app.version,
        manifest: found.digest,
        load: async () => ({
          app,
          ...(migrationsFolder ? { migrationsFolder } : {}),
        }),
      },
    });
    sessions.set(appId, session);
    // One that ends by itself, as a crashed container does, is gone.
    void session.finished.then(() => {
      if (sessions.get(appId) === session) sessions.delete(appId);
    });
  }

  // The containers of the apps it runs are its own; the test's manager has every
  // other, and everything else, as it is when asked, since a test can change it
  // after the core has started.
  const containers: Pick<
    TestManager,
    | "capabilities"
    | "startAppContainer"
    | "stopAppContainer"
    | "removeAppContainer"
    | "appContainer"
  > = {
    capabilities: () => ({
      ...manager.capabilities(),
      ...(runs.size > 0 ? { appContainers: true } : {}),
    }),
    async startAppContainer(appId, spec) {
      if (!runs.has(appId)) return manager.startAppContainer(appId, spec);
      await startSession(appId, spec.folder);
    },
    async stopAppContainer(appId) {
      if (!runs.has(appId)) return manager.stopAppContainer(appId);
      await stopSession(appId);
    },
    async removeAppContainer(appId) {
      if (!runs.has(appId)) return manager.removeAppContainer(appId);
      await stopSession(appId);
    },
    async appContainer(appId) {
      if (!runs.has(appId)) return manager.appContainer(appId);
      return { state: sessions.has(appId) ? "running" : "stopped" };
    },
  };
  const managing = new Proxy(manager, {
    get: (target, key, receiver) =>
      Object.hasOwn(containers, key)
        ? containers[key as keyof typeof containers]
        : Reflect.get(target, key, receiver),
  });

  return {
    manager: managing,
    // Each as its staged package, which the core reads, and runs apart.
    add(packages: readonly AppPackage[]): ApartPackage[] {
      return packages.map((pkg) => {
        const { app, manifest, origin } = pkg;
        const text = JSON.stringify(manifest ?? toStaticManifest(app));
        const digest = manifestDigest(text);
        const folder = `${app.version}+test`;
        runs.add(app.id);
        staged.set(stagedIn(app.id, folder), { pkg, digest });
        return {
          apart: {
            // The test's own, which it may change while the core runs.
            manifest: manifest ?? (JSON.parse(text) as StaticManifest),
            digest,
            folder,
          },
          origin,
        };
      });
    },
    async close() {
      await Promise.all([...sessions.keys()].map(stopSession));
    },
  };
}

// The timer the test started with, which its fake timers don't stop.
const wait = globalThis.setTimeout;

// Until none of these apps is still starting: each is running, or has said why
// not, as the supervisor has it. It waits as long as the host gives a start,
// whose own deadlines end it, and a closed core lists none.
export async function firstStarts(
  apps: { list(): { id: string; state: string }[] },
  packages: readonly ApartPackage[],
) {
  const ids = packages.map(({ apart }) => apart.manifest.id);
  const isStarting = () =>
    apps
      .list()
      .some(({ id, state }) => ids.includes(id) && state === "starting");
  while (isStarting()) await new Promise((done) => wait(done, 2));
}
