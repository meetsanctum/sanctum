import type { ServiceSpec } from "./containers.js";
import { mosquittoSpec, type MqttClient } from "./mosquitto.js";
import { ollamaData, ollamaMemoryMb, ollamaSpec, ollamaUrl } from "./ollama.js";
import type { ServicesState } from "./state.js";
import type { ZigbeeCoordinator } from "./zigbee-coordinator.js";
import {
  zigbee2mqttBaseTopic,
  zigbee2mqttData,
  zigbee2mqttSpec,
} from "./zigbee2mqtt.js";

// The services the manager can run: programs in containers of their own that
// an app asks for with a `services:<name>` permission. The manager declares
// what each one is; an app only names it.

/**
 * Why a service cannot run yet. `neverSetUp` where it waits for what the
 * home has never had, as an adapter nobody has plugged in: no fault.
 */
export type NotYet = { problem: string; neverSetUp?: true };

export type SpecContext = {
  state: ServicesState;
  // The host's memory, in MB, and its cores.
  host: { memoryMb: number; cpus: number };
  mqttClients: MqttClient[];
  // The coordinator to use, or why there is none yet.
  zigbeeCoordinator: () => Promise<{ coordinator: ZigbeeCoordinator } | NotYet>;
};

export type ServiceDefinition = {
  name: string;
  // Services this one needs. They run whenever it does and are reconciled
  // before it.
  needs: string[];
  // Whether an app may ask for it. Apps reach the broker only through the
  // services that use it.
  forApps: boolean;
  // Topics the service uses on the broker, as a client with its own account.
  // An app that asks for the service gets an account for the same topics.
  mqttTopics?: string[];
  // What an app needs to know to use the service, besides its broker account,
  // on a host with this much memory, in MB.
  connection?: (hostMemoryMb: number) => Record<string, unknown>;
  // Where it answers over HTTP: the core reaches it there on the `sanctum`
  // network, and an app that asks for it on a network shared only with it
  // (apps/service-networks.ts), since no account limits it.
  url?: string;
  // Its image is large: it downloads while the others go on, and the
  // service runs once it's there.
  largeImage?: true;
  // Its data needs no copy before a new version, as models that download
  // again, too large to copy (image-change.ts).
  dataNeedsNoCopy?: true;
  // The container to run, or why it cannot run yet.
  spec: (context: SpecContext) => Promise<ServiceSpec | NotYet> | ServiceSpec;
  // The volumes its own data lives in, which erasing it deletes, as
  // Zigbee2MQTT's holds the Zigbee network and its key.
  dataVolumes?: string[];
  // The memory it counts for beside apps while it runs, in MB, on a host
  // with this much. It isn't a limit unless its spec sets one: one that ran
  // out would take its network down with it.
  memoryMb: number | ((hostMemoryMb: number) => number);
};

// In the order they start.
export const serviceDefinitions: ServiceDefinition[] = [
  {
    name: "mosquitto",
    needs: [],
    forApps: false,
    memoryMb: 32,
    spec: ({ mqttClients }) => mosquittoSpec(mqttClients),
  },
  {
    name: "zigbee2mqtt",
    needs: ["mosquitto"],
    forApps: true,
    memoryMb: 256,
    mqttTopics: [`${zigbee2mqttBaseTopic}/#`],
    dataVolumes: [zigbee2mqttData],
    connection: () => ({ baseTopic: zigbee2mqttBaseTopic }),
    async spec({ state, zigbeeCoordinator }) {
      const chosen = await zigbeeCoordinator();
      if ("problem" in chosen) {
        return chosen;
      }
      return zigbee2mqttSpec({
        coordinator: chosen.coordinator,
        mqtt: {
          username: "zigbee2mqtt",
          password: state.mqttAccounts.zigbee2mqtt!.password,
        },
      });
    },
  },
  {
    name: "ollama",
    needs: [],
    forApps: true,
    // Its cap: a model it loads takes most of what it holds.
    memoryMb: ollamaMemoryMb,
    url: ollamaUrl,
    largeImage: true,
    dataNeedsNoCopy: true,
    dataVolumes: [ollamaData],
    // What a model may take, so the app offers only those that fit.
    connection: (hostMemoryMb) => ({
      memoryBytes: ollamaMemoryMb(hostMemoryMb) * 1024 * 1024,
    }),
    spec: ({ host }) => ollamaSpec(host),
  },
];

/** What a service counts for beside apps, in MB, on a host with this much memory. */
export function serviceMemoryMb(name: string, hostMemoryMb: number) {
  const memoryMb = findService(name)?.memoryMb ?? 0;
  return typeof memoryMb === "function" ? memoryMb(hostMemoryMb) : memoryMb;
}

export function findService(name: string) {
  return serviceDefinitions.find((definition) => definition.name === name);
}

export function withServiceDependencies(names: Iterable<string>) {
  const wanted = new Set<string>();
  const add = (name: string) => {
    const definition = findService(name);
    if (!definition || wanted.has(name)) return;
    wanted.add(name);
    for (const need of definition.needs) add(need);
  };
  for (const name of names) add(name);
  return wanted;
}

// The services that should run: those an app asked for, and what they need.
export function wantedServices(state: ServicesState) {
  return withServiceDependencies(
    Object.keys(state.apps).filter((name) => state.apps[name]!.length > 0),
  );
}

// Everything that needs a broker account, and its topics: each wanted
// service that talks MQTT, under its own name, and each app that asked for
// one, under the app's id. App ids always contain a dot, service names never.
export function mqttClientTopics(state: ServicesState) {
  const wanted = wantedServices(state);
  const topics = new Map<string, Set<string>>();
  const grant = (username: string, filters: string[]) => {
    const granted = topics.get(username) ?? new Set();
    for (const filter of filters) granted.add(filter);
    topics.set(username, granted);
  };
  for (const definition of serviceDefinitions) {
    if (!definition.mqttTopics || !wanted.has(definition.name)) continue;
    grant(definition.name, definition.mqttTopics);
    for (const app of state.apps[definition.name] ?? []) {
      grant(app, definition.mqttTopics);
    }
  }
  return [...topics]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([username, filters]) => ({ username, topics: [...filters].sort() }));
}
