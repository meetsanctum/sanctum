import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  appContainerName,
  appContainerOptions,
  createAppContainers,
  ensureAppFolders,
  nodeImage,
} from "../src/apps/containers.js";
import { AppRefusal } from "../src/apps/refusal.js";
import {
  coreContainerName,
  coreContainerOptions,
} from "../src/core-container.js";
import { FakeDocker } from "./fake-docker.js";

const app = "sanctum.weather";
const dataVolume = "sanctum-app-data-sanctum.weather";
const folder = "0.3.0+1a2b3c4d5e6f7a8b";
const mebibyte = 1024 * 1024;
const gibibyte = 1024 * mebibyte;

async function staged(dataDir: string, id: string, version = folder) {
  const path = join(dataDir, "packages", id, version);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), "{}");
}

async function setup(total = 8 * gibibyte) {
  const docker = new FakeDocker();
  docker.load(nodeImage, { title: "node", version: "24" });
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-apps-"));
  await staged(dataDir, app);
  const owned: string[] = [];
  const ensure = vi.fn(
    async (
      _app: string,
      _sizeMb: number,
      _releaseVolume: () => Promise<void>,
    ) => dataVolume,
  );
  const apps = createAppContainers({
    docker,
    dataDir,
    log: vi.fn(),
    totalMemory: () => total,
    ownFolder: async (path) => void owned.push(path),
    images: { ensure },
  });
  return { apps, dataDir, docker, ensure, owned };
}

const start = { app, folder, memoryMb: 128 };

describe("an app's container", () => {
  it("holds it to what the standard allows", () => {
    const options = appContainerOptions(start, dataVolume);

    expect(options).toMatchObject({
      name: appContainerName(app),
      Image: nodeImage,
      User: "1000:1000",
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "size=16m" },
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Memory: 128 * mebibyte,
        // Docker otherwise allows as much again in swap.
        MemorySwap: 128 * mebibyte,
        NanoCpus: 500_000_000,
        PidsLimit: 64,
        RestartPolicy: { Name: "no" },
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "10m", "max-file": "3" },
        },
      },
    });
    expect(options.HostConfig).not.toHaveProperty("Privileged", true);
  });

  it("mounts only its package, read-only, and its own socket folder", () => {
    const mounts = appContainerOptions(start, dataVolume).HostConfig!.Mounts;

    expect(mounts).toEqual([
      expect.objectContaining({
        Target: "/package",
        ReadOnly: true,
        VolumeOptions: expect.objectContaining({
          Subpath: `packages/${app}/${folder}`,
        }),
      }),
      expect.objectContaining({
        Target: "/run/sanctum-app",
        ReadOnly: true,
        VolumeOptions: expect.objectContaining({ Subpath: `sockets/${app}` }),
      }),
      expect.objectContaining({ Source: dataVolume, Target: "/data" }),
    ]);
  });

  it("sizes Node's heap below its limit", () => {
    expect(appContainerOptions(start, dataVolume).Cmd).toEqual(
      expect.arrayContaining([
        "--max-old-space-size=96",
        "--max-semi-space-size=2",
      ]),
    );
  });

  it("runs on the Node image the core and the manager are built on", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    for (const file of [
      "apps/core/Dockerfile",
      "apps/manager/Dockerfile",
      "deploy/dev/stack.Dockerfile",
    ]) {
      const bases = (await readFile(join(root, file), "utf8"))
        .split("\n")
        .filter((line) => /^FROM node/.test(line))
        .map((line) => line.split(" ")[1]);
      expect(bases.length).toBeGreaterThan(0);
      expect(new Set(bases)).toEqual(new Set([nodeImage]));
    }
  });
});

