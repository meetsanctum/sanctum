import { describe, expect, it, vi } from "vitest";

import {
  sanctumNetworkName,
  coreContainerName,
  coreContainerOptions,
  coreVolumeName,
  hasAppFolders,
  hasInit,
  hasSpeakerPort,
  reconcileCore,
  socketGroupId,
  socketVolumeName,
} from "../src/core-container.js";
import { createReconciler } from "../src/reconcile.js";
import { FakeDocker } from "./fake-docker.js";

const coreImage = "localhost:5000/sanctum-core:dev-1";

function setup() {
  const docker = new FakeDocker();
  docker.load(coreImage, { title: "sanctum-core", version: "dev-1" });
  const log = vi.fn();
  const reconcile = () => reconcileCore({ docker, image: coreImage, log });
  return { docker, log, reconcile };
}

function staleDockerSandbox() {
  return Object.assign(
    new Error(
      "(HTTP code 404) network or container is not found - network sandbox for container test not found",
    ),
    { statusCode: 404 },
  );
}

describe("reconcileCore and the folders apps need", () => {
  // What a manager from before app containers leaves after an update.
  async function olderCore(docker: FakeDocker) {
    const options = coreContainerOptions(coreImage);
    delete options.HostConfig!.Mounts;
    const { id } = await docker.createContainer(options);
    await docker.getContainer(id).start();
    return id;
  }

  it("gives a new core its folders for apps' sockets and packages", async () => {
    const { docker, reconcile } = setup();

    await reconcile();

    const core = await docker.getContainer(coreContainerName).inspect();
    expect(hasAppFolders(core)).toBe(true);
    expect(core.HostConfig.Mounts).toEqual([
      expect.objectContaining({
        Source: "sanctum-manager-data",
        Target: "/run/sanctum-apps",
        VolumeOptions: expect.objectContaining({ Subpath: "sockets" }),
      }),
      expect.objectContaining({
        Source: "sanctum-manager-data",
        Target: "/packages",
        ReadOnly: true,
        VolumeOptions: expect.objectContaining({ Subpath: "packages" }),
      }),
    ]);
  });

  it("recreates once a core without them, on the image it has", async () => {
    const { docker, log } = setup();
    const committed = await olderCore(docker);
    const image = docker.container(coreContainerName)!.imageId;
    // The image a manager would otherwise start, which isn't the committed one.
    docker.load("localhost:5000/sanctum-core:dev-0", {
      title: "sanctum-core",
      version: "dev-0",
    });
    const reconcile = () =>
      reconcileCore({
        docker,
        image: "localhost:5000/sanctum-core:dev-0",
        log,
      });

    await expect(reconcile()).resolves.toBe(image);

    const core = docker.container(coreContainerName)!;
    expect(core.id).not.toBe(committed);
    expect(core).toMatchObject({ imageId: image, running: true });
    expect(hasAppFolders(await docker.getContainer(core.id).inspect())).toBe(
      true,
    );
    // Stopped gently first: it has a database to close.
    const events = docker.events.join("\n");
    expect(events).toContain(`stop ${coreContainerName}`);

    docker.events = [];
    await reconcile();
    await reconcile();
    expect(docker.container(coreContainerName)!.id).toBe(core.id);
    expect(docker.events).toEqual([]);
  });

  it("doesn't keep recreating a core on a Docker too old for subpaths", async () => {
    const { docker, reconcile } = setup();
    docker.onCreate = (options) => {
      for (const mount of (options.HostConfig!.Mounts ?? []) as Array<{
        VolumeOptions?: unknown;
      }>) {
        delete mount.VolumeOptions;
      }
    };
    await reconcile();
    const first = docker.container(coreContainerName)!.id;

    await reconcile();

    expect(docker.container(coreContainerName)!.id).toBe(first);
  });

  it("leaves a core that has them, running as it was", async () => {
    const { docker, reconcile } = setup();
    await reconcile();
    const before = docker.container(coreContainerName)!;
    docker.events = [];

    await reconcile();

    expect(docker.container(coreContainerName)!.id).toBe(before.id);
    expect(docker.events).toEqual([]);
  });

  it("refuses a container of that name that isn't its own", async () => {
    const { docker, reconcile } = setup();
    docker.run({ name: coreContainerName, Image: coreImage });

    await expect(reconcile()).rejects.toThrow("Refusing to manage");
    expect(docker.container(coreContainerName)?.running).toBe(true);
  });
});

