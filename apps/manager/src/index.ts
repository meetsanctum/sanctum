import { startAnnouncing } from "./announce.js";
import {
  createAppContainers,
  ensureAppFolders,
  nodeImage,
} from "./apps/containers.js";
import { createImageHelper } from "./apps/helper.js";
import { createAppImages } from "./apps/images.js";
import { createMaintenance } from "./apps/maintenance.js";
import { createAppUpdates } from "./apps/updates.js";
import { createAppUsage } from "./apps/usage.js";
import { createAudit, serviceChange } from "./audit.js";
import { hostNames, createHostAuthority } from "./certificates/host-ca.js";
import { readClock } from "./certificates/clock.js";
import { coreFetch } from "./certificates/core-fetch.js";
import { createClaimedReports } from "./claimed.js";
import { loadConfig } from "./config.js";
import {
  coreContainerName,
  corePort,
  reconcileCore,
  socketGroupId,
} from "./core-container.js";
import {
  createDockerClient,
  errorMessage,
  type StatusDockerLike,
  inspectContainer,
} from "./docker.js";
import { createHostHistory } from "./host/history.js";
import { createPower } from "./host/power.js";
import { createHostReadings } from "./host/readings.js";
import { createSpace } from "./host/space.js";
import { createHostStatus } from "./host/status.js";
import { createOperations } from "./operations.js";
import { createReconciler } from "./reconcile.js";
import { initialCoreImage } from "./release.js";
import { createServer, type ServerOptions } from "./server.js";
import { createServices } from "./services/services.js";
import { createServicesStateStore } from "./services/state.js";
import { listenOnSocket } from "./socket.js";
import { stack, stackCore } from "./stack.js";
import { createHostStateStore, createHostStateWriter } from "./state.js";
import { defaultHealthTiming } from "./update/health.js";
import { createJournalStore } from "./update/journal.js";
import { createPackages } from "./update/packages.js";
import { createUpdateService } from "./update/service.js";
import {
  createStackPackages,
  followStackBuilds,
} from "./update/stack-packages.js";
import { createRegistry } from "./update/registry.js";
import { createVersionList } from "./update/versions.js";

const config = loadConfig();
const log = (message: string) => console.log(message);
const stateStore = createHostStateStore(config.dataDir);
const state = await stateStore.load();

const saveState = createHostStateWriter(state, stateStore.save);
// What the manager does on its own, for the activity log (audit.ts).
const audit = await createAudit(config.dataDir, { log });

// The host CA, made on the first start.
const authority = await createHostAuthority({
  dataDir: config.dataDir,
  hostId: state.hostId,
  names: hostNames,
  log,
  clock: readClock,
  certificateDays: config.certificateDays,
});

let host: ServerOptions["host"];
let reconciler: ReturnType<typeof createReconciler> | undefined;
let serviceReconciler: ReturnType<typeof createReconciler> | undefined;
let packages: ReturnType<typeof createPackages> | undefined;
let stackBuilds: ReturnType<typeof followStackBuilds> | undefined;
let announcer: Awaited<ReturnType<typeof startAnnouncing>> | undefined;
let statusDocker: StatusDockerLike | undefined;
const readings = createHostReadings();
// Counts what takes the space again once something frees some; set once the
// status reporter exists.
let recount: () => void = () => undefined;
let isReady = false;

