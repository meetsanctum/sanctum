import {
  loadApartPackages,
  shippedApps,
  type ApartPackage,
} from "./app-host/loader.js";
import { createCoreCertificates } from "./certificate.js";
import type { CoreConfig } from "./config.js";
import { openCoreDatabase, type CoreDatabase } from "./database.js";
import { createCoreLifecycle, type CoreSteps } from "./lifecycle.js";
import { createManagerClient, type ManagerClient } from "./manager.js";
import { createModules, type Modules } from "./modules.js";
import { loadHomeId } from "./places/places.js";
import { createServer, renewCertificate } from "./server.js";
import { watchUpdatePending } from "./update-pending.js";

// The core put together from its config, as a host runs it: the steps of each
// phase of its lifecycle, in order (lifecycle.ts), and what each sets up for
// the steps after it. index.ts turns the process's signals into a stop, so
// tests can start and stop a whole core as a host does. A test's core runs
// the same steps, with what it replaces named in TestReplacements.

type Log = (message: string) => void;
type ModuleOptions = Parameters<typeof createModules>[1];
type CoreCertificates = ReturnType<typeof createCoreCertificates>;

// What the core asks of the manager: the modules' calls (modules.ts), the
// host's id, the claim's report, the apps it staged and the core's
// certificate. A host's core asks over the manager's socket (manager.ts).
export type CoreManager = ModuleOptions["manager"] &
  Pick<
    ManagerClient,
    "hostId" | "reportClaimed" | "stagedApps" | "signCertificate" | "close"
  >;

// What a test's core has in place of a host's (test/support.ts), each named
// for what it replaces. A host's core replaces nothing.
export type TestReplacements = {
  // The clock the core reads, which a test moves on.
  now?: () => Date;
  // The manager as a test plays it, in place of the link over its socket.
  manager?: CoreManager;
  // Certificates a test's CA signs, in place of the manager's; only over
  // HTTPS.
  certificates?: CoreCertificates;
  // The apps a test defines, in place of those the image ships, which the
  // manager stages. They install in the background all the same.
  installApps?: (core: {
    db: CoreDatabase;
    modules: Modules;
    onTrial: boolean;
  }) => Promise<void>;
  // false: history's and workflows' timers tick only by hand.
  ticking?: boolean;
  // false: the activity log records no start or stop of the core, so a
  // test's log holds only what the test did.
  recordsStarts?: boolean;
  // false: the core doesn't listen, and a test sends its requests with
  // server.inject().
  listens?: boolean;
  // What the modules take that a host's core leaves at their defaults, as
  // shorter waits, the home's time zone and sun, and no internet.
  moduleOptions?: Partial<
    Omit<
      ModuleOptions,
      | "dataDir"
      | "packagesDir"
      | "kitDir"
      | "version"
      | "manager"
      | "hostId"
      | "homeId"
      | "pin"
      | "onClaimed"
      | "log"
      | "now"
    >
  >;
};

// What a step of starting waits on, or a refusal as soon as the core stops.
function untilCancelled<T>(work: Promise<T>, cancelled: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("the core is stopping"));
    if (cancelled.aborted) return stop();
    cancelled.addEventListener("abort", stop, { once: true });
    work
      .then(resolve, reject)
      .finally(() => cancelled.removeEventListener("abort", stop));
  });
}

