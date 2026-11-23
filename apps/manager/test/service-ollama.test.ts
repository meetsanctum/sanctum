import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createCapacity } from "../src/apps/capacity.js";
import { createAppContainers, nodeImage } from "../src/apps/containers.js";
import { serviceNetworkName } from "../src/apps/service-networks.js";
import { sanctumNetworkName } from "../src/core-container.js";
import { ensureNetwork } from "../src/docker-resources.js";
import { createOperations } from "../src/operations.js";
import { createReconciler } from "../src/reconcile.js";
import { serviceContainerOptions } from "../src/services/containers.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import {
  ollamaData,
  ollamaImage,
  ollamaSpec,
  ollamaUrl,
} from "../src/services/ollama.js";
import { createServices } from "../src/services/services.js";
import { createServicesStateStore } from "../src/services/state.js";
import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import { FakeDocker, notFound } from "./fake-docker.js";
import { hostDev } from "./host-dev.js";

// Ollama on the host: the core reaches it on the `sanctum` network, and an app
// that holds services:ollama on a network shared only with it, which it joins
// only while the app holds it. Its image downloads while the other services go
// on, and it runs within a cap on memory and cores, with its cloud off.

const app = "sanctum.example";
const other = "sanctum.example-two";
const folder = "0.1.0+1a2b3c4d5e6f7a8b";
const gib = 1024 ** 3;
const olderImage = "ollama/ollama:0.40.15";

async function startOlderOllama(docker: FakeDocker) {
  docker.load(olderImage, { title: "ollama", version: "0.40.15" });
  await ensureNetwork(docker, sanctumNetworkName);
  const { id } = await docker.createContainer(
    serviceContainerOptions("ollama", {
      ...ollamaSpec({ memoryMb: 16 * 1024, cpus: 4 }),
      image: olderImage,
    }),
  );
  await docker.getContainer(id).start();
}

function pausePull(docker: FakeDocker) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const paused = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  const pull = docker.pull.bind(docker);
  vi.spyOn(docker, "pull").mockImplementation(async (ref) => {
    await paused;
    return pull(ref);
  });
  return { resolve, reject };
}

async function home(
  permissions: Record<string, string[]> = { [app]: ["services:ollama"] },
) {
  const docker = new FakeDocker();
  docker.load(nodeImage, { title: "node", version: "24" });
  docker.publish(mosquittoImage, { title: "mosquitto", version: "2.1.2" });
  docker.publish(zigbee2mqttImage, { title: "zigbee2mqtt", version: "2.14.2" });
  docker.publish(ollamaImage, { title: "ollama", version: "0.40.16" });
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-ollama-"));
  for (const [id, asked] of Object.entries(permissions)) {
    const staged = join(dataDir, "packages", id, folder);
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "package.json"), "{}");
    await writeFile(
      join(staged, "sanctum-app.json"),
      JSON.stringify({ id, permissions: asked.map((each) => ({ id: each })) }),
    );
  }
  const reconciler = createReconciler({
    log: vi.fn(),
    run: () => services.reconcile(),
  });
  const reconcile = async () => {
    await reconciler.wait();
    await reconciler.reconcile();
  };
  const onServiceNetwork = vi.fn(() => void reconcile());
  const apps = createAppContainers({
    docker,
    dataDir,
    log: vi.fn(),
    totalMemory: () => 16 * gib,
    ownFolder: async () => undefined,
    images: { ensure: async (id) => `sanctum-app-data-${id}` },
    onServiceNetwork,
  });
  const dev = await hostDev();
  const onObserved = vi.fn();
  const services = createServices({
    operations: createOperations(),
    docker,
    store: await createServicesStateStore(dataDir),
    dataDir,
    hostDevDir: dev.root,
    totalMemory: () => 16 * gib,
    cpus: () => 4,
    log: vi.fn(),
    onChange: reconcile,
    onObserved,
  });
  await services.start();
  // Reconciles until its image is there and it runs.
  const settle = async () => {
    await reconcile();
    await vi.waitFor(() =>
      expect(services.status("ollama").state).toBe("running"),
    );
  };
  const start = (id = app) => apps.start({ app: id, folder, memoryMb: 128 });
  const networksOf = (name: string) =>
    Object.keys(docker.container(name)?.networks ?? {});
  return {
    docker,
    dataDir,
    apps,
    services,
    settle,
    start,
    networksOf,
    reconcile,
    onObserved,
    onServiceNetwork,
  };
}