if (config.supervise) {
  const docker = createDockerClient();
  statusDocker = docker;
  // Before anything creates a core, whose container mounts them.
  await ensureAppFolders(config.dataDir);
  // Filled in below, once what knows of them exists.
  let foldersInUse = async (): Promise<{ app: string; folder: string }[]> => [];
  // A development stack's apps come from the worktree, whose image built their
  // dependencies.
  const stackPackages = stack ? createStackPackages({ log }) : undefined;
  const worktree = (await stackPackages?.has()) ? stackPackages : undefined;
  packages = createPackages({
    docker,
    dataDir: config.dataDir,
    log,
    inUse: () => foldersInUse(),
    ...(worktree ? { worktree } : {}),
  });
  const operations = createOperations();
  const isOperating = async () => (await operations.current()) !== null;
  const updates = createUpdateService({
    config,
    operations,
    docker,
    journal: createJournalStore(config.dataDir),
    dataDir: config.dataDir,
    coreDataDir: config.coreDataDir,
    coreUrl: config.coreUrl,
    coreFetch: coreFetch(authority.certificate),
    managerSocket: config.socket,
    timing: defaultHealthTiming,
    log,
    waitForReconcile: async () => {
      await reconciler?.wait();
    },
    onCoreCommitted: async (image) => {
      await saveState({ coreImage: image });
      // The update doesn't wait for them: a core that asks for what's staged
      // has it staged first (stagedFor).
      void packages?.stage(image);
    },
  });
  // Services run beside the core and keep running through its updates, so
  // their loop is not paused by one.
  const services = createServices({
    operations,
    docker,
    store: await createServicesStateStore(config.dataDir),
    dataDir: config.dataDir,
    hostDevDir: config.hostDevDir,
    log,
    onChange: async () => {
      await serviceReconciler?.wait();
      await serviceReconciler?.reconcile();
    },
    onObserved: (name, before, after) => {
      const entry = serviceChange(name, before, after);
      if (entry) void audit.record(entry);
    },
    onCoordinator: (path, adapter, by) =>
      void audit.record({
        action: "zigbee.adapter",
        outcome: "ok",
        detail: { path, adapter: adapter ?? null, by },
      }),
  });
  await services.start();
  serviceReconciler = createReconciler({ log, run: services.reconcile });
  const appImages = createAppImages({
    docker,
    dataDir: config.dataDir,
    hostDevDir: config.hostDevDir,
    helper: createImageHelper({ docker, dataDir: config.dataDir }),
    free: async () => (await readings.disk(config.dataDir))?.free ?? null,
    log,
  });
  const maintenance = createMaintenance({
    docker,
    dataDir: config.dataDir,
    nodeImage,
    log,
  });
  const appHasData = (app: string) => appImages.has(app);
  const versions = createVersionList({ config });
  const space = createSpace({
    docker,
    channel: config.channel,
    version: config.version,
    journal: createJournalStore(config.dataDir),
    ...(config.channel === "dev"
      ? {
          registry: createRegistry({ address: config.devRegistry }),
          builds: versions.builds,
        }
      : {}),
    busy: isOperating,
    free: async () => (await readings.disk(config.dataDir))?.free ?? null,
    recount: () => recount(),
    packages: {
      // Only an app that has run apart has a version to go back to.
      clearable: () => packages!.clearable(appHasData),
      clear: () => packages!.clear(appHasData),
    },
    log,
  });
  // A cleanup helper can outlive the manager. Finish recovering the dev
  // registry before serving updates or accepting another cleanup. If that
  // fails, the manager still starts: an update pulls its images from that
  // registry before it replaces anything, so it fails safely, and Free up
  // space tries the recovery again first.
  await space.resume().catch((error: unknown) => {
    log(`Could not finish the registry's cleanup: ${errorMessage(error)}`);
  });
  const appContainers = createAppContainers({
    docker,
    dataDir: config.dataDir,
    log,
    images: appImages,
    prepareImage: maintenance.prepare,
  });
  const appUpdates = createAppUpdates({
    dataDir: config.dataDir,
    operations,
    apps: appContainers,
    images: appImages,
    maintenance,
    hasPackage: async (app, folder) =>
      (await packages?.has(app, folder)) ?? false,
    log,
  });
  await appUpdates.load();
  foldersInUse = async () => [
    ...appUpdates.foldersInUse(),
    ...(await appContainers.list()).flatMap(({ app, folder }) =>
      folder ? [{ app, folder }] : [],
    ),
  ];
  host = {
    docker,
    updates,
    versions,
    services,
    apps: appContainers,
    images: appImages,
    maintenance,
    appUpdates,
    // For the core's own image, so it can't hear of those from before its update.
    stagedApps: async () => {
      const core = await inspectContainer(docker, coreContainerName);
      if (!core || !(await appContainers.ready())) return {};
      const apps = await packages!.stagedFor(core.Image);
      return Object.fromEntries(
        Object.entries(apps).map(([id, { current }]) => [id, current]),
      );
    },
    appUsage: createAppUsage({ docker, images: appImages }),
    isReady: () => isReady,
    power: createPower({
      docker,
      busy: async () => space.freeing() || (await isOperating()),
      log,
    }),
    space,
  };
  if (worktree) {
    const staging = packages;
    stackBuilds = followStackBuilds({
      stackPackages: worktree,
      restage: (names) => staging.restage(names),
      isBusy: async () => (await isOperating()) || (await updates.busy()),
      restartCore: async () => {
        if (await inspectContainer(docker, coreContainerName)) {
          await docker.getContainer(coreContainerName).restart();
        }
      },
      log,
    });
  }
  reconciler = createReconciler({
    log,
    paused: updates.busy,
    run: async () => {
      const image = await reconcileCore({
        docker,
        image: stackCore?.image ?? state.coreImage ?? initialCoreImage(config),
        log,
      });
      if (state.coreImage !== image) {
        await saveState({ coreImage: image });
        void packages?.stage(image);
      }
    },
  });
}