export function createCore(
  config: CoreConfig,
  options: {
    log: Log;
    // The lifecycle's own lines ("core: starting: open core.db"), apart
    // from the modules'; both go to `log` unless it's given.
    lifecycleLog?: Log;
    testReplacements?: TestReplacements;
  },
) {
  const { log } = options;
  const replaced = options.testReplacements ?? {};
  const ticking = replaced.ticking ?? true;
  const lifecycle = createCoreLifecycle({ log: options.lifecycleLog ?? log });
  let database: ReturnType<typeof openCoreDatabase> | undefined;
  let homeId = "";
  let updatePending: ReturnType<typeof watchUpdatePending> | undefined;
  let manager: CoreManager | undefined;
  let certificates: CoreCertificates | undefined;
  let certificate: Awaited<ReturnType<CoreCertificates["first"]>> | undefined;
  let modules: Modules | undefined;
  let hasActivity = false;
  let reported: Promise<void> = Promise.resolve();
  let reportAgain: NodeJS.Timeout | undefined;
  let askAgain: NodeJS.Timeout | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let shipped: string[] = [];
  const started = new Set<string>();
  const onTrial = () => lifecycle.readiness() === "healthOnly";

  // The link over the manager's socket, which learns the host's id and
  // follows what the manager can do.
  function linkToManager() {
    const client = createManagerClient({
      socketPath: config.managerSocket,
      homeId,
      log,
    });
    client.learnHostId();
    client.followCapabilities();
    return client;
  }

  // What the manager has staged for this image, which it may still be doing,
  // so the core doesn't wait for it to serve: of those, the apps the
  // household added. The first start records a new home's starter apps or
  // the apps an existing home already had (added.ts).
  async function stagedPackages(only?: readonly string[]) {
    const staged = await manager!.stagedApps();
    const { addedApps } = modules!;
    addedApps.recordFirst(
      [...shipped, ...Object.keys(staged)],
      config.newHomeApps,
    );
    const added = addedApps.ids();
    const apart = Object.entries(staged).flatMap(([id, { folder }]) =>
      added.has(id) && !started.has(id) && (!only || only.includes(id))
        ? [`${id}@${folder}`]
        : [],
    );
    const packages = await loadApartPackages(
      [...(only ? [] : config.appsApart), ...apart],
      config.packagesDir,
      log,
    );
    for (const pkg of packages) started.add(pkg.apart.manifest.id);
    return packages;
  }

  // The apps this core's image brings, each run apart from the package the
  // manager staged for it. Each gets its database, asks for its services and
  // starts; the core serves meanwhile, so a slow app cannot hold it up. A core
  // on trial starts no app until the update commits, since a rollback can't
  // undo what they did. A package that doesn't load is logged and left out
  // (loader.ts), so one broken app doesn't keep the home's core from serving.
  // Installing that fails as a whole is fatal: the core may be serving by
  // then, but it stops all the same, so Docker tries it again and one on trial
  // rolls back.
  async function installStagedApps(cancelled: AbortSignal) {
    const { addedApps } = modules!;
    const first = stagedPackages();
    // One the image ships that the manager hasn't staged, as an old manager or
    // one whose staging failed, is asked for again now and then, one ask at a
    // time, and starts once it's there. What it brought stays meanwhile.
    let isAsking = false;
    async function startStaged(missing: readonly string[]) {
      const packages = await stagedPackages(missing);
      if (packages.length === 0) return;
      await modules!.apps.start(packages, { onTrial: onTrial() });
    }
    void first.then(
      () => {
        if (cancelled.aborted) return;
        askAgain = setInterval(() => {
          const added = addedApps.ids();
          const missing = shipped.filter(
            (id) => added.has(id) && !started.has(id),
          );
          if (missing.length === 0) return clearInterval(askAgain);
          if (isAsking || cancelled.aborted) return;
          isAsking = true;
          startStaged(missing)
            .catch((error: unknown) =>
              log(`apps: didn't start (${String(error)})`),
            )
            .finally(() => (isAsking = false));
        }, 60_000);
      },
      () => undefined,
    );
    try {
      await modules!.apps.start(first, {
        onTrial: onTrial(),
        // Keep the entities of apps the home has, even without a package.
        coming: () => [...addedApps.ids()],
      });
    } catch (error) {
      log(`apps: didn't start (${String(error)})`);
      throw error;
    }
  }

  // An app someone just added, from the exact package checked at Add,
  // installed as the home's apps are at start. A test's core installs its
  // own apps, and adds none.
  async function installAdded(pkg: ApartPackage) {
    if (replaced.installApps) throw new Error("a test's core adds no app");
    const appId = pkg.apart.manifest.id;
    started.add(appId);
    await modules!.apps.start([pkg], {
      onTrial: onTrial(),
      coming: () => [appId],
      adding: [appId],
    });
  }

  const steps: CoreSteps = {
    starting: [
      // Migrates the core's database before anything serves. A core that
      // cannot fails to start, so an update that brought it rolls back.
      [
        "open core.db",
        () => {
          database = openCoreDatabase(config.dataDir);
        },
      ],
      // The home this core serves, kept in its database.
      [
        "load the home's id",
        () => {
          homeId = loadHomeId(database!.db, replaced.now);
        },
      ],
      // An update of the core the manager hasn't committed: only the health
      // check answers until it does (lifecycle.ts).
      [
        "watch for a pending update",
        () => {
          updatePending = watchUpdatePending(config.dataDir);
          if (updatePending.isPending()) lifecycle.beginTrial();
        },
      ],
      // Auth binds sign-ins to the host's id, which the manager keeps; until
      // the manager answers, the routes that need it refuse with
      // host_starting. HTTPS with a certificate from the manager, except under
      // `pnpm dev`.
      [
        "start the manager link",
        () => {
          manager = replaced.manager ?? linkToManager();
          certificates = config.plainHttp
            ? undefined
            : (replaced.certificates ??
              createCoreCertificates({ sign: manager.signCertificate, log }));
        },
      ],
      // A core on trial runs no workflow or job until the update commits.
      [
        "build the modules",
        async () => {
          modules = await createModules(database!.db, {
            ...replaced.moduleOptions,
            dataDir: config.dataDir,
            packagesDir: config.packagesDir,
            kitDir: config.kitDir,
            version: config.version,
            manager: manager!,
            shippedApps: () => shipped,
            installAdded: (pkg) => installAdded(pkg),
            hostId: manager!.hostId,
            homeId,
            pin: () => certificates?.current()?.pin ?? null,
            // The manager announces the home's id and whether the host is
            // claimed.
            onClaimed: () => void manager!.reportClaimed(true),
            log,
            now: replaced.now,
          });
          if (onTrial()) modules.workflows.hold();
        },
      ],
      // And again now and then: a manager that started after the core, as
      // when an update replaced it, has not heard the home's id yet.
      [
        "report the claim",
        () => {
          reported = manager!.reportClaimed(modules!.auth.isClaimed());
          reportAgain = setInterval(
            () => void manager!.reportClaimed(modules!.auth.isClaimed()),
            5 * 60_000,
          );
        },
      ],
      [
        "install the apps",
        async () => {
          const testApps = replaced.installApps;
          if (testApps) {
            const db = database!.db;
            lifecycle.ownBackgroundTask("install the apps", () =>
              testApps({ db, modules: modules!, onTrial: onTrial() }),
            );
            return;
          }
          shipped = await shippedApps(config.officialAppsDir, log);
          lifecycle.ownBackgroundTask("install the apps", installStagedApps);
        },
      ],
      // Once the apps are installed and the update, if any, has committed, so
      // workflows find their pieces from the first tick.
      [
        "start workflows",
        () => {
          updatePending!.whenCommitted(() => {
            lifecycle.commit();
            lifecycle.ownBackgroundTask(
              "start workflows",
              async (cancelled) => {
                await modules!.apps.committed();
                if (cancelled.aborted) return;
                // These stay installed without a successful start to
                // restore the workflows an interrupted add left off.
                for (const app of modules!.apps.list()) {
                  if (app.state === "off" || app.state === "paused") {
                    modules!.workflows.forApps.added(app.id);
                  }
                }
                // A removal a core that stopped left part way finishes,
                // past a trial, since a rollback brings back its record.
                await modules!.appRemoving
                  .resume()
                  .catch((error: unknown) =>
                    log(`apps: removals didn't finish (${String(error)})`),
                  );
                if (!cancelled.aborted) modules!.workflows.start({ ticking });
              },
            );
          });
        },
      ],
      ["start history", () => modules!.history.start({ ticking })],
      [
        "start the activity log",
        () => {
          if (replaced.recordsStarts === false) return;
          modules!.activity.start(config.version);
          hasActivity = true;
        },
      ],
      ["start the manager's audit", () => modules!.managerAudit?.start()],
      ["start discovery", () => modules!.discovery?.start()],
      ["start firmware's deadlines", () => modules!.firmware.start()],
      // A Zigbee stick plugged in while the home has no app for it offers
      // that app, once the home's list is known.
      [
        "start looking for sticks",
        (cancelled) => {
          updatePending!.whenCommitted(() => {
            if (!cancelled.aborted) modules!.hardwareOffers.start();
          });
        },
      ],
      // A removed app's data goes once its 30 days are over, those that ran
      // out while the home was off first.
      [
        "start removed apps' deadlines",
        (cancelled) => {
          updatePending!.whenCommitted(() => {
            if (!cancelled.aborted) modules!.appDeleting.start();
          });
        },
      ],
      // A reset leaves the host unclaimed, and the manager then makes a new
      // CA, so the core reports first and asks for its certificate after.
      // Until the manager answers, the core waits and serves nothing.
      [
        "wait for the certificate",
        async (cancelled) => {
          if (!certificates) return;
          await untilCancelled(reported, cancelled);
          certificate = await untilCancelled(certificates.first(), cancelled);
        },
      ],
      [
        "create the server",
        () => {
          server = createServer(config, {
            ...modules!,
            lifecycle,
            https: certificate && {
              key: certificate.key,
              cert: certificate.cert,
            },
          });
          certificates?.watch((next) =>
            renewCertificate(server!, { key: next.key, cert: next.cert }),
          );
        },
      ],
      [
        "listen",
        async () => {
          if (replaced.listens === false) return;
          await server!.listen({ host: config.host, port: config.port });
          log(
            `core ${config.version} listening on ${certificate ? "https" : "http"}://${config.host}:${config.port}${onTrial() ? ", waiting for the update to commit" : ""}`,
          );
        },
      ],
    ],

    // The modules' own, once they're built.
    get stopNewWork() {
      return modules?.stopNewWork ?? [];
    },

    // Each part only once it has started: a core that stops while it starts
    // stops what it has and no more.
    get stopping() {
      return [
        [
          "stop the timers",
          () => {
            clearInterval(reportAgain);
            clearInterval(askAgain);
          },
        ],
        ["stop the certificate's watch", () => certificates?.close()],
        ["stop the manager link", () => manager?.close()],
        ["stop the update's watch", () => updatePending?.close()],
        ["close the server", () => server?.close()],
        [
          "stop the activity log",
          () => {
            if (hasActivity) modules!.activity.stop();
          },
        ],
        ...(modules?.stoppingSteps ?? []),
        ["close core.db", () => database?.close()],
      ] as const;
    },
  };

  return {
    // Its phase and readiness.
    lifecycle,
    // Opened in starting, from "open core.db" on.
    get db() {
      return database?.db;
    },
    // The home it serves, from "load the home's id" on.
    get homeId() {
      return homeId;
    },
    // Built in starting, from "build the modules" on.
    get modules() {
      return modules;
    },
    // Made in starting, from "create the server" on.
    get server() {
      return server;
    },
    // Runs starting's steps; resolves once the core runs, or stopping began.
    start: () => lifecycle.start(steps),
    // Stops the core once; a second call waits for the first.
    stop: (reason: "signal" | "failure" = "signal") => lifecycle.stop(reason),
    // Resolves once the core has stopped, with its exit.
    stopped: lifecycle.stopped,
  };
}

export type Core = ReturnType<typeof createCore>;
