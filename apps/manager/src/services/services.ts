import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";

import { isBroker, joinAppNetworks } from "../apps/broker.js";
import { reaches, syncServiceNetworks } from "../apps/service-networks.js";
import { assertManaged, type Log } from "../docker-resources.js";
import {
  errorMessage,
  inspectImage,
  isNotFound,
  pullImage,
  type ContainerInfo,
  type DockerClientLike,
} from "../docker.js";
import {
  inspectService,
  reconcileServiceContainer,
  removeServiceContainer,
  stopServiceContainer,
} from "./containers.js";
import type { Operations } from "../operations.js";
import { createImageChanges } from "./image-change.js";
import { mosquittoPasswordHash, mosquittoUrl } from "./mosquitto.js";
import {
  findService,
  mqttClientTopics,
  serviceDefinitions,
  wantedServices,
  withServiceDependencies,
  type ServiceDefinition,
  type SpecContext,
} from "./registry.js";
import type { ServicesState, ServicesStateStore } from "./state.js";
import {
  chooseZigbeeCoordinator,
  scanZigbeeCoordinators,
} from "./zigbee-coordinator.js";
import type { ZigbeeAdapter } from "./zigbee-coordinator-profiles.js";

// Runs the services apps ask for and keeps them healthy. The core asks on an
// app's behalf, over the manager's socket, and gets what the app needs to
// use the service, or for a service it uses itself. The manager's CLI can
// ask too, by hand.

export type ServiceStatus = {
  name: string;
  // The apps that asked for it; a service another one needs has none.
  apps: string[];
  // The core asked for it for itself.
  core?: true;
  state: "off" | "starting" | "running" | "waiting" | "failed";
  // Why it is waiting or failed.
  problem?: string;
  // It waits for what the home has never had, as an adapter nobody has
  // plugged in: a home that does not use it, and no fault.
  neverSetUp?: true;
  image?: string;
  restarts?: number;
  // Where it answers, while it runs.
  url?: string;
};

type Observed = Omit<ServiceStatus, "name" | "apps" | "core">;

// A request the manager cannot act on, such as an unknown coordinator.
export class ServiceRequestError extends Error {}
/** What's asked of a service can't happen now, as erasing one an app holds. */
export class ServiceBusyError extends Error {}
export class UnknownServiceError extends Error {}

type Download = { image: string; failedAt?: number; problem?: string };

// A large image that failed to download is tried again after this.
const downloadAgainMs = 5 * 60_000;
// Reuse a recent endpoint check between requests, including concurrent ones.
const endpointCheckMs = 2_000;

// Reverse-DNS app ids, as packages/app-sdk requires them.
const appId = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

function newAccount() {
  const password = randomBytes(24).toString("base64url");
  return { password, hash: mosquittoPasswordHash(password) };
}

// Gives every MQTT client an account and drops those nothing uses any more.
function syncAccounts(draft: ServicesState) {
  const clients = new Set(
    mqttClientTopics(draft).map((client) => client.username),
  );
  for (const username of clients) {
    draft.mqttAccounts[username] ??= newAccount();
  }
  for (const username of Object.keys(draft.mqttAccounts)) {
    if (!clients.has(username)) delete draft.mqttAccounts[username];
  }
}

function isRunning(container: ContainerInfo) {
  return container.State.Running && !container.State.Restarting;
}

function isUnhealthy(container: ContainerInfo) {
  return isRunning(container) && container.State.Health?.Status === "unhealthy";
}

function observe(container: ContainerInfo, needsHealthCheck?: true): Observed {
  const running = isRunning(container);
  const unhealthy = needsHealthCheck && isUnhealthy(container);
  const ready =
    !needsHealthCheck || container.State.Health?.Status === "healthy";
  return {
    state: !running || unhealthy ? "failed" : ready ? "running" : "starting",
    ...(!running && {
      problem: `It is ${container.State.Status ?? "not running"}`,
    }),
    ...(unhealthy && { problem: "It stopped answering" }),
    image: container.Config.Image,
    restarts: container.RestartCount ?? 0,
  };
}