describe("Ollama on the host", () => {
  it("gives an app where it answers, and runs within its caps with its cloud off", async () => {
    const { docker, services, settle } = await home();

    const { connection } = await services.need("ollama", app);
    await settle();

    expect(connection).toEqual({ http: { url: ollamaUrl } });
    const container = docker.container("sanctum-ollama")!;
    expect(container.options.Image).toBe(ollamaImage);
    expect(container.options.Env).toEqual(
      expect.arrayContaining([
        "OLLAMA_NO_CLOUD=1",
        "OLLAMA_NUM_PARALLEL=1",
        "OLLAMA_MAX_LOADED_MODELS=1",
      ]),
    );
    expect(container.options.HostConfig).toMatchObject({
      Binds: [`${ollamaData}:/root/.ollama`],
      // Half of 16 GiB, with no swap beyond it, and three of four cores.
      Memory: 8 * gib,
      MemorySwap: 8 * gib,
      NanoCpus: 3e9,
    });
    expect(Object.keys(container.networks)).toEqual([sanctumNetworkName]);
    expect(services.status("ollama")).toMatchObject({
      state: "running",
      apps: [app],
      url: ollamaUrl,
    });
    // It needs no broker.
    expect(docker.container("sanctum-mosquitto")).toBeUndefined();
  });

  it("downloads its image while the reconcile goes on, then runs", async () => {
    const { docker, services, reconcile } = await home();
    const pull = pausePull(docker);
    await services.need("ollama", app);

    await reconcile();

    expect(services.status("ollama")).toMatchObject({
      state: "starting",
      problem: "Downloading its image",
    });
    expect(services.status("ollama").url).toBeUndefined();
    pull.resolve();
    await vi.waitFor(() =>
      expect(services.status("ollama").state).toBe("running"),
    );
    expect(docker.events).toContain(`pull ${ollamaImage}`);
  });

  it("says why its image didn't download, and waits before trying again", async () => {
    const { docker, services, reconcile } = await home();
    const pull = vi
      .spyOn(docker, "pull")
      .mockRejectedValue(notFound(`manifest for ${ollamaImage} not found`));
    await services.need("ollama", app);

    await reconcile();
    await vi.waitFor(() =>
      expect(services.status("ollama").state).toBe("failed"),
    );
    await reconcile();

    expect(services.status("ollama").problem).toMatch(
      /^Couldn't download its image/,
    );
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("stays off if an in-flight download fails after the last app releases it", async () => {
    const { docker, services, reconcile, onObserved } = await home();
    const pull = pausePull(docker);
    await services.need("ollama", app);
    await reconcile();
    expect(services.status("ollama").state).toBe("starting");

    await services.release("ollama", app);
    pull.reject(new Error("Download interrupted"));
    await reconcile();

    expect(services.status("ollama")).toEqual({
      name: "ollama",
      apps: [],
      state: "off",
    });
    expect(onObserved).not.toHaveBeenCalledWith(
      "ollama",
      expect.anything(),
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("grants and revokes access on the older container while its replacement downloads", async () => {
    const { docker, services, start, reconcile, networksOf, settle } =
      await home({ [app]: ["services:ollama"], [other]: ["services:ollama"] });
    await startOlderOllama(docker);
    const pull = pausePull(docker);
    await services.need("ollama", other);
    await start(app);
    await start(other);
    await services.need("ollama", app);
    await reconcile();

    expect(services.status("ollama")).toMatchObject({
      state: "running",
      image: olderImage,
      url: ollamaUrl,
    });
    expect(networksOf("sanctum-ollama")).toContain(
      serviceNetworkName(app, "ollama"),
    );
    await services.release("ollama", app);

    expect(networksOf("sanctum-ollama").sort()).toEqual(
      [sanctumNetworkName, serviceNetworkName(other, "ollama")].sort(),
    );
    pull.resolve();
    await settle();
    await vi.waitFor(() =>
      expect(services.status("ollama").image).toBe(ollamaImage),
    );
  });

  it("is reached by an app that holds it on a network shared only with it", async () => {
    const { docker, services, settle, start, networksOf, onServiceNetwork } =
      await home();
    const network = serviceNetworkName(app, "ollama");

    await start();
    expect(
      docker.container(`sanctum-app-${app}`)?.options.HostConfig?.NetworkMode,
    ).toBe(network);
    expect(docker.internalNetworks).toContain(network);
    expect(onServiceNetwork).toHaveBeenCalled();

    await services.need("ollama", app);
    await settle();

    expect(networksOf("sanctum-ollama")).toEqual(
      expect.arrayContaining([sanctumNetworkName, network]),
    );
  });

  it("joins only the networks of the apps that hold it, and leaves one as its app lets go", async () => {
    const { services, settle, start, networksOf, reconcile } = await home({
      [app]: ["services:ollama"],
      [other]: ["services:ollama"],
    });
    await start(app);
    await start(other);
    await services.need("ollama", app);
    await settle();
    expect(networksOf("sanctum-ollama")).not.toContain(
      serviceNetworkName(other, "ollama"),
    );

    await services.need("ollama", other);
    await reconcile();
    expect(networksOf("sanctum-ollama")).toContain(
      serviceNetworkName(other, "ollama"),
    );

    await services.release("ollama", app);

    expect(networksOf("sanctum-ollama")).not.toContain(
      serviceNetworkName(app, "ollama"),
    );
    expect(networksOf("sanctum-ollama")).toContain(
      serviceNetworkName(other, "ollama"),
    );
  });

  it("revokes access even when another app's network cannot be read", async () => {
    const { docker, services, settle, start, networksOf } = await home({
      [other]: ["services:ollama"],
      [app]: ["services:ollama"],
    });
    await start(other);
    await start(app);
    await services.need("ollama", other);
    await services.need("ollama", app);
    await settle();
    const getNetwork = docker.getNetwork.bind(docker);
    vi.spyOn(docker, "getNetwork").mockImplementation((name) => {
      const handle = getNetwork(name);
      return name === serviceNetworkName(other, "ollama")
        ? {
            ...handle,
            inspect: async () => {
              throw new Error("Docker didn't answer");
            },
          }
        : handle;
    });

    await services.release("ollama", app);

    expect(networksOf("sanctum-ollama")).not.toContain(
      serviceNetworkName(app, "ollama"),
    );
  });

  it("refuses to let go of an app before it has left the app's network", async () => {
    const { docker, services, settle, start } = await home();
    await start();
    await services.need("ollama", app);
    await settle();
    await services.need("ollama", other);
    const network = serviceNetworkName(app, "ollama");
    const getNetwork = docker.getNetwork.bind(docker);
    vi.spyOn(docker, "getNetwork").mockImplementation((name) => {
      const handle = getNetwork(name);
      return name === network
        ? {
            ...handle,
            disconnect: async () => {
              throw new Error("Docker didn't answer");
            },
          }
        : handle;
    });

    await expect(services.release("ollama", app)).rejects.toThrow(
      /hasn't left/,
    );
  });

  it("removes an app's network with the app", async () => {
    const { docker, apps, services, settle, start, networksOf } = await home();
    await start();
    await services.need("ollama", app);
    await settle();
    const network = serviceNetworkName(app, "ollama");

    await apps.remove(app);

    expect(docker.networks.has(network)).toBe(false);
    expect(networksOf("sanctum-ollama")).not.toContain(network);
  });

  it("refuses an app that would reach it and the broker", async () => {
    const { start, docker } = await home({
      [app]: ["services:ollama", "services:zigbee2mqtt"],
    });

    await expect(start()).rejects.toThrow(/only one of/);
    expect(docker.container(`sanctum-app-${app}`)).toBeUndefined();
  });

  it("replaces the old image without copying its models", async () => {
    const { docker, dataDir, services, settle } = await home();
    await startOlderOllama(docker);
    await services.need("ollama", app);
    await settle();

    await vi.waitFor(() =>
      expect(docker.container("sanctum-ollama")?.options.Image).toBe(
        ollamaImage,
      ),
    );
    expect(await readdir(join(dataDir, "backups")).catch(() => [])).toEqual([]);
    await expect(docker.getImage(olderImage).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("counts half the host's memory beside the apps while it runs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-ollama-capacity-"));
    let wanted: string[] = [];
    const capacity = createCapacity({
      dataDir,
      totalMemory: () => 16 * gib,
      services: () => wanted,
    });
    const before = await capacity.freeMb([]);

    wanted = ["ollama"];

    expect(before - (await capacity.freeMb([]))).toBe(8 * 1024);
  });
});