describe("starting one", () => {
  it("makes its socket folder its user's, and starts it", async () => {
    const { apps, dataDir, docker, owned } = await setup();

    const status = await apps.start(start);

    expect(status).toMatchObject({
      app,
      state: "running",
      folder,
      memoryMb: 128,
    });
    expect(docker.container(appContainerName(app))?.running).toBe(true);
    const sockets = join(dataDir, "sockets", app);
    expect(owned).toEqual([sockets]);
    expect((await stat(sockets)).mode & 0o777).toBe(0o700);
  });

  it("asks for its data's image, 256 MB unless it says", async () => {
    const { apps, ensure } = await setup();

    await apps.start(start);
    await apps.start({ ...start, dataMb: 1024 });

    expect(ensure).toHaveBeenNthCalledWith(1, app, 256, expect.any(Function));
    expect(ensure).toHaveBeenNthCalledWith(2, app, 1024, expect.any(Function));
  });

  it("keeps what runs when its image can't be used", async () => {
    const { apps, docker, ensure } = await setup();
    await apps.start(start);
    const running = docker.container(appContainerName(app))!.id;
    ensure.mockRejectedValueOnce(
      new AppRefusal(`${app}'s data is damaged`, 409),
    );

    await expect(apps.start(start)).rejects.toThrow("damaged");

    expect(docker.container(appContainerName(app))).toMatchObject({
      id: running,
      running: true,
    });
  });

  it("releases stopped containers when their image needs a different device", async () => {
    const { apps, docker, ensure } = await setup();
    await apps.start(start);
    await apps.stop(app);
    const previous = docker.container(appContainerName(app))!.id;
    ensure.mockImplementationOnce(async (_app, _sizeMb, releaseVolume) => {
      await releaseVolume();
      expect(docker.container(appContainerName(app))).toBeUndefined();
      return dataVolume;
    });

    await apps.start(start);

    expect(docker.container(appContainerName(app))!.id).not.toBe(previous);
  });

  it("refuses to release an image while its app is running", async () => {
    const { apps, docker, ensure } = await setup();
    await apps.start(start);
    const previous = docker.container(appContainerName(app))!.id;
    ensure.mockImplementationOnce(async (_app, _sizeMb, releaseVolume) => {
      await releaseVolume();
      return dataVolume;
    });

    await expect(apps.start(start)).rejects.toMatchObject({ status: 409 });

    expect(docker.container(appContainerName(app))).toMatchObject({
      id: previous,
      running: true,
    });
  });

  it("refuses a package that isn't staged, and touches nothing", async () => {
    const { apps, docker } = await setup();

    await expect(
      apps.start({ ...start, folder: "9.9.9+none" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(docker.container(appContainerName(app))).toBeUndefined();
  });

  it("pulls Node's image if the host doesn't have it", async () => {
    const { apps, docker } = await setup();
    docker.images.clear();
    docker.publish(nodeImage, { title: "node", version: "24" });

    await apps.start(start);

    expect(docker.events).toContain(`pull ${nodeImage}`);
  });

  it("keeps the running app if its next Node image can't be pulled", async () => {
    const { apps, docker } = await setup();
    docker.images.clear();
    docker.registry.clear();
    const previousImage = "node:previous";
    docker.load(previousImage, { title: "node", version: "previous" });
    const previous = docker.run({
      ...appContainerOptions(start, dataVolume),
      Image: previousImage,
    });

    await expect(apps.start(start)).rejects.toThrow("not found");

    expect(docker.container(appContainerName(app))).toBe(previous);
    expect(previous.running).toBe(true);
  });

  it("replaces the container it had, as the core does when it restarts", async () => {
    const { apps, dataDir, docker } = await setup();
    await apps.start(start);
    const first = docker.container(appContainerName(app))!.id;
    await staged(dataDir, app, "0.4.0+aaaa");

    const status = await apps.start({ ...start, folder: "0.4.0+aaaa" });

    expect(docker.container(appContainerName(app))!.id).not.toBe(first);
    expect(status.folder).toBe("0.4.0+aaaa");
  });

  describe("keeping the one that runs, as after the core restarted", () => {
    it("keeps one running that package, made as it would make it now", async () => {
      const { apps, docker } = await setup();
      await apps.start(start);
      const first = docker.container(appContainerName(app))!.id;
      docker.events.length = 0;

      const status = await apps.start(start, { keep: true });

      expect(status).toMatchObject({ state: "running", folder, kept: true });
      expect(docker.container(appContainerName(app))!.id).toBe(first);
      expect(docker.events).toEqual([]);
    });

    it.each([
      ["another package", { folder: "0.4.0+aaaa" }],
      ["another memory limit", { memoryMb: 256 }],
    ])("starts another for %s", async (_what, change) => {
      const { apps, dataDir, docker } = await setup();
      await apps.start(start);
      const first = docker.container(appContainerName(app))!.id;
      await staged(dataDir, app, "0.4.0+aaaa");

      const status = await apps.start({ ...start, ...change }, { keep: true });

      expect(status.kept).toBeUndefined();
      expect(docker.container(appContainerName(app))!.id).not.toBe(first);
    });

    it("starts another for one a manager before this one made otherwise", async () => {
      const { apps, docker } = await setup();
      docker.onCreate = (options) => {
        options.Env = [...(options.Env ?? []), "LEFT=by an older manager"];
        options.Cmd = ["node", "an-older-runner.js"];
      };
      await apps.start(start);
      docker.onCreate = null;
      const first = docker.container(appContainerName(app))!.id;

      const status = await apps.start(start, { keep: true });

      expect(status.kept).toBeUndefined();
      expect(docker.container(appContainerName(app))!.id).not.toBe(first);
    });

    it("starts one that has stopped again", async () => {
      const { apps, docker } = await setup();
      await apps.start(start);
      await apps.stop(app);

      const status = await apps.start(start, { keep: true });

      expect(status).toMatchObject({ state: "running" });
      expect(status.kept).toBeUndefined();
      expect(docker.events).toContain(`start ${appContainerName(app)}`);
    });

    it("replaces it unless asked to keep it", async () => {
      const { apps, docker } = await setup();
      await apps.start(start);
      const first = docker.container(appContainerName(app))!.id;

      await apps.start(start);

      expect(docker.container(appContainerName(app))!.id).not.toBe(first);
    });

    it("replaces one mounted on another app's data volume", async () => {
      const { apps, docker } = await setup();
      const options = appContainerOptions(
        start,
        "sanctum-app-data-sanctum.example",
      );
      const first = docker.run(options).id;

      const status = await apps.start(start, { keep: true });

      expect(status.kept).toBeUndefined();
      expect(docker.container(appContainerName(app))!.id).not.toBe(first);
      expect(
        docker.container(appContainerName(app))!.options.HostConfig!.Mounts,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Target: "/data", Source: dataVolume }),
        ]),
      );
    });

    it.each([
      [
        "an obsolete environment variable",
        {
          Env: [
            ...appContainerOptions(start, dataVolume).Env!,
            "NODE_OPTIONS=--no-warnings",
          ],
        },
      ],
      ["another working directory", { WorkingDir: "/tmp" }],
    ])("replaces one with %s", async (_what, change) => {
      const { apps, docker } = await setup();
      const first = docker.run({
        ...appContainerOptions(start, dataVolume),
        ...change,
      }).id;

      const status = await apps.start(start, { keep: true });

      expect(status.kept).toBeUndefined();
      expect(docker.container(appContainerName(app))!.id).not.toBe(first);
    });
  });

  describe("when it can't replace the one that runs", () => {
    it("keeps that one running if Docker can't create the new one", async () => {
      const { apps, docker } = await setup();
      await apps.start(start);
      const running = docker.container(appContainerName(app))!.id;
      docker.onCreate = () => {
        throw new Error("Docker is busy");
      };

      await expect(apps.start(start)).rejects.toThrow("Docker is busy");

      const container = docker.container(appContainerName(app))!;
      expect(container).toMatchObject({ id: running, running: true });
    });

    it("keeps that one running if Docker wouldn't give the new one its settings", async () => {
      const { apps, docker } = await setup();
      await apps.start(start);
      const running = docker.container(appContainerName(app))!.id;
      docker.onCreate = (options) => {
        Object.assign(options.HostConfig!, { CapDrop: [] });
      };

      await expect(apps.start(start)).rejects.toThrow("its capabilities");

      const container = docker.container(appContainerName(app))!;
      expect(container).toMatchObject({ id: running, running: true });
      expect(docker.container(`${appContainerName(app)}-next`)).toBeUndefined();
    });
  });

  it("clears one a crash left on its way to replacing the app's, and doesn't list it", async () => {
    const { apps, docker } = await setup();
    await apps.start(start);
    const next = `${appContainerName(app)}-next`;
    await docker.createContainer({
      ...appContainerOptions(start, dataVolume),
      name: next,
    });

    expect((await apps.list()).map((each) => each.app)).toEqual([app]);
    await apps.start(start);

    expect(docker.container(next)).toBeUndefined();
    expect(docker.container(appContainerName(app))?.running).toBe(true);
  });

  it("leaves a container a person made alone", async () => {
    const { apps, docker } = await setup();
    docker.run({ name: appContainerName(app), Image: nodeImage });

    await expect(apps.start(start)).rejects.toThrow("Refusing to manage");
    expect(docker.container(appContainerName(app))?.running).toBe(true);
  });

  it("starts them one at a time", async () => {
    const { apps, dataDir, docker } = await setup(2 * gibibyte);
    await staged(dataDir, "sanctum.moods");

    const results = await Promise.allSettled([
      apps.start({ ...start, memoryMb: 600 }),
      apps.start({ app: "sanctum.moods", folder, memoryMb: 600 }),
    ]);

    // Together they don't fit, and each saw the other.
    expect(results.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(docker.container(appContainerName("sanctum.moods"))).toBeUndefined();
  });
});

