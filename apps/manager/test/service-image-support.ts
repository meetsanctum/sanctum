import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { createOperations, type Operation } from "../src/operations.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import { createServices } from "../src/services/services.js";
import { createServicesStateStore } from "../src/services/state.js";
import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import { FakeDocker } from "./fake-docker.js";
import { hostDev, zbt2 } from "./host-dev.js";

// A host running a service on an older image than this manager brings.

export const bridge = "sanctum-zigbee2mqtt";
export const scratch = "sanctum-zigbee2mqtt-copy";
export const volume = "sanctum-zigbee2mqtt-data";
export const app = "sanctum.zigbee";
// What the manager before this one pinned.
export const oldImage = "ghcr.io/koenkk/zigbee2mqtt:2.13.0";
export const managedVolume = { "sanctum.managed": "true" };

// A host whose Zigbee2MQTT runs the old image, on a network whose key is in its
// volume, with a manager that has just brought a new image.
export async function setup(
  options: {
    running?: boolean;
    holder?: () => Operation | null;
    log?: (line: string) => void;
  } = {},
) {
  const docker = new FakeDocker();
  docker.publish(mosquittoImage, { title: "mosquitto", version: "2.1.2" });
  docker.publish(zigbee2mqttImage, { title: "zigbee2mqtt", version: "2.14.2" });
  docker.load(oldImage, { title: "zigbee2mqtt", version: "2.13.0" });
  docker.volumes.set(volume, managedVolume);
  docker.volumeData.set(volume, "the network key");
  if (options.running ?? true) {
    docker.run({
      name: bridge,
      Image: oldImage,
      Labels: {
        "sanctum.managed": "true",
        "sanctum.role": "zigbee2mqtt",
        "sanctum.definition": "from-an-older-manager",
      },
      HostConfig: { Binds: [`${volume}:/app/data`] },
    });
  }
  // The new version migrates what it finds; the old one leaves it alone.
  docker.onStart = (name, version) => {
    if (name === bridge && version === "2.14.2") {
      docker.volumeData.set(volume, "migrated");
    }
  };
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-manager-"));
  const dev = await hostDev();
  await dev.plug(zbt2, "ttyACM0");
  const log = options.log ?? vi.fn();
  const seen: Array<{ state: string; problem?: string }> = [];
  // A manager process: a restart or an update makes a new one.
  const start = async () => {
    const store = await createServicesStateStore(dataDir);
    const operations = createOperations();
    if (options.holder) operations.heldBy(options.holder);
    const services = createServices({
      operations,
      docker,
      store,
      dataDir,
      hostDevDir: dev.root,
      log,
      onObserved: (name, _before, after) => {
        if (name === "zigbee2mqtt") seen.push(after);
      },
    });
    await services.start();
    return { services, store, operations };
  };
  const { services, store, operations } = await start();
  await services.need("zigbee2mqtt", app);
  const backups = join(dataDir, "backups");
  return {
    dev,
    docker,
    dataDir,
    backups,
    seen,
    services,
    store,
    operations,
    start,
    copies: async () => (await readdir(backups).catch(() => [])).sort(),
    copied: async (copy: string) =>
      readFile(join(backups, copy, `${volume}.tar`), "utf8"),
    // As if the container had been up for a good while.
    settle: () => {
      docker.container(bridge)!.startedAt = new Date(Date.now() - 10 * 60_000);
    },
    crashLoop: () => {
      docker.container(bridge)!.restartCount = 3;
    },
  };
}

export function hasImage(docker: FakeDocker, reference: string) {
  return [...docker.images.values()].some((image) => image.tags.has(reference));
}