export function createServices(options: {
  docker: DockerClientLike;
  store: ServicesStateStore;
  // What a change of image takes its turn in.
  operations: Operations;
  // The manager's data directory, whose backups hold copies of services' data.
  dataDir: string;
  // The host's /dev, as mounted into the manager.
  hostDevDir: string;
  // The host's memory, in bytes, and its cores, for services' caps.
  totalMemory?: () => number;
  cpus?: () => number;
  // Checks and saves a new service request in the same turn as app admission.
  admitCoreService?: (name: string, save: () => Promise<void>) => Promise<void>;
  log: Log;
  // Called after a change, to reconcile soon; resolves once that reconcile
  // has run.
  onChange?: () => void | Promise<void>;
  // Called with each service's state as it is seen, and as it was before,
  // for the audit (audit.ts).
  onObserved?: (
    name: string,
    before: Observed | undefined,
    after: Observed,
  ) => void;
  // Called when the Zigbee coordinator is chosen, by the manager or a person.
  onCoordinator?: (
    path: string,
    adapter: string | null | undefined,
    by: "manager" | "person",
  ) => void;
}) {
  const { docker, store, hostDevDir, log } = options;
  const totalMemory = options.totalMemory ?? totalmem;
  const cpus = options.cpus ?? availableParallelism;
  const seen = new Map<string, Observed>();
  const endpointChecks = new Map<
    string,
    { until: number; result: Promise<Observed> }
  >();
  // Large images on their way, or the last that failed, by service.
  const downloads = new Map<string, Download>();
  // Count old containers until Docker confirms their removal, even if the
  // last app that needed the service has released it.
  const mayBeRunning = new Set<string>();
  // The last state actually applied to the broker, not just saved on disk.
  // A failed attempt cannot confirm a revocation.
  let brokerState: ServicesState | undefined;
  // What each service was last seen as.
  const observed = {
    get: (name: string) => seen.get(name),
    set(name: string, next: Observed) {
      const before = seen.get(name);
      endpointChecks.delete(name);
      seen.set(name, next);
      options.onObserved?.(name, before, next);
    },
  };
  // Requests that need a service and operations that clear its demand or
  // data take turns, even when the caller stops waiting for a reply.
  const serviceTurns = new Map<string, Promise<unknown>>();
  function inServiceTurn<T>(name: string, work: () => Promise<T>) {
    const next = (serviceTurns.get(name) ?? Promise.resolve()).then(work);
    serviceTurns.set(
      name,
      next.catch(() => undefined),
    );
    return next;
  }
  const imageChanges = createImageChanges({
    docker,
    store,
    backupsDir: join(options.dataDir, "backups"),
    operations: options.operations,
    log,
    onProblem: (name, problem) =>
      observed.set(name, { state: "failed", problem }),
  });

  function forApps(name: string) {
    const definition = findService(name);
    if (!definition?.forApps) {
      throw new UnknownServiceError(`No service ${name} for apps`);
    }
    return definition;
  }

  function forCore(name: string) {
    const definition = findService(name);
    if (!definition?.forCore) {
      throw new UnknownServiceError(`No service ${name} for the core`);
    }
    return definition;
  }

  function checkApp(app: string) {
    if (app.length > 128 || !appId.test(app)) {
      throw new ServiceRequestError(`${app} is not an app id`);
    }
  }

  function status(name: string, last = observed.get(name)): ServiceStatus {
    const state = store.current();
    const current: Observed = wantedServices(state).has(name)
      ? last && last.state !== "off"
        ? last
        : { state: "starting" }
      : last?.state === "failed"
        ? last
        : { state: "off" };
    const url = findService(name)?.url;
    return {
      name,
      apps: state.apps[name] ?? [],
      ...((state.core ?? []).includes(name) ? { core: true as const } : {}),
      ...current,
      ...(url !== undefined && current.state === "running" ? { url } : {}),
    };
  }

  async function checkEndpoint(name: string) {
    const before = observed.get(name);
    const now = performance.now();
    let check = endpointChecks.get(name);
    if (!check || now >= check.until) {
      check = {
        until: now + endpointCheckMs,
        result: inspectService(docker, name).then((container) =>
          container ? observe(container, true) : { state: "starting" },
        ),
      };
      endpointChecks.set(name, check);
    }
    try {
      const result = await check.result;
      // A reconcile may have changed the service while this check was pending.
      return status(name, observed.get(name) === before ? result : undefined);
    } catch (error) {
      if (endpointChecks.get(name) === check) endpointChecks.delete(name);
      throw error;
    }
  }

  // Downloads a large image while the reconcile goes on, then reconciles
  // again; one that fails waits a while before it's tried again.
  function download(name: string, image: string) {
    const last = downloads.get(name);
    if (
      last?.image === image &&
      (last.failedAt === undefined ||
        Date.now() - last.failedAt < downloadAgainMs)
    ) {
      return last;
    }
    const started: Download = { image };
    downloads.set(name, started);
    log(`Downloading ${image} for ${name}`);
    void pullImage(docker, image).then(
      () => {
        if (downloads.get(name) !== started) return;
        downloads.delete(name);
        void options.onChange?.();
      },
      (error: unknown) => {
        const problem = errorMessage(error);
        log(`${name}: couldn't download ${image}: ${problem}`);
        if (downloads.get(name) !== started) return;
        downloads.set(name, { image, failedAt: Date.now(), problem });
        void options.onChange?.();
      },
    );
    return started;
  }

  function connection(definition: ServiceDefinition, app: string) {
    const account = store.current().mqttAccounts[app];
    return {
      ...(definition.url ? { http: { url: definition.url } } : {}),
      ...(definition.mqttTopics && account
        ? {
            mqtt: {
              url: mosquittoUrl,
              username: app,
              password: account.password,
              topics: definition.mqttTopics,
            },
          }
        : {}),
      ...definition.connection?.(Math.floor(totalMemory() / (1024 * 1024))),
    };
  }

  async function zigbeeCoordinator() {
    const candidates = await scanZigbeeCoordinators(hostDevDir);
    let result = chooseZigbeeCoordinator(
      store.current().zigbeeCoordinator,
      candidates,
    );
    if ("picked" in result && result.picked) {
      // Keep the pick, so a second coordinator plugged in later changes
      // nothing. Recheck inside the write queue: a person's choice may
      // have been saved while the scan or this write was waiting.
      result = await store.update((draft) => {
        const latest = chooseZigbeeCoordinator(
          draft.zigbeeCoordinator,
          candidates,
        );
        if ("picked" in latest && latest.picked) {
          draft.zigbeeCoordinator = latest.picked;
        }
        return latest;
      });
      if ("picked" in result && result.picked) {
        log(`Using the Zigbee coordinator ${result.picked.path}`);
        options.onCoordinator?.(
          result.picked.path,
          result.picked.adapter,
          "manager",
        );
      }
    }
    return result;
  }

  async function reconcileOne(
    definition: ServiceDefinition,
    context: SpecContext,
  ) {
    const { name } = definition;
    await imageChanges.resume(name);
    const spec = await definition.spec(context);
    if ("problem" in spec) {
      await stopServiceContainer({ docker, service: name, log });
      observed.set(name, {
        state: "waiting",
        problem: spec.problem,
        ...(spec.neverSetUp && { neverSetUp: true }),
      });
      return;
    }
    const wanted = definition.dataNeedsNoCopy
      ? spec
      : await imageChanges.specToRun(name, spec);
    const isMissingImage =
      definition.largeImage && !(await inspectImage(docker, wanted.image));
    let container;
    if (isMissingImage) {
      // One on its version before goes on meanwhile.
      container = await inspectService(docker, name);
      const downloading = download(name, wanted.image);
      if (!container) {
        observed.set(
          name,
          downloading.problem
            ? {
                state: "failed",
                problem: `Couldn't download its image: ${downloading.problem}`,
              }
            : { state: "starting", problem: "Downloading its image" },
        );
        return;
      }
    } else {
      container = await reconcileServiceContainer({
        docker,
        service: name,
        spec: wanted,
        log,
        removeReplacedImage: definition.dataNeedsNoCopy,
        ...(definition.readyWhenHealthy && {
          onStarting: () => observed.set(name, { state: "starting" }),
        }),
      });
    }
    if (definition.readyWhenHealthy && isUnhealthy(container)) {
      observed.set(name, observe(container, true));
      log(`Restarting ${name}: it stopped answering`);
      await docker.getContainer(container.Id).restart();
      const restarted = await inspectService(docker, name);
      if (!restarted) {
        observed.set(name, { state: "starting" });
        return;
      }
      container = restarted;
    }
    if (isBroker(name)) await joinAppNetworks(docker, container, log);
    if (definition.forApps && definition.url) {
      await syncServiceNetworks(
        docker,
        name,
        container,
        context.state.apps[name] ?? [],
        log,
      );
    }
    if (!isMissingImage) await imageChanges.ran(name, wanted.image);
    observed.set(name, observe(container, definition.readyWhenHealthy));
  }

  return {
    status,
    list: () => serviceDefinitions.map((definition) => status(definition.name)),
    async endpoint(name: string) {
      const definition = findService(name);
      if (!definition) return undefined;
      let service = status(name);
      if (definition.readyWhenHealthy && service.state === "running") {
        // Docker may have restarted it since the last reconcile.
        service = await checkEndpoint(name);
      }
      const token =
        service.url && definition.token && store.current().tokens?.[name];
      return { ...service, ...(token ? { token } : {}) };
    },

    /** The services it keeps running, with their dependencies. */
    wanted: () => wantedServices(store.current()),
    wantedBy: (app: string) =>
      withServiceDependencies(
        Object.entries(store.current().apps)
          .filter(([, apps]) => apps.includes(app))
          .map(([name]) => name),
      ),
    held: () => mayBeRunning.values(),

    // Run once at start: accounts follow the clients this manager's
    // services have, which an update may have changed.
    async start() {
      await store.update(syncAccounts);
      for (const { name } of serviceDefinitions) {
        try {
          const container = await inspectService(docker, name);
          if (container?.State.Running || container?.State.Restarting) {
            mayBeRunning.add(name);
          }
        } catch (error) {
          // A read failure can't establish that the memory is free.
          mayBeRunning.add(name);
          log(`Could not read ${name}'s container: ${errorMessage(error)}`);
        }
      }
    },

    // An app needs a service: it runs from now on, with what it needs, and
    // the app gets its connection details. Asking again changes nothing.
    async need(name: string, app: string) {
      const definition = forApps(name);
      checkApp(app);
      // After an erase under way, which then finds this app needs it.
      await inServiceTurn(name, () =>
        store.update((draft) => {
          draft.apps[name] = [
            ...new Set([...(draft.apps[name] ?? []), app]),
          ].sort();
          syncAccounts(draft);
        }),
      );
      void options.onChange?.();
      return { service: status(name), connection: connection(definition, app) };
    },

    // The app no longer needs the service, because it was removed or its
    // permission was switched off. The answer waits for the reconcile that
    // removes its broker account or disconnects the service from its network.
    // Once no app needs the service, it stops; its data volume stays.
    async release(name: string, app: string) {
      const definition = forApps(name);
      checkApp(app);
      await store.update((draft) => {
        const apps = (draft.apps[name] ?? []).filter((each) => each !== app);
        if (apps.length > 0) {
          draft.apps[name] = apps;
        } else {
          delete draft.apps[name];
        }
        syncAccounts(draft);
      });
      await options.onChange?.();
      if (definition.url) {
        // No account to take back: the service leaving the app's network is
        // what takes it away.
        if (reaches(await inspectService(docker, name), app, name)) {
          throw new Error(`${name} hasn't left ${app}'s network`);
        }
        return;
      }
      if (!brokerState || (brokerState.apps[name] ?? []).includes(app)) {
        throw new Error("The broker has not confirmed the service revocation");
      }
    },

    // The core wants a service for itself: it runs from now on, with what it
    // needs. Asking again changes nothing. The core reaches it at its url,
    // which GET /api/services/:service gives once it runs.
    async wantForCore(name: string) {
      const definition = forCore(name);
      const save = () =>
        store.update((draft) => {
          draft.core = [...new Set([...(draft.core ?? []), name])].sort();
          if (definition.token) {
            draft.tokens = {
              ...draft.tokens,
              [name]: draft.tokens?.[name] ?? randomBytes(32).toString("hex"),
            };
          }
        });
      await inServiceTurn(name, () =>
        definition.checkMemory && options.admitCoreService
          ? options.admitCoreService(name, save)
          : save(),
      );
      void options.onChange?.();
      return { service: status(name) };
    },

    // The core no longer wants the service. Once nothing does, it stops;
    // its data volume stays. The answer waits for the reconcile that stops
    // it, as an app's release does.
    async releaseForCore(name: string) {
      forCore(name);
      await inServiceTurn(name, () =>
        store.update((draft) => {
          const core = (draft.core ?? []).filter((each) => each !== name);
          if (core.length > 0) {
            draft.core = core;
          } else {
            delete draft.core;
          }
        }),
      );
      await options.onChange?.();
    },

    // Deletes a service's own data, once no app needs it and it has stopped,
    // as when the household deletes the data of the app that used it: its
    // volumes and the copies its image changes kept. Erasing Zigbee2MQTT's
    // erases the Zigbee network, so every device must be paired again.
    // Asked again once it's done, it does nothing.
    async eraseData(name: string) {
      const definition = forApps(name);
      // An app's need waits for this, so none can arrive between the check
      // that no app needs it and its volumes going.
      await inServiceTurn(name, () =>
        options.operations.claim(
          { kind: "data-delete", of: name },
          async () => {
            if ((store.current().apps[name] ?? []).length > 0) {
              throw new ServiceBusyError(`An app still needs ${name}`);
            }
            if (await inspectService(docker, name)) {
              throw new ServiceBusyError(`${name} hasn't stopped yet`);
            }
            // The operation slot keeps any image change out, so a copy
            // container here is one a crash left.
            await imageChanges.removeCopyContainer(name);
            const volumes = new Set([
              ...(definition.dataVolumes ?? []),
              ...(store
                .current()
                .imageChanges?.[name]?.volumes.map((volume) => volume.name) ??
                []),
            ]);
            for (const volumeName of volumes) {
              const volume = docker.getVolume(volumeName);
              const found = await volume.inspect().catch((error: unknown) => {
                if (isNotFound(error)) return null;
                throw error;
              });
              if (!found) continue;
              assertManaged({
                labels: found.Labels,
                name: `${volumeName} volume`,
              });
              await volume.remove();
            }
            const backups = join(options.dataDir, "backups");
            // Erasure must fail if the copies cannot be inspected. Only a
            // missing backups folder means there are none to delete.
            const copies = await readdir(backups).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw error;
            });
            for (const copy of copies.filter((entry) =>
              entry.startsWith(`${name}-`),
            )) {
              await rm(join(backups, copy), { recursive: true, force: true });
            }
            await store.update((draft) => {
              delete draft.images?.[name];
              delete draft.imageChanges?.[name];
            });
            log(`Erased ${name}'s data`);
          },
        ),
      );
    },

    async zigbeeCoordinators() {
      return {
        chosen: store.current().zigbeeCoordinator ?? null,
        candidates: await scanZigbeeCoordinators(hostDevDir),
      };
    },

    // A person chose the coordinator, for example because several are
    // plugged in, or its adapter type is not known.
    async chooseZigbeeCoordinator(path: string, adapter?: ZigbeeAdapter) {
      const candidates = await scanZigbeeCoordinators(hostDevDir);
      const candidate = candidates.find((each) => each.path === path);
      if (!candidate) {
        throw new ServiceRequestError(
          `The Zigbee coordinator ${path} is not plugged in`,
        );
      }
      await store.update((draft) => {
        const chosenAdapter = adapter ?? candidate.adapter;
        draft.zigbeeCoordinator = {
          path,
          ...(chosenAdapter ? { adapter: chosenAdapter } : {}),
          ...(candidate.profileId ? { profileId: candidate.profileId } : {}),
        };
      });
      log(`Chose the Zigbee coordinator ${path}`);
      options.onCoordinator?.(path, adapter ?? candidate.adapter, "person");
      void options.onChange?.();
      return { chosen: store.current().zigbeeCoordinator!, candidates };
    },

    // Converges every service on what is wanted: removes the unwanted ones
    // first, then starts the rest in order. One service failing does not
    // keep the others from running.
    async reconcile() {
      const state = store.current();
      const wanted = wantedServices(state);
      for (const name of wanted) mayBeRunning.add(name);
      brokerState = undefined;
      for (const definition of [...serviceDefinitions].reverse()) {
        if (wanted.has(definition.name)) continue;
        try {
          await imageChanges.resume(definition.name, { isUnneeded: true });
          await removeServiceContainer({
            docker,
            service: definition.name,
            log,
          });
          mayBeRunning.delete(definition.name);
          observed.set(definition.name, { state: "off" });
          if (definition.name === "mosquitto") brokerState = state;
        } catch (error) {
          observed.set(definition.name, {
            state: "failed",
            problem: errorMessage(error),
          });
        }
      }

      const context: SpecContext = {
        state,
        host: {
          memoryMb: Math.floor(totalMemory() / (1024 * 1024)),
          cpus: cpus(),
        },
        mqttClients: mqttClientTopics(state).flatMap((client) => {
          const account = state.mqttAccounts[client.username];
          return account ? [{ ...client, hash: account.hash }] : [];
        }),
        zigbeeCoordinator,
      };
      for (const definition of serviceDefinitions) {
        if (!wanted.has(definition.name)) continue;
        try {
          await reconcileOne(definition, context);
          if (definition.name === "mosquitto") brokerState = state;
        } catch (error) {
          log(`${definition.name}: ${errorMessage(error)}`);
          observed.set(definition.name, {
            state: "failed",
            problem: errorMessage(error),
          });
        }
      }
    },
  };
}

export type Services = ReturnType<typeof createServices>;
