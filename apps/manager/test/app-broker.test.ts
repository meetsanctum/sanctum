import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { brokerNetworkName } from "../src/apps/broker.js";
import { createAppContainers, nodeImage } from "../src/apps/containers.js";
import { managedLabel } from "../src/docker.js";
import { createOperations } from "../src/operations.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import { createServices } from "../src/services/services.js";
import { createServicesStateStore } from "../src/services/state.js";
import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import { FakeDocker } from "./fake-docker.js";
import { hostDev } from "./host-dev.js";

// An app that uses a service through the broker reaches the broker on a network
// of its own, which reaches nothing beyond and which only the broker shares.

const app = "sanctum.zigbee";
const folder = "0.5.0+1a2b3c4d5e6f7a8b";
const network = brokerNetworkName(app);

async function home(permissions: string[]) {
  const docker = new FakeDocker();
  docker.load(nodeImage, { title: "node", version: "24" });
  docker.publish(mosquittoImage, { title: "mosquitto", version: "2.1.2" });
  docker.publish(zigbee2mqttImage, { title: "zigbee2mqtt", version: "2.14.2" });
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-broker-"));
  const staged = join(dataDir, "packages", app, folder);
  await mkdir(staged, { recursive: true });
  await writeFile(join(staged, "package.json"), "{}");
  await writeFile(
    join(staged, "sanctum-app.json"),
    JSON.stringify({ id: app, permissions: permissions.map((id) => ({ id })) }),
  );
  const apps = createAppContainers({
    docker,
    dataDir,
    log: vi.fn(),
    totalMemory: () => 8 * 1024 ** 3,
    ownFolder: async () => undefined,
    images: { ensure: async () => `sanctum-app-data-${app}` },
  });
  const dev = await hostDev();
  const services = createServices({
    operations: createOperations(),
    docker,
    store: await createServicesStateStore(dataDir),
    dataDir,
    hostDevDir: dev.root,
    log: vi.fn(),
  });
  await services.start();
  const start = () => apps.start({ app, folder, memoryMb: 128 });
  const networksOf = (name: string) =>
    Object.keys(docker.container(name)?.networks ?? {});
  return { docker, apps, services, start, networksOf };
}

describe("the broker's network", () => {
  it("is an app's only network when it uses Zigbee2MQTT, reaching nothing beyond, with the broker on it", async () => {
    const { docker, services, start, networksOf } = await home([
      "services:zigbee2mqtt",
      "devices.register",
    ]);
    await services.need("zigbee2mqtt", app);
    await services.reconcile();

    await start();

    expect(
      docker.container(`sanctum-app-${app}`)?.options.HostConfig?.NetworkMode,
    ).toBe(network);
    expect(docker.internalNetworks).toContain(network);
    expect(networksOf("sanctum-mosquitto")).toContain(network);
    expect(networksOf("sanctum-zigbee2mqtt")).not.toContain(network);
  });

  it("isn't there for an app that uses no such service: it has no network at all", async () => {
    const { docker, start } = await home(["devices.register"]);

    await start();

    expect(
      docker.container(`sanctum-app-${app}`)?.options.HostConfig?.NetworkMode,
    ).toBe("none");
    expect(docker.networks.has(network)).toBe(false);
  });

  it("gets the broker again when its container is made after the app's", async () => {
    const { docker, services, start, networksOf } = await home([
      "services:zigbee2mqtt",
    ]);
    await start();
    // Another stack's app network, on the same Docker.
    await docker.createNetwork({
      Name: "sanctum-other-app-sanctum.zigbee-broker",
      Internal: true,
      Labels: {
        [managedLabel]: "true",
        "sanctum.app.broker": app,
        "sanctum.stack": "other",
      },
    });

    await services.need("zigbee2mqtt", app);
    await services.reconcile();

    expect(networksOf("sanctum-mosquitto")).toContain(network);
    expect(networksOf("sanctum-mosquitto")).not.toContain(
      "sanctum-other-app-sanctum.zigbee-broker",
    );
  });

  it("refuses one of that name that reaches beyond, starting nothing", async () => {
    const { docker, start } = await home(["services:zigbee2mqtt"]);
    await docker.createNetwork({
      Name: network,
      Labels: { [managedLabel]: "true" },
    });

    await expect(start()).rejects.toThrow(/reaches beyond/);
    expect(docker.container(`sanctum-app-${app}`)).toBeUndefined();
  });
});