describe("reconcileCore and the port speakers fetch sound from", () => {
  // What a manager from before announcements leaves after an update.
  async function olderCore(docker: FakeDocker) {
    const options = coreContainerOptions(coreImage);
    delete (options.HostConfig!.PortBindings as Record<string, unknown>)[
      "4180/tcp"
    ];
    delete (options.ExposedPorts as Record<string, unknown>)["4180/tcp"];
    options.Env = options.Env!.filter(
      (each) => !each.startsWith("CORE_SPEAKER"),
    );
    const { id } = await docker.createContainer(options);
    await docker.getContainer(id).start();
    return id;
  }

  it("keeps the core running without announcements while the port is occupied", async () => {
    const { docker, log } = setup();
    await olderCore(docker);
    const portAvailable = vi.fn(async () => false);
    const reconcile = () =>
      reconcileCore({ docker, image: coreImage, log, portAvailable });
    docker.startError = new Error(
      "Bind for 0.0.0.0:4180 failed: port is already allocated",
    );

    await reconcile();
    const fallback = docker.container(coreContainerName)!;
    expect(fallback.running).toBe(true);
    expect(fallback.options.Env).toContain("CORE_SPEAKER_PORT=0");
    expect(
      hasSpeakerPort(await docker.getContainer(fallback.id).inspect()),
    ).toBe(false);

    docker.events = [];
    await reconcile();
    expect(docker.container(coreContainerName)?.id).toBe(fallback.id);
    expect(docker.events).toEqual([]);

    portAvailable.mockResolvedValue(true);
    await reconcile();
    const restored = docker.container(coreContainerName)!;
    expect(restored.id).not.toBe(fallback.id);
    expect(restored.running).toBe(true);
    expect(
      hasSpeakerPort(await docker.getContainer(restored.id).inspect()),
    ).toBe(true);
  });

  it("recreates once a core without it, on the image it has", async () => {
    const { docker, log, reconcile } = setup();
    const older = await olderCore(docker);
    expect(hasSpeakerPort(await docker.getContainer(older).inspect())).toBe(
      false,
    );

    await reconcile();

    const core = docker.container(coreContainerName)!;
    expect(core.id).not.toBe(older);
    expect(core.running).toBe(true);
    expect(hasSpeakerPort(await docker.getContainer(core.id).inspect())).toBe(
      true,
    );
    expect(core.options.Env).toContain("CORE_SPEAKER_PUBLISHED_PORT=4180");
    expect(log).toHaveBeenCalledWith(
      `Recreating ${coreContainerName} with the port speakers fetch sound from`,
    );

    docker.events = [];
    await reconcile();
    expect(docker.container(coreContainerName)!.id).toBe(core.id);
    expect(docker.events).toEqual([]);
  });
});

describe("reconcileCore and the core's init process", () => {
  // What a manager from before the init process leaves after an update: the
  // core it created, which the manager that replaces it finds.
  async function olderCore(docker: FakeDocker, running = true) {
    const options = coreContainerOptions(coreImage);
    delete options.HostConfig!.Init;
    const { id } = await docker.createContainer(options);
    if (running) await docker.getContainer(id).start();
    return id;
  }

  it("starts a new core with an init process, which reaps what its health check leaves", async () => {
    const { docker, reconcile } = setup();

    await reconcile();

    const core = await docker.getContainer(coreContainerName).inspect();
    expect(hasInit(core)).toBe(true);
    expect(
      docker.container(coreContainerName)!.options.Healthcheck,
    ).toMatchObject({
      Test: [
        "CMD",
        "wget",
        "--no-check-certificate",
        "-qO-",
        "https://127.0.0.1:4100/api/health",
      ],
    });
  });

  it("recreates once a core without one, on the image it has", async () => {
    const { docker, log } = setup();
    const committed = await olderCore(docker);
    const image = docker.container(coreContainerName)!.imageId;
    // The image a manager would otherwise start, which isn't the committed one.
    docker.load("localhost:5000/sanctum-core:dev-0", {
      title: "sanctum-core",
      version: "dev-0",
    });
    const reconcile = () =>
      reconcileCore({
        docker,
        image: "localhost:5000/sanctum-core:dev-0",
        log,
      });

    await expect(reconcile()).resolves.toBe(image);

    const core = docker.container(coreContainerName)!;
    expect(core.id).not.toBe(committed);
    expect(core).toMatchObject({ imageId: image, running: true });
    const inspected = await docker.getContainer(core.id).inspect();
    expect(hasInit(inspected)).toBe(true);
    expect(hasAppFolders(inspected)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      `Recreating ${coreContainerName} with an init process`,
    );
    // Stopped gently first: it has a database to close.
    expect(docker.events.join("\n")).toContain(`stop ${coreContainerName}`);

    docker.events = [];
    await reconcile();
    await reconcile();
    expect(docker.container(coreContainerName)!.id).toBe(core.id);
    expect(docker.events).toEqual([]);
  });

  it("recreates a stopped core without one too, and starts it", async () => {
    const { docker, reconcile } = setup();
    const stopped = await olderCore(docker, false);

    await reconcile();

    const core = docker.container(coreContainerName)!;
    expect(core.id).not.toBe(stopped);
    expect(core.running).toBe(true);
    expect(hasInit(await docker.getContainer(core.id).inspect())).toBe(true);
  });

  it("counts only an init process Docker reports as on", () => {
    const core = coreContainerOptions(coreImage);

    expect(
      hasInit({ HostConfig: { ...core.HostConfig, Init: false } } as never),
    ).toBe(false);
    expect(
      hasInit({ HostConfig: { ...core.HostConfig, Init: null } } as never),
    ).toBe(false);
  });
});

