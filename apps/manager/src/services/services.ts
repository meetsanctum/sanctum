import { randomBytes } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { isBroker, joinAppNetworks } from "../apps/broker.js";
import type { Log } from "../docker-resources.js";
import {
  errorMessage,
  type ContainerInfo,
  type DockerClientLike,
} from "../docker.js";
import {
  inspectService,
  reconcileServiceContainer,
  removeServiceContainer,
  stopServiceContainer,
} from "./containers.js";
import { assertManaged } from "../docker-resources.js";
import { isNotFound } from "../docker.js";
import type { Operations } from "../operations.js";
import { createImageChanges } from "./image-change.js";
import { mosquittoPasswordHash, mosquittoUrl } from "./mosquitto.js";
import {
  findService,
  mqttClientTopics,
  serviceDefinitions,
  wantedServices,
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
// use the service. The manager's CLI can ask too, by hand.

export type ServiceStatus = {
  name: string;
  // The apps that asked for it; a service another one needs has none.
  apps: string[];
  state: "off" | "starting" | "running" | "waiting" | "failed";
  // Why it is waiting or failed.
  problem?: string;
  // It waits for what the home has never had, as an adapter nobody has
  // plugged in: a home that does not use it, and no fault.
  neverSetUp?: true;
  image?: string;
  restarts?: number;
};

type Observed = Omit<ServiceStatus, "name" | "apps">;

// A request the manager cannot act on, such as an unknown coordinator.
export class ServiceRequestError extends Error {}
/** What's asked of a service can't happen now, as erasing one an app holds. */
export class ServiceBusyError extends Error {}
export class UnknownServiceError extends Error {}

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

function observe(container: ContainerInfo, image: string): Observed {
  const running = container.State.Running && !container.State.Restarting;
  return {
    state: running ? "running" : "failed",
    ...(running
      ? {}
      : { problem: `It is ${container.State.Status ?? "not running"}` }),
    image,
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
  const seen = new Map<string, Observed>();
  // The last state actually applied to the broker, not just saved on disk.
  // A failed attempt cannot confirm a revocation.
  let brokerState: ServicesState | undefined;
  // What each service was last seen as.
  const observed = {
    get: (name: string) => seen.get(name),
    set(name: string, next: Observed) {
      const before = seen.get(name);
      seen.set(name, next);
      options.onObserved?.(name, before, next);
    },
  };
  // What an app's need and erasing a service's data do to one service, in
  // turns.
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

  function checkApp(app: string) {
    if (app.length > 128 || !appId.test(app)) {
      throw new ServiceRequestError(`${app} is not an app id`);
    }
  }

  function status(name: string): ServiceStatus {
    const state = store.current();
    const last = observed.get(name);
    const current: Observed = wantedServices(state).has(name)
      ? last && last.state !== "off"
        ? last
        : { state: "starting" }
      : last?.state === "failed"
        ? last
        : { state: "off" };
    return { name, apps: state.apps[name] ?? [], ...current };
  }

  function connection(definition: ServiceDefinition, app: string) {
    const account = store.current().mqttAccounts[app];
    return {
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
      ...definition.connection?.(),
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
    const wanted = await imageChanges.specToRun(name, spec);
    const container = await reconcileServiceContainer({
      docker,
      service: name,
      spec: wanted,
      log,
    });
    if (isBroker(name)) await joinAppNetworks(docker, container, log);
    await imageChanges.ran(name, wanted.image);
    observed.set(name, observe(container, wanted.image));
  }

  return {
    status,
    list: () => serviceDefinitions.map((definition) => status(definition.name)),

    // Run once at start: accounts follow the clients this manager's
    // services have, which an update may have changed.
    async start() {
      await store.update(syncAccounts);
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
    // permission was switched off. Its broker account goes, and the answer
    // waits for the reconcile that takes it out of the broker, so the core
    // knows the app can no longer log in. Once no app needs the service, it
    // stops; its data volume stays.
    async release(name: string, app: string) {
      forApps(name);
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
      if (!brokerState || (brokerState.apps[name] ?? []).includes(app)) {
        throw new Error("The broker has not confirmed the service revocation");
      }
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
      brokerState = undefined;
      for (const definition of [...serviceDefinitions].reverse()) {
        if (wanted.has(definition.name)) continue;
        try {
          await imageChanges.resume(definition.name);
          await removeServiceContainer({
            docker,
            service: definition.name,
            log,
          });
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
