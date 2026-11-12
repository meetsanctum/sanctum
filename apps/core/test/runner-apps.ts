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
  const byId = new Map<string, AppPackage>();
  const sessions = new Map<string, Session>();
  const digests = new Map<string, string>();

  async function stopSession(appId: string) {
    const session = sessions.get(appId);
    sessions.delete(appId);
    await session?.shutdown(50);
  }

  // Its container, as the manager would start it from the staged package.
  function startSession(pkg: AppPackage) {
    const { app, migrationsFolder } = pkg;
    const session = runSession({
      appId: app.id,
      socket: join(options.sockets, app.id, coreSocketName),
      database: join(options.dataDir, "apps", `${app.id}.db`),
      package: {
        version: app.version,
        manifest: digests.get(app.id)!,
        load: async () => ({
          app,
          ...(migrationsFolder ? { migrationsFolder } : {}),
        }),
      },
    });
    sessions.set(app.id, session);
    // One that ends by itself, as a crashed container does, is gone.
    void session.finished.then(() => {
      if (sessions.get(app.id) === session) sessions.delete(app.id);
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
      ...(byId.size > 0 ? { appContainers: true } : {}),
    }),
    async startAppContainer(appId, spec) {
      const pkg = byId.get(appId);
      if (!pkg) return manager.startAppContainer(appId, spec);
      await stopSession(appId);
      startSession(pkg);
    },
    async stopAppContainer(appId) {
      if (!byId.has(appId)) return manager.stopAppContainer(appId);
      await stopSession(appId);
    },
    async removeAppContainer(appId) {
      if (!byId.has(appId)) return manager.removeAppContainer(appId);
      await stopSession(appId);
    },
    async appContainer(appId) {
      if (!byId.has(appId)) return manager.appContainer(appId);
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
        byId.set(app.id, pkg);
        digests.set(app.id, manifestDigest(text));
        return {
          apart: {
            // The test's own, which it may change while the core runs.
            manifest: manifest ?? (JSON.parse(text) as StaticManifest),
            digest: manifestDigest(text),
            folder: `${app.version}+test`,
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

// The timer and clock the test started with, which its fake timers don't stop.
const wait = globalThis.setTimeout;
const clock = performance.now.bind(performance);

// Until none of these apps is still starting: each is running, or has said why
// not, as the supervisor has it.
export async function firstStarts(
  apps: { list(): { id: string; state: string }[] },
  packages: readonly ApartPackage[],
  withinMs = 10_000,
) {
  const ids = packages.map(({ apart }) => apart.manifest.id);
  const by = clock() + withinMs;
  for (;;) {
    const starting = apps
      .list()
      .filter(({ id, state }) => ids.includes(id) && state === "starting");
    if (starting.length === 0) return;
    if (clock() > by) {
      throw new Error(
        `${starting.map(({ id }) => id).join(", ")} didn't start in time`,
      );
    }
    await new Promise((done) => wait(done, 2));
  }
}