// The host's status for Settings → Status, sampled while the manager runs,
// and its last 24 hours, kept across restarts.
const hostHistory = createHostHistory({ dataDir: config.dataDir, log });
await hostHistory.load();
const hostStatus = createHostStatus({
  readings,
  docker: statusDocker,
  services: host?.services,
  images: host?.images,
  dataDir: config.dataDir,
  channel: config.channel,
  clock: readClock,
  history: hostHistory,
  log,
});
recount = hostStatus.recount;
hostStatus.start();

const setClaimed = createClaimedReports({
  wasClaimed: () => state.claimed,
  save: ({ claimed, homeId }) => saveState({ claimed, homeId }),
  replaceCa: authority.replace,
  announce: (report) => announcer?.setHome(report),
});

const server = createServer(config, {
  host,
  setClaimed,
  hostId: state.hostId,
  authority,
  clock: readClock,
  audit,
  status: hostStatus,
  history: hostHistory,
});
// On a host the socket's group is shared with the core's container.
await listenOnSocket(
  server,
  config.socket,
  config.supervise ? socketGroupId : undefined,
);
log(
  `manager ${config.version} (${config.channel}) listening on ${config.socket}`,
);

// Finish an update a restart interrupted before the reconcile loop touches
// the core, then keep the host converged. A resume that cannot finish leaves
// its journal open, which keeps updates and the reconcile loop paused, and
// the manager up to report it rather than restarting forever.
await host?.updates.resume().catch((error: unknown) => {
  log(`Could not finish the interrupted update: ${errorMessage(error)}`);
});
// An update the updater finished, or one finished before a restart.
await host?.updates
  .status()
  .then((journal) => audit.updateEnded(journal))
  .catch(() => undefined);
await reconciler?.start();
isReady = true;
// A manager that starts without them, new to this or after a crash, stages them
// now. It's ready before that ends: a core that asks sooner has them staged
// first (stagedFor).
if (state.coreImage) void packages?.stage(state.coreImage);
// A first pull of a service's image takes minutes on a Pi; the manager is
// ready before it finishes.
void serviceReconciler?.start();

if (config.announce) {
  announcer = await startAnnouncing(
    {
      name: "Sanctum",
      hostId: state.hostId,
      homeId: state.homeId,
      claimed: state.claimed ?? false,
      port: corePort,
    },
    log,
  ).catch((error: unknown) => {
    log(`mDNS: not announcing: ${String(error)}`);
    return undefined;
  });
  // The core may have reported while the announcement started.
  announcer?.setHome({ claimed: state.claimed ?? false, homeId: state.homeId });
}

const shutdown = async () => {
  stackBuilds?.close();
  reconciler?.stop();
  serviceReconciler?.stop();
  hostStatus.stop();
  await hostHistory.save();
  await announcer?.stop();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
