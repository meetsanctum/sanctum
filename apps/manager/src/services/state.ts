import { join } from "node:path";

import { readJson, writeJson } from "../state.js";
import type { ServiceSpec } from "./containers.js";
import type { ZigbeeCoordinatorChoice } from "./zigbee-coordinator.js";

// What the manager keeps about services, in its data volume: which apps need
// which service, the broker accounts it generated, the chosen Zigbee
// coordinator and how far each change of image got. It survives updates and
// reboots; the services' own data lives in their volumes.

export type MqttAccount = { password: string; hash: string };

// A service moving to another image (image-change.ts). Images are references.
export type ImageChange = {
  from: string;
  to: string;
  // The copy of its data taken under `from`, in the manager's backups, and
  // the volumes it holds, which a later manager's spec may name differently.
  backup: string;
  volumes: NonNullable<ServiceSpec["volumes"]>;
  // checking: the new version has yet to show it stays up.
  // restoring: it did not, and the copy and `from` are going back.
  // kept-back: they are back, and the service stays on `from` and `volumes`
  // until the manager brings another version than `to`.
  status: "checking" | "restoring" | "kept-back";
  // When it began, for how long its time under observation holds the slot for
  // the host's other operations (operations.ts).
  startedAt?: string;
};

export type ServicesState = {
  // The apps that asked for each service, by service name.
  apps: Record<string, string[]>;
  // One broker account per MQTT client, by username: each service and each
  // app that talks MQTT.
  mqttAccounts: Record<string, MqttAccount>;
  zigbeeCoordinator?: ZigbeeCoordinatorChoice;
  // The image each service last ran from, whose version its data holds. A
  // service nothing needs has no container left to tell.
  images?: Record<string, string>;
  imageChanges?: Record<string, ImageChange>;
};

export type ServicesStateStore = {
  current: () => ServicesState;
  // Changes run one at a time and are saved before the next one starts. A
  // change that throws, or fails to save, leaves the state as it was.
  update: <T>(change: (draft: ServicesState) => T) => Promise<T>;
};

export async function createServicesStateStore(
  dataDir: string,
): Promise<ServicesStateStore> {
  const path = join(dataDir, "services.json");
  let state: ServicesState = (await readJson<ServicesState>(path)) ?? {
    apps: {},
    mqttAccounts: {},
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    current: () => state,
    update(change) {
      const next = queue
        .catch(() => undefined)
        .then(async () => {
          const draft = structuredClone(state);
          const result = change(draft);
          // It holds the broker passwords.
          await writeJson(path, draft, { mode: 0o600 });
          state = draft;
          return result;
        });
      queue = next;
      return next;
    },
  };
}
