import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { isBroker, joinAppNetworks } from "../apps/broker.js";
import type { Log } from "../docker-resources.js";
import {
  errorMessage,
  type ContainerInfo,
  type DockerClientLike,
} from "../docker.js";
import {
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
  image?: string;
  restarts?: number;
};

type Observed = Omit<ServiceStatus, "name" | "apps">;

// A request the manager cannot act on, such as an unknown coordinator.
export class ServiceRequestError extends Error {}
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
      observed.set(name, { state: "waiting", problem: spec.problem });
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
      await store.update((draft) => {
        draft.apps[name] = [
          ...new Set([...(draft.apps[name] ?? []), app]),
        ].sort();
        syncAccounts(draft);
      });
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