describe("reconcileCore", () => {
  it("creates the network, volume and core when the host is new", async () => {
    const { docker, reconcile } = setup();
    await reconcile();

    expect(docker.networks.get(sanctumNetworkName)).toEqual({
      "sanctum.managed": "true",
    });
    expect(docker.volumes.has(coreVolumeName)).toBe(true);
    expect(docker.volumes.has(socketVolumeName)).toBe(true);
    const core = docker.container(coreContainerName);
    expect(core).toMatchObject({ ref: coreImage, running: true });
    expect(core?.options.HostConfig).toMatchObject({
      // The core reaches the manager through its socket's volume, as a
      // member of the socket's group.
      Binds: [`${coreVolumeName}:/data`, `${socketVolumeName}:/run/sanctum`],
      GroupAdd: [String(socketGroupId)],
      // Speakers fetch announcements on IPv4 only.
      PortBindings: {
        "4100/tcp": [{ HostPort: "4100" }],
        "4180/tcp": [{ HostIp: "0.0.0.0", HostPort: "4180" }],
      },
      RestartPolicy: { Name: "unless-stopped" },
      Init: true,
    });
    expect(core?.networks[sanctumNetworkName]).toBeDefined();
    // The apps' origins may read the core's responses, and it knows where
    // speakers reach it.
    expect(core?.options.Env).toEqual([
      "CORE_ALLOWED_ORIGINS=app://sanctum",
      "CORE_SPEAKER_PORT=4180",
      "CORE_SPEAKER_PUBLISHED_PORT=4180",
    ]);
  });

  it("pulls the core's image only when it is not on the host", async () => {
    const docker = new FakeDocker();
    docker.publish(coreImage, { title: "sanctum-core", version: "dev-1" });
    await reconcileCore({ docker, image: coreImage, log: vi.fn() });

    expect(docker.events).toContain(`pull ${coreImage}`);
  });

  it("starts a stopped core without recreating it", async () => {
    const { docker, reconcile } = setup();
    await reconcile();
    const core = docker.container(coreContainerName);
    if (core) core.running = false;
    docker.events = [];

    await reconcile();

    expect(docker.events).toEqual([`start ${coreContainerName}`]);
    expect(docker.container(coreContainerName)?.id).toBe(core?.id);
  });

  it("leaves a running core alone, whatever image it runs", async () => {
    const { docker, reconcile } = setup();
    docker.load("localhost:5000/sanctum-core:dev-0", {
      title: "sanctum-core",
      version: "dev-0",
    });
    await docker.createNetwork({
      Name: sanctumNetworkName,
      Labels: { "sanctum.managed": "true" },
    });
    docker.run(coreContainerOptions("localhost:5000/sanctum-core:dev-0"));
    docker.container(coreContainerName)!.networks[sanctumNetworkName] = {
      EndpointID: "endpoint",
    };
    docker.events = [];

    await reconcile();

    expect(docker.events).toEqual([]);
  });

  it("reconnects a core that lost its network", async () => {
    const { docker, reconcile } = setup();
    await reconcile();
    docker.container(coreContainerName)!.networks = {};
    docker.events = [];

    await reconcile();

    expect(docker.events).toEqual([
      `connect ${coreContainerName} ${sanctumNetworkName}`,
    ]);
  });

  it("recreates the core when Docker reports a stale network sandbox", async () => {
    const { docker, reconcile } = setup();
    await reconcile();
    const stale = docker.container(coreContainerName);
    stale!.running = false;
    docker.startError = staleDockerSandbox();

    await reconcile();

    const core = docker.container(coreContainerName);
    expect(core?.id).not.toBe(stale?.id);
    expect(core?.running).toBe(true);
  });

  it("refuses to manage a same-name container without Sanctum labels", async () => {
    const { docker, reconcile } = setup();
    docker.run({ name: coreContainerName, Image: coreImage });

    await expect(reconcile()).rejects.toThrow(
      `Refusing to manage unlabelled ${coreContainerName}`,
    );
  });

  it("refuses unlabelled networks and volumes", async () => {
    const { docker, reconcile } = setup();
    await docker.createVolume({ Name: coreVolumeName });

    await expect(reconcile()).rejects.toThrow(
      `Refusing to manage unlabelled ${coreVolumeName} volume`,
    );

    docker.volumes.clear();
    await docker.createNetwork({ Name: sanctumNetworkName });
    await expect(reconcile()).rejects.toThrow(
      `Refusing to manage unlabelled ${sanctumNetworkName} network`,
    );
  });
});

describe("createReconciler", () => {
  it("runs one reconcile at a time", async () => {
    let release = () => {};
    const run = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const reconciler = createReconciler({ intervalMs: 0, log: vi.fn(), run });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips runs while paused and logs failures", async () => {
    const log = vi.fn();
    let paused = true;
    const run = vi.fn(async () => {
      throw new Error("Docker is away");
    });
    const reconciler = createReconciler({
      intervalMs: 0,
      log,
      paused: async () => paused,
      run,
    });

    await reconciler.start();
    expect(run).not.toHaveBeenCalled();

    paused = false;
    await reconciler.reconcile();
    expect(log).toHaveBeenCalledWith("Reconcile failed: Docker is away");
  });
});
