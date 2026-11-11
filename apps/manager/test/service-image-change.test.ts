import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import { zbt2 } from "./host-dev.js";
import {
  bridge,
  hasImage,
  managedVolume,
  oldImage,
  scratch,
  setup,
  volume,
} from "./service-image-support.js";

const durable = vi.hoisted(() => ({
  onFileSystemSync: async (_path: string) => {},
}));

vi.mock("../src/durable.js", async (original) => ({
  ...(await original<typeof import("../src/durable.js")>()),
  syncFileSystem: (path: string) => durable.onFileSystemSync(path),
}));

beforeEach(() => {
  durable.onFileSystemSync = async () => {};
});

describe("a service's new image", () => {
  it("copies the data of the stopped service before the new version runs on it", async () => {
    const { copied, copies, docker, services, store } = await setup();

    await services.reconcile();

    const events = docker.events.slice(
      docker.events.indexOf(`pull ${zigbee2mqttImage}`),
    );
    expect(events).toEqual([
      `pull ${zigbee2mqttImage}`,
      `stop ${bridge}`,
      `create ${scratch} 2.14.2`,
      `read ${volume}`,
      `remove ${scratch}`,
      `stop ${bridge}`,
      `remove ${bridge}`,
      `create ${bridge} 2.14.2`,
      `start ${bridge}`,
    ]);
    const [copy] = await copies();
    expect(copy).toMatch(/^zigbee2mqtt-\d{8}T\d{6}\.\d{3}-2\.13\.0$/);
    expect(await copied(copy!)).toBe("the network key");
    expect(docker.volumeData.get(volume)).toBe("migrated");
    // An image may declare volumes of its own, as the broker's does for logs.
    expect(docker.removedKeepingVolumes).not.toContain(scratch);
    expect(services.status("zigbee2mqtt")).toMatchObject({
      state: "running",
      image: zigbee2mqttImage,
    });
    // The way back stays until the new version has stayed up.
    expect(hasImage(docker, oldImage)).toBe(true);
    expect(store.current().imageChanges?.zigbee2mqtt).toMatchObject({
      from: oldImage,
      to: zigbee2mqttImage,
      status: "checking",
    });
  });

  it("has the copy on the disk before it takes its name or the new version starts", async () => {
    const { backups, docker, services } = await setup();
    const seen: Array<{ partial: boolean; started: boolean }> = [];
    durable.onFileSystemSync = async () => {
      seen.push({
        partial: (await readdir(backups)).every((name) =>
          name.endsWith(".partial"),
        ),
        started: docker.events.some((event) => event === `start ${bridge}`),
      });
    };
    docker.events = [];

    await services.reconcile();

    expect(seen).toEqual([{ partial: true, started: false }]);
  });

  it("keeps the copy for root alone, since it holds the network key", async () => {
    const { backups, copies, services } = await setup();

    await services.reconcile();

    const [copy] = await copies();
    expect((await stat(join(backups, copy!))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(backups, copy!, `${volume}.tar`))).mode & 0o777,
    ).toBe(0o600);
  });

  it("copies nothing on a first start, or when only the definition changes", async () => {
    const { copies, docker, services } = await setup({ running: false });
    docker.volumes.delete(volume);
    docker.volumeData.delete(volume);

    await services.reconcile();
    // A second app gets an account: the broker is replaced, on the same image.
    await services.need("zigbee2mqtt", "sanctum.other");
    docker.events = [];
    await services.reconcile();

    expect(await copies()).toEqual([]);
    expect(docker.events).toContain("remove sanctum-mosquitto");
    expect(docker.container("sanctum-mosquitto-copy")).toBeUndefined();
  });

  it("copies a volume that has no container left when a new image first runs on it", async () => {
    const { copied, copies, docker, services, store } = await setup({
      running: false,
    });
    // The service ran on the old image, then no app needed it for a while.
    await store.update((draft) => {
      draft.images = { zigbee2mqtt: oldImage };
    });

    await services.reconcile();

    const [copy] = await copies();
    expect(await copied(copy!)).toBe("the network key");
    expect(docker.container(scratch)).toBeUndefined();
    expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
    expect(store.current().imageChanges?.zigbee2mqtt?.from).toBe(oldImage);
  });

  it("does not copy twice when a crash came between the copy and the swap", async () => {
    const { copies, docker, services, start, store } = await setup();
    await services.reconcile();
    const before = await copies();
    // As if the manager had gone down right after saving the copy.
    docker.containers.delete(docker.container(bridge)!.id);
    docker.run({
      name: bridge,
      Image: oldImage,
      Labels: {
        "sanctum.managed": "true",
        "sanctum.role": "zigbee2mqtt",
        "sanctum.definition": "from-an-older-manager",
      },
      HostConfig: { Binds: [`${volume}:/app/data`] },
    }).running = false;
    expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe("checking");

    const restarted = await start();
    await restarted.services.reconcile();

    expect(await copies()).toEqual(before);
    expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
  });

  describe("when the copy fails", () => {
    it("leaves the old service and its data alone when Docker cannot stop it", async () => {
      const { copies, docker, services, store } = await setup();
      const getContainer = docker.getContainer.bind(docker);
      const containers = vi
        .spyOn(docker, "getContainer")
        .mockImplementation((id) => {
          const container = getContainer(id);
          return id === docker.container(bridge)?.id
            ? {
                ...container,
                stop: async () => {
                  throw new Error("Docker could not stop the service");
                },
              }
            : container;
        });

      await services.reconcile();

      expect(await copies()).toEqual([]);
      expect(docker.events).not.toContain(`read ${volume}`);
      expect(docker.volumeData.get(volume)).toBe("the network key");
      expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
      expect(docker.container(bridge)?.running).toBe(true);
      expect(store.current().imageChanges?.zigbee2mqtt).toBeUndefined();
      expect(services.status("zigbee2mqtt")).toMatchObject({
        state: "failed",
        problem: "Docker could not stop the service",
      });

      containers.mockRestore();
      await services.reconcile();

      expect(await copies()).toHaveLength(1);
      expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
    });

    it("keeps the service on its version, without stopping it again until a new manager tries", async () => {
      const { copies, docker, seen, services, start } = await setup();
      docker.getArchiveError = new Error("No space left on device");

      await services.reconcile();

      expect(await copies()).toEqual([]);
      expect(docker.volumeData.get(volume)).toBe("the network key");
      expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
      expect(docker.container(bridge)?.running).toBe(true);
      expect(docker.container(scratch)).toBeUndefined();
      expect(services.status("zigbee2mqtt")).toMatchObject({
        state: "running",
        image: oldImage,
      });
      // The household sees it stop, and start again.
      expect(seen.at(-2)).toMatchObject({
        state: "failed",
        problem: "No copy of its data: No space left on device",
      });

      docker.events = [];
      await services.reconcile();
      expect(docker.events).toEqual([]);

      docker.getArchiveError = null;
      const restarted = await start();
      await restarted.services.reconcile();
      expect(await copies()).toHaveLength(1);
      expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
    });

    it("leaves the old container running when the new image cannot be pulled", async () => {
      const { copies, docker, services } = await setup();
      docker.registry.delete(zigbee2mqttImage);

      await services.reconcile();

      expect(await copies()).toEqual([]);
      expect(docker.container(bridge)?.running).toBe(true);
      expect(docker.events).not.toContain(`stop ${bridge}`);
    });
  });

  describe("once the new version has stayed up", () => {
    it("drops the old image and the oldest copies, and forgets the change", async () => {
      const { backups, copies, docker, services, settle, store } =
        await setup();
      for (const old of ["1", "2", "3"]) {
        await mkdir(join(backups, `zigbee2mqtt-20260101T00000${old}-1.0.0`), {
          recursive: true,
        });
      }
      await mkdir(join(backups, "core-20260101T000000-dev"));
      await services.reconcile();
      expect(await copies()).toHaveLength(5);

      // Too early to tell.
      await services.reconcile();
      expect(hasImage(docker, oldImage)).toBe(true);
      expect(store.current().imageChanges?.zigbee2mqtt).toBeDefined();

      settle();
      await services.reconcile();

      expect(hasImage(docker, oldImage)).toBe(false);
      expect(store.current().imageChanges?.zigbee2mqtt).toBeUndefined();
      expect(store.current().images?.zigbee2mqtt).toBe(zigbee2mqttImage);
      const left = await copies();
      expect(left).toHaveLength(4);
      expect(left).toContain("core-20260101T000000-dev");
      expect(left).not.toContain("zigbee2mqtt-20260101T000001-1.0.0");
      expect(left.at(-1)).toMatch(/-2\.13\.0$/);
      expect(docker.volumeData.get(volume)).toBe("migrated");
    });

    it("takes no copy on later passes", async () => {
      const { copies, docker, services, settle } = await setup();
      await services.reconcile();
      settle();
      await services.reconcile();
      docker.events = [];

      await services.reconcile();

      expect(docker.events).toEqual([]);
      expect(await copies()).toHaveLength(1);
    });
  });

  describe("when the new version does not come up", () => {
    it("puts back the data and the version before when Docker keeps restarting it", async () => {
      const { crashLoop, docker, seen, services, store } = await setup();
      await services.reconcile();
      expect(docker.volumeData.get(volume)).toBe("migrated");
      crashLoop();
      docker.events = [];

      await services.reconcile();

      expect(docker.events).toEqual([
        `stop ${bridge}`,
        `remove ${bridge}`,
        `remove volume ${volume}`,
        `create ${scratch} 2.13.0`,
        `write ${volume}`,
        `remove ${scratch}`,
        `create ${bridge} 2.13.0`,
        `start ${bridge}`,
      ]);
      expect(docker.volumeData.get(volume)).toBe("the network key");
      expect(docker.volumes.get(volume)).toEqual(managedVolume);
      expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
      expect(hasImage(docker, zigbee2mqttImage)).toBe(false);
      expect(services.status("zigbee2mqtt")).toMatchObject({
        state: "running",
        image: oldImage,
      });
      expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe(
        "kept-back",
      );
      expect(store.current().images?.zigbee2mqtt).toBe(oldImage);
      expect(seen.at(-2)).toMatchObject({
        state: "failed",
        problem: expect.stringContaining("did not come up"),
      });
    });

    it("has what it put back on the disk before it notes that it did", async () => {
      const { crashLoop, docker, services, store } = await setup();
      await services.reconcile();
      crashLoop();
      const seen: Array<{ data?: string; status?: string }> = [];
      durable.onFileSystemSync = async () => {
        seen.push({
          data: docker.volumeData.get(volume),
          status: store.current().imageChanges?.zigbee2mqtt?.status,
        });
      };

      await services.reconcile();

      expect(seen).toEqual([{ data: "the network key", status: "restoring" }]);
    });

    it("puts them back when it could not start at all", async () => {
      const { docker, services } = await setup();
      // The broker starts first; the next start is the new version's.
      docker.onStart = () => {
        docker.startError = new Error("exec format error");
        docker.onStart = null;
      };
      await services.reconcile();
      expect(services.status("zigbee2mqtt")).toMatchObject({ state: "failed" });
      expect(docker.volumeData.get(volume)).toBe("the network key");

      await services.reconcile();

      expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
      expect(services.status("zigbee2mqtt")).toMatchObject({
        state: "running",
        image: oldImage,
      });
    });

    it("waits out a single restart", async () => {
      const { docker, services, store } = await setup();
      await services.reconcile();
      docker.container(bridge)!.restartCount = 1;

      await services.reconcile();

      expect(docker.volumeData.get(volume)).toBe("migrated");
      expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe(
        "checking",
      );
    });

    it("does not take a stop for not coming up, as while its coordinator is unplugged", async () => {
      const { dev, docker, services, store } = await setup();
      await services.reconcile();

      await dev.unplug(zbt2, "ttyACM0");
      await services.reconcile();
      expect(docker.container(bridge)?.running).toBe(false);

      await dev.plug(zbt2, "ttyACM0");
      await services.reconcile();

      expect(docker.volumeData.get(volume)).toBe("migrated");
      expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
      expect(docker.container(bridge)?.running).toBe(true);
      expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe(
        "checking",
      );
    });

    it("stays on the version before, across restarts of the manager", async () => {
      const { copies, crashLoop, docker, services, start } = await setup();
      await services.reconcile();
      crashLoop();
      await services.reconcile();
      docker.events = [];

      await services.reconcile();
      const restarted = await start();
      await restarted.services.reconcile();

      expect(docker.events).toEqual([]);
      expect(await copies()).toHaveLength(1);
      expect(restarted.services.status("zigbee2mqtt")).toMatchObject({
        state: "running",
        image: oldImage,
      });
    });

    it("tries again when the manager brings another version", async () => {
      const { copies, crashLoop, docker, services, start, store } =
        await setup();
      await services.reconcile();
      crashLoop();
      await services.reconcile();
      docker.onStart = null;
      // The refused version was not this manager's.
      await store.update((draft) => {
        draft.imageChanges!.zigbee2mqtt!.to =
          "ghcr.io/koenkk/zigbee2mqtt:2.14.1";
      });

      const restarted = await start();
      await restarted.services.reconcile();

      expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
      expect(await copies()).toHaveLength(2);
      expect(restarted.store.current().imageChanges?.zigbee2mqtt).toMatchObject(
        { from: oldImage, status: "checking" },
      );
    });

    it("finishes a put-back that a crash interrupted, starting nothing on half its data", async () => {
      const { crashLoop, docker, services, start } = await setup();
      await services.reconcile();
      crashLoop();
      docker.putArchiveError = new Error("The manager went down");

      await services.reconcile();

      expect(docker.volumeData.has(volume)).toBe(false);
      expect(docker.container(bridge)).toBeUndefined();
      expect(services.status("zigbee2mqtt")).toMatchObject({ state: "failed" });
      // A container can outlive the manager, holding the volume.
      docker.run({
        name: scratch,
        Image: oldImage,
        Labels: {
          "sanctum.managed": "true",
          "sanctum.role": "zigbee2mqtt-copy",
        },
        HostConfig: { Binds: [`${volume}:/app/data`] },
      });

      const restarted = await start();
      await restarted.services.reconcile();

      expect(docker.volumeData.get(volume)).toBe("the network key");
      expect(docker.container(scratch)).toBeUndefined();
      expect(docker.removedKeepingVolumes).not.toContain(scratch);
      expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
      expect(docker.container(bridge)?.running).toBe(true);
    });

    it("puts the data back in the volumes it was copied from, should a later manager name others", async () => {
      const { backups, copies, crashLoop, docker, services, store } =
        await setup();
      await services.reconcile();
      const [copy] = await copies();
      const earlier = "sanctum-zigbee2mqtt-earlier";
      await rename(
        join(backups, copy!, `${volume}.tar`),
        join(backups, copy!, `${earlier}.tar`),
      );
      docker.volumes.set(earlier, managedVolume);
      await store.update((draft) => {
        draft.imageChanges!.zigbee2mqtt!.volumes = [
          { name: earlier, target: "/app/data" },
        ];
      });
      crashLoop();

      await services.reconcile();

      expect(docker.volumeData.get(earlier)).toBe("the network key");
      expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
      expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe(
        "kept-back",
      );
      // Started on the other one, it would begin again with a new network.
      expect(docker.container(bridge)?.options.HostConfig?.Binds).toEqual([
        `${earlier}:/app/data`,
      ]);
      docker.events = [];
      await services.reconcile();
      expect(docker.events).toEqual([]);
    });

    it("removes nothing when the copy has gone", async () => {
      const { backups, copies, crashLoop, docker, services, store } =
        await setup();
      await services.reconcile();
      crashLoop();
      const [copy] = await copies();
      await store.update((draft) => {
        draft.imageChanges!.zigbee2mqtt!.backup = join(
          backups,
          `${copy}-gone-by-hand`,
        );
      });

      await services.reconcile();

      expect(docker.volumeData.get(volume)).toBe("migrated");
      expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
      expect(services.status("zigbee2mqtt")).toMatchObject({ state: "failed" });
    });

    it("puts them back when the manager itself goes back before the verdict", async () => {
      const { docker, services, store } = await setup();
      await services.reconcile();
      // The manager rolled back to one that pins what the copy was taken
      // under, here the current image, and the unjudged version is newer.
      const newer = "ghcr.io/koenkk/zigbee2mqtt:9.9.9";
      docker.load(newer, { title: "zigbee2mqtt", version: "9.9.9" });
      await store.update((draft) => {
        draft.imageChanges!.zigbee2mqtt = {
          ...draft.imageChanges!.zigbee2mqtt!,
          from: zigbee2mqttImage,
          to: newer,
        };
      });
      docker.containers.delete(docker.container(bridge)!.id);
      docker.run({
        name: bridge,
        Image: newer,
        Labels: {
          "sanctum.managed": "true",
          "sanctum.role": "zigbee2mqtt",
          "sanctum.definition": "from-the-newer-manager",
        },
        HostConfig: { Binds: [`${volume}:/app/data`] },
      });
      docker.volumeData.set(volume, "migrated further");
      docker.onStart = null;

      await services.reconcile();

      expect(docker.volumeData.get(volume)).toBe("the network key");
      expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
      expect(store.current().imageChanges?.zigbee2mqtt).toBeUndefined();
      expect(hasImage(docker, newer)).toBe(false);
    });
  });
});
