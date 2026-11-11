import type { ServiceSpec } from "./containers.js";
import { mosquittoSpec, type MqttClient } from "./mosquitto.js";
import type { ServicesState } from "./state.js";
import type { ZigbeeCoordinator } from "./zigbee-coordinator.js";
import { zigbee2mqttBaseTopic, zigbee2mqttSpec } from "./zigbee2mqtt.js";

// The services the manager can run: programs in containers of their own that
// an app asks for with a `services:<name>` permission. The manager declares
// what each one is; an app only names it.

export type SpecContext = {
  state: ServicesState;
  mqttClients: MqttClient[];
  // The coordinator to use, or why there is none yet.
  zigbeeCoordinator: () => Promise<
    { coordinator: ZigbeeCoordinator } | { problem: string }
  >;
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
  // What an app needs to know to use the service, besides its broker account.
  connection?: () => Record<string, unknown>;
  // The container to run, or why it cannot run yet.
  spec: (
    context: SpecContext,
  ) => Promise<ServiceSpec | { problem: string }> | ServiceSpec;
};

// In the order they start.
export const serviceDefinitions: ServiceDefinition[] = [
  {
    name: "mosquitto",
    needs: [],
    forApps: false,
    spec: ({ mqttClients }) => mosquittoSpec(mqttClients),
  },
  {
    name: "zigbee2mqtt",
    needs: ["mosquitto"],
    forApps: true,
    mqttTopics: [`${zigbee2mqttBaseTopic}/#`],
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
];

export function findService(name: string) {
  return serviceDefinitions.find((definition) => definition.name === name);
}

// The services that should run: those an app asked for, and what they need.
export function wantedServices(state: ServicesState) {
  const wanted = new Set<string>();
  const add = (name: string) => {
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const need of findService(name)?.needs ?? []) add(need);
  };
  for (const [name, apps] of Object.entries(state.apps)) {
    if (apps.length > 0 && findService(name)) add(name);
  }
  return wanted;
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