describe("what Docker really gave it", () => {
  it.each([
    ["its capabilities", { CapDrop: [] }],
    ["its network", { NetworkMode: "bridge" }],
    ["its read-only root", { ReadonlyRootfs: false }],
    ["its privileges", { Privileged: true }],
    ["its processes", { PidsLimit: 0 }],
    ["its memory", { Memory: 0 }],
    ["its folders", { Mounts: [] }],
    ["its restarts", { RestartPolicy: { Name: "always" } }],
  ])("refuses to start it without %s", async (what, change) => {
    const { apps, docker } = await setup();
    docker.onCreate = (options) => {
      Object.assign(options.HostConfig!, change);
    };

    const refusal = await apps.start(start).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(AppRefusal);
    expect((refusal as AppRefusal).message).toContain(what);
    expect(docker.events).not.toContain(`start ${appContainerName(app)}`);
    expect(docker.container(appContainerName(app))).toBeUndefined();
  });

  it("starts it without memory limits where the kernel has none to give", async () => {
    const { apps, docker } = await setup();
    docker.memoryLimit = false;

    await expect(apps.start(start)).resolves.toMatchObject({
      state: "running",
    });
    await expect(apps.memoryLimits()).resolves.toBe(false);
  });
});

describe("whether it fits beside the rest", () => {
  it("keeps a quarter of the machine for the host, or at least 1 GB", async () => {
    const { apps } = await setup(2 * gibibyte);

    await expect(
      apps.start({ ...start, memoryMb: 1024 }),
    ).resolves.toBeDefined();
    await expect(
      apps.start({ ...start, memoryMb: 1025 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("counts the others that run, and says what's left", async () => {
    const { apps, dataDir } = await setup(2 * gibibyte);
    await staged(dataDir, "sanctum.moods");
    await apps.start({ ...start, memoryMb: 800 });

    await expect(
      apps.start({ app: "sanctum.moods", folder, memoryMb: 512 }),
    ).rejects.toThrow("needs 512 MB, and only 224 MB are left");
  });

  it("doesn't count one that has stopped", async () => {
    const { apps, dataDir } = await setup(2 * gibibyte);
    await staged(dataDir, "sanctum.moods");
    await apps.start({ ...start, memoryMb: 800 });
    await apps.stop(app);

    await expect(
      apps.start({ app: "sanctum.moods", folder, memoryMb: 512 }),
    ).resolves.toMatchObject({ state: "running" });
  });

  it("doesn't count the one it replaces", async () => {
    const { apps } = await setup(2 * gibibyte);
    await apps.start({ ...start, memoryMb: 800 });

    await expect(
      apps.start({ ...start, memoryMb: 900 }),
    ).resolves.toMatchObject({ memoryMb: 900 });
  });
});

describe("work on its image", () => {
  it("is refused while it runs, unless it can go on beside it", async () => {
    const { apps } = await setup();
    await apps.start(start);
    const work = vi.fn(async () => "done");

    await expect(apps.onItsImage(app, work)).rejects.toMatchObject({
      status: 409,
    });
    expect(work).not.toHaveBeenCalled();

    await expect(
      apps.onItsImage(app, work, { whileRunning: true }),
    ).resolves.toBe("done");
  });

  it("goes ahead once it has stopped", async () => {
    const { apps } = await setup();
    await apps.start(start);
    await apps.stop(app);

    await expect(apps.onItsImage(app, async () => "done")).resolves.toBe(
      "done",
    );
  });

  it("waits for a start under way, and a start waits for it", async () => {
    const { apps, docker } = await setup();
    const order: string[] = [];
    let finish = () => {};
    const growing = apps.onItsImage(app, async () => {
      order.push("growing");
      await new Promise<void>((done) => (finish = done));
      order.push("grown");
    });
    const starting = apps.start(start).then(() => order.push("started"));
    await vi.waitFor(() => expect(order).toEqual(["growing"]));
    expect(docker.container(appContainerName(app))).toBeUndefined();

    finish();
    await Promise.all([growing, starting]);

    expect(order).toEqual(["growing", "grown", "started"]);
  });
});

describe("when it stops", () => {
  it("says how, and keeps the container until it starts again", async () => {
    const { apps, docker } = await setup();
    await apps.start(start);

    const status = await apps.stop(app);

    expect(status).toMatchObject({
      state: "stopped",
      exitCode: 143,
      outOfMemory: false,
      finishedAt: expect.any(String),
    });
    expect(docker.container(appContainerName(app))).toBeDefined();
  });

  it("says when it ran out of memory", async () => {
    const { apps, docker } = await setup();
    await apps.start(start);
    const container = docker.container(appContainerName(app))!;
    Object.assign(container, {
      running: false,
      exitCode: 137,
      oomKilled: true,
      finishedAt: new Date(),
    });

    await expect(apps.status(app)).resolves.toMatchObject({
      state: "stopped",
      exitCode: 137,
      outOfMemory: true,
    });
  });

  it("reports an app that exits just before Docker stops it", async () => {
    const { apps, docker } = await setup();
    await apps.start(start);
    const getContainer = docker.getContainer.bind(docker);
    vi.spyOn(docker, "getContainer").mockImplementation((id) => ({
      ...getContainer(id),
      stop: async () => {
        Object.assign(docker.container(appContainerName(app))!, {
          running: false,
          exitCode: 3,
          finishedAt: new Date(),
        });
        throw Object.assign(new Error("container already stopped"), {
          statusCode: 304,
        });
      },
    }));

    await expect(apps.stop(app)).resolves.toMatchObject({
      state: "stopped",
      exitCode: 3,
    });
  });

  it("reports a failed stop while the app still runs", async () => {
    const { apps, docker } = await setup();
    await apps.start(start);
    const getContainer = docker.getContainer.bind(docker);
    vi.spyOn(docker, "getContainer").mockImplementation((id) => ({
      ...getContainer(id),
      stop: async () => {
        throw new Error("Docker couldn't stop it");
      },
    }));

    await expect(apps.stop(app)).rejects.toThrow("Docker couldn't stop it");
    await expect(apps.status(app)).resolves.toMatchObject({ state: "running" });
  });

  it("says nothing of an exit before it first stops", async () => {
    const { apps } = await setup();

    const status = await apps.start(start);

    expect(status).not.toHaveProperty("exitCode");
  });

  it("is gone once removed", async () => {
    const { apps, docker } = await setup();
    await apps.start(start);

    await apps.remove(app);

    expect(docker.container(appContainerName(app))).toBeUndefined();
    await expect(apps.status(app)).resolves.toEqual({ app, state: "none" });
    expect(docker.removedKeepingVolumes).toEqual([]);
  });

  it("lists apps' containers and no others", async () => {
    const { apps, docker } = await setup();
    docker.load("sanctum-core:1", { title: "sanctum-core", version: "1" });
    await docker.createContainer(coreContainerOptions("sanctum-core:1"));
    await apps.start(start);

    const list = await apps.list();

    expect(list.map((each) => each.app)).toEqual([app]);
  });
});

describe("whether the manager can run apps yet", () => {
  it("can't until the core's container has what apps need", async () => {
    const { apps, docker } = await setup();
    docker.load("sanctum-core:1", { title: "sanctum-core", version: "1" });
    await expect(apps.ready()).resolves.toBe(false);

    const old = coreContainerOptions("sanctum-core:1");
    delete old.HostConfig!.Mounts;
    await docker.createContainer(old);
    await expect(apps.ready()).resolves.toBe(false);

    await docker.getContainer(coreContainerName).remove({ v: true });
    await docker.createContainer(coreContainerOptions("sanctum-core:1"));
    await expect(apps.ready()).resolves.toBe(true);
  });

  it("can't while a Docker too old for subpaths gives the core the whole volume", async () => {
    const { apps, docker } = await setup();
    docker.load("sanctum-core:1", { title: "sanctum-core", version: "1" });
    docker.onCreate = (options) => {
      for (const mount of options.HostConfig!.Mounts as Array<{
        VolumeOptions?: unknown;
      }>) {
        delete mount.VolumeOptions;
      }
    };
    await docker.createContainer(coreContainerOptions("sanctum-core:1"));

    await expect(apps.ready()).resolves.toBe(false);
  });

  it("makes the folders the core's container mounts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-apps-"));

    await ensureAppFolders(dataDir);
    await ensureAppFolders(dataDir);

    expect((await stat(join(dataDir, "sockets"))).isDirectory()).toBe(true);
    expect((await stat(join(dataDir, "packages"))).isDirectory()).toBe(true);
  });
});
