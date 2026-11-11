import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerCreateOptions } from "../src/docker.js";
import { createSpace, type SpaceDockerLike } from "../src/host/space.js";
import { createServer } from "../src/server.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import type { UpdateJournal } from "../src/update/journal.js";
import { createRegistry } from "../src/update/registry.js";
import { notFound } from "./fake-docker.js";

// Free up space from Settings → Status: old versions of Sanctum and its
// services, and on a dev host the builds it won't go back or forward to.
// What runs, the version before (a rollback's) and the newest build stay.

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const digest = (name: string) =>
  `sha256:${Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64)}`;

// The dev Pi's images on 2 November: what runs, the version before, an old
// Zigbee and someone else's image.
function docker(
  options: {
    deleteEnabled?: boolean;
    gcExit?: number;
    interrupted?: "created" | "running" | "exited";
  } = {},
) {
  const events: string[] = [];
  const created: ContainerCreateOptions[] = [];
  const images: Array<{
    Id: string;
    RepoTags: string[];
    Labels?: Record<string, string>;
    Size: number;
    SharedSize: number;
  }> = [
    {
      Id: "sha256:core-ed4f70b",
      RepoTags: ["localhost:5000/sanctum-core:dev-ed4f70b"],
      Labels: { "sanctum.service": "core" },
      Size: 498e6,
      SharedSize: 80e6,
    },
    {
      Id: "sha256:core-717fbe1",
      RepoTags: ["localhost:5000/sanctum-core:dev-717fbe1"],
      Labels: { "sanctum.service": "core" },
      Size: 498e6,
      SharedSize: 80e6,
    },
    {
      Id: "sha256:core-07bfb55",
      RepoTags: ["localhost:5000/sanctum-core:dev-07bfb55"],
      Labels: {
        "sanctum.service": "core",
        "org.opencontainers.image.version": "dev-07bfb55",
      },
      Size: 497e6,
      SharedSize: 80e6,
    },
    {
      Id: "sha256:z2m-new",
      RepoTags: [zigbee2mqttImage],
      Size: 214e6,
      SharedSize: 0,
    },
    {
      Id: "sha256:z2m-old",
      RepoTags: ["ghcr.io/koenkk/zigbee2mqtt:2.14.1"],
      Size: 213e6,
      SharedSize: 10e6,
    },
    {
      Id: "sha256:mosquitto",
      RepoTags: [mosquittoImage],
      Size: 43e6,
      SharedSize: 0,
    },
    {
      Id: "sha256:alpine",
      RepoTags: ["alpine:latest"],
      Size: 13e6,
      SharedSize: 0,
    },
  ];
  const containers: Record<string, Record<string, unknown>> = {
    "sanctum-registry": {
      Id: "registry",
      Name: "/sanctum-registry",
      Image: "sha256:registry",
      State: { Running: true },
      Config: {
        Image: "registry:3.0.0",
        Cmd: ["/etc/distribution/config.yml"],
        Env: options.deleteEnabled
          ? ["REGISTRY_STORAGE_DELETE_ENABLED=true"]
          : ["REGISTRY_LOG_LEVEL=info"],
        Labels: { "com.docker.compose.service": "registry" },
      },
      HostConfig: {},
      Mounts: [
        {
          Type: "volume",
          Name: "sanctum-registry-data",
          Destination: "/var/lib/registry",
        },
      ],
    },
  };
  if (options.interrupted) {
    containers["sanctum-registry"]!.State = { Running: false };
    containers["sanctum-registry-cleanup"] = {
      Id: "sanctum-registry-cleanup",
      Name: "/sanctum-registry-cleanup",
      Image: "sha256:registry",
      State: { Running: options.interrupted === "running" },
      Config: {
        Labels: {
          "sanctum.managed": "true",
          "sanctum.role": "registry-cleanup",
        },
      },
    };
  }
  const setRunning = (id: string, running: boolean) => {
    const found = containers[id] ?? containers[`sanctum-${id}`];
    if (found) found.State = { Running: running };
  };
  const container = (id: string) => ({
    inspect: async () => {
      const found = containers[id] ?? containers[`sanctum-${id}`];
      if (!found) throw notFound();
      return found as never;
    },
    start: async () => {
      events.push(`start ${id}`);
      setRunning(id, true);
    },
    stop: async () => {
      events.push(`stop ${id}`);
      setRunning(id, false);
    },
    remove: async () => {
      events.push(`remove ${id}`);
      delete containers[id];
    },
    rename: async () => undefined,
    update: async () => undefined,
    wait: async () => {
      events.push(`wait ${id}`);
      setRunning(id, false);
      return { StatusCode: options.gcExit ?? 0 };
    },
  });
  const fake: SpaceDockerLike & { events: string[]; created: typeof created } =
    {
      events,
      created,
      df: async () => ({ Images: images }),
      listContainers: async () => [
        { Id: "core", ImageID: "sha256:core-ed4f70b" },
        { Id: "z2m", ImageID: "sha256:z2m-new" },
        { Id: "registry", ImageID: "sha256:registry" },
      ],
      getImage: (reference: string) => ({
        inspect: async () => {
          const found = images.find(
            (image) =>
              image.Id === reference || image.RepoTags.includes(reference),
          );
          if (!found) throw notFound();
          return { Id: found.Id };
        },
        remove: async () => void events.push(`remove image ${reference}`),
      }),
      getContainer: (id: string) => ({
        ...container(id),
        getArchive: async () => Readable.from([]),
        putArchive: async () => undefined,
      }),
      createContainer: async (create: ContainerCreateOptions) => {
        created.push(create);
        containers[create.name] = {
          Id: create.name,
          Name: `/${create.name}`,
          Image: create.Image,
          State: { Running: false },
          Config: create,
        };
        return { id: create.name };
      },
    };
  return fake;
}

// The dev registry: four builds, each a manifest of a config and layers,
// one shared by every build; one build pushed as an index.
function registry(deleteStatus = 202) {
  const deleted: string[] = [];
  const builds = ["dev-07bfb55", "dev-717fbe1", "dev-ed4f70b", "dev-1040943"];
  const manifestOf = (repository: string, tag: string) => ({
    config: { digest: digest(`${repository}-${tag}-config`), size: 2_000 },
    layers: [
      { digest: digest("base"), size: 50_000_000 },
      { digest: digest(`${repository}-${tag}-app`), size: 30_000_000 },
    ],
  });
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/v2\//, "");
    if (init?.method === "DELETE") {
      deleted.push(path);
      return new Response(null, { status: deleteStatus });
    }
    const tags = /^(sanctum-\w+)\/tags\/list$/.exec(path);
    if (tags) return Response.json({ tags: builds });
    const manifest = /^(sanctum-\w+)\/manifests\/(.+)$/.exec(path);
    if (manifest) {
      const [, repository, reference] = manifest as unknown as [
        string,
        string,
        string,
      ];
      // dev-07bfb55's manager was pushed as an index of one image.
      if (repository === "sanctum-manager" && reference === "dev-07bfb55") {
        return Response.json(
          {
            manifests: [
              {
                digest: digest("manager-07bfb55-arm64"),
                platform: { os: "linux", architecture: "arm64" },
              },
            ],
          },
          { headers: { "docker-content-digest": digest("manager-07bfb55") } },
        );
      }
      if (reference === digest("manager-07bfb55-arm64")) {
        return Response.json(manifestOf(repository, "dev-07bfb55"), {
          headers: { "docker-content-digest": reference },
        });
      }
      return Response.json(manifestOf(repository, reference), {
        headers: {
          "docker-content-digest": digest(`${repository}-${reference}`),
        },
      });
    }
    return new Response(null, { status: 404 });
  };
  return {
    deleted,
    registry: createRegistry({ address: "127.0.0.1:5000", fetch }),
  };
}

const journal: UpdateJournal = {
  id: "u1",
  version: "dev-ed4f70b",
  startedAt: "2026-11-02T18:08:00Z",
  finishedAt: "2026-11-02T18:11:00Z",
  phase: "done",
  outcome: "updated",
  core: {
    status: "updated",
    image: "localhost:5000/sanctum-core:dev-ed4f70b",
    fromImageId: "sha256:core-717fbe1",
    fromVersion: "dev-717fbe1",
  },
  manager: {
    status: "updated",
    image: "localhost:5000/sanctum-manager:dev-ed4f70b",
    fromVersion: "dev-717fbe1",
  },
  log: [],
};

function space(
  options: {
    packages?: {
      clearable: () => Promise<{ folders: number; bytes: number }>;
      clear: () => Promise<void>;
    };
    channel?: "dev" | "stable";
    deleteEnabled?: boolean;
    busy?: boolean;
    gcExit?: number;
    // How long asking whether an update runs takes.
    busyMs?: number;
    journal?: UpdateJournal | null;
    deleteStatus?: number;
    interrupted?: "created" | "running" | "exited";
  } = {},
) {
  const fake = docker(options);
  const dev =
    options.channel !== "stable" ? registry(options.deleteStatus) : undefined;
  let free = 6_900_000_000;
  let recounted = 0;
  return {
    fake,
    dev,
    recounted: () => recounted,
    space: createSpace({
      docker: fake,
      channel: options.channel ?? "dev",
      version: "dev-ed4f70b",
      ...(options.packages ? { packages: options.packages } : {}),
      journal: {
        read: async () =>
          options.journal === undefined ? journal : options.journal,
      },
      ...(dev
        ? {
            registry: dev.registry,
            builds: async () => [
              { version: "dev-1040943", builtAt: "2026-11-02T19:20:00Z" },
              { version: "dev-ed4f70b", builtAt: "2026-11-02T18:05:00Z" },
              { version: "dev-717fbe1", builtAt: "2026-11-01T12:00:00Z" },
              { version: "dev-07bfb55", builtAt: "2026-10-30T09:00:00Z" },
            ],
          }
        : {}),
      busy: async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, options.busyMs ?? 0),
        );
        return options.busy ?? false;
      },
      free: async () => {
        const now = free;
        free += 1_300_000_000;
        return now;
      },
      recount: () => void (recounted += 1),
      log: () => undefined,
    }),
  };
}

describe("free up space", () => {
  it.each(["created", "running", "exited"] as const)(
    "recovers a stopped registry after the manager exits with a %s cleanup helper",
    async (interrupted) => {
      const { space: dev, fake } = space({ interrupted });
      await dev.resume();
      expect(fake.events).toEqual([
        ...(interrupted === "running" ? ["wait sanctum-registry-cleanup"] : []),
        "start registry",
        "remove sanctum-registry-cleanup",
      ]);
      await dev.resume();
      expect(
        fake.events.filter((event) => event === "start registry"),
      ).toHaveLength(1);
    },
  );
  it.each(["unchanged", "failed", "rolled-back"] as const)(
    "keeps Sanctum images and builds after a %s update replaced the rollback record",
    async (outcome) => {
      const {
        space: dev,
        fake,
        dev: registry,
      } = space({
        deleteEnabled: true,
        journal: {
          ...journal,
          outcome,
          core: { status: "skipped", image: journal.core.image },
          manager: { status: "skipped", image: journal.manager.image },
        },
      });
      expect(await dev.plan()).toMatchObject({
        images: [{ service: "zigbee2mqtt", version: "2.14.1" }],
        devBuilds: 0,
        keeps: { before: null },
      });
      await dev.free();
      expect(fake.events).toEqual(["remove image sha256:z2m-old"]);
      expect(registry!.deleted).toEqual([]);
    },
  );

  it("counts and clears staged versions nothing can go back to", async () => {
    const cleared = vi.fn(async () => {});
    const { space: dev } = space({
      deleteEnabled: true,
      packages: {
        clearable: async () => ({ folders: 4, bytes: 146_000_000 }),
        clear: cleared,
      },
    });
    const without = await space({ deleteEnabled: true }).space.plan();

    const plan = await dev.plan();
    expect(plan.bytes).toBe(without.bytes + 146_000_000);
    expect(cleared).not.toHaveBeenCalled();

    await dev.free();
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("plans to remove what nothing needs, keeping what runs, the one before and the newest", async () => {
    const { space: dev } = space({ deleteEnabled: true });
    expect(await dev.plan()).toEqual({
      // An old core's and Zigbee's own layers, and dev-07bfb55's layers that
      // no kept build shares: two configs and two app layers.
      bytes: 417e6 + 203e6 + 2 * 2_000 + 2 * 30_000_000,
      images: [
        { service: "core", version: "dev-07bfb55" },
        { service: "zigbee2mqtt", version: "2.14.1" },
      ],
      devBuilds: 1,
      keeps: {
        running: "dev-ed4f70b",
        before: "dev-717fbe1",
        newest: "dev-1040943",
      },
    });
  });

  it("leaves the dev builds while the registry doesn't allow removing them", async () => {
    const { space: dev } = space();
    const plan = await dev.plan();
    expect(plan.devBuilds).toBe(0);
    expect(plan.bytes).toBe(417e6 + 203e6);
  });

  it("removes them, collects the registry's garbage while it is stopped, and says what the disk freed", async () => {
    const {
      space: dev,
      fake,
      dev: registry,
      recounted,
    } = space({
      deleteEnabled: true,
    });
    expect(await dev.free()).toEqual({ freed: 1_300_000_000 });
    expect(registry!.deleted.sort()).toEqual(
      [
        `sanctum-core/manifests/${digest("sanctum-core-dev-07bfb55")}`,
        `sanctum-manager/manifests/${digest("manager-07bfb55")}`,
        `sanctum-manager/manifests/${digest("manager-07bfb55-arm64")}`,
      ].sort(),
    );
    expect(fake.events).toEqual([
      "remove image sha256:core-07bfb55",
      "remove image sha256:z2m-old",
      "stop registry",
      "start sanctum-registry-cleanup",
      "wait sanctum-registry-cleanup",
      "start registry",
      "remove sanctum-registry-cleanup",
    ]);
    expect(fake.created).toEqual([
      {
        name: "sanctum-registry-cleanup",
        Image: "sha256:registry",
        Cmd: ["garbage-collect", "/etc/distribution/config.yml"],
        Labels: {
          "sanctum.managed": "true",
          "sanctum.role": "registry-cleanup",
        },
        HostConfig: { Binds: ["sanctum-registry-data:/var/lib/registry"] },
      },
    ]);
    expect(recounted()).toBe(1);
  });

  it("starts the registry again when its cleanup fails", async () => {
    const {
      space: dev,
      fake,
      recounted,
    } = space({ deleteEnabled: true, gcExit: 1 });
    await expect(dev.free()).rejects.toThrow("cleanup ended with 1");
    expect(fake.events.slice(-2)).toEqual([
      "start registry",
      "remove sanctum-registry-cleanup",
    ]);
    expect(dev.freeing()).toBe(false);
    expect(recounted()).toBe(1);
  });

  it("reports a registry deletion refusal instead of claiming cleanup succeeded", async () => {
    const {
      space: dev,
      fake,
      recounted,
    } = space({ deleteEnabled: true, deleteStatus: 405 });
    await expect(dev.free()).rejects.toThrow("refused to remove old builds");
    expect(fake.events).not.toContain("stop registry");
    expect(recounted()).toBe(1);
    expect(dev.freeing()).toBe(false);
  });

  it("on a stable host removes only old images", async () => {
    const { space: stable, fake } = space({ channel: "stable" });
    const plan = await stable.plan();
    expect(plan.devBuilds).toBe(0);
    expect(plan.keeps.newest).toBeNull();
    await stable.free();
    expect(fake.events).toEqual([
      "remove image sha256:core-07bfb55",
      "remove image sha256:z2m-old",
    ]);
  });

  it("refuses during an update, and an update while it frees", async () => {
    const { space: updating } = space({ busy: true });
    await expect(updating.free()).rejects.toThrow("An update is running");

    const { space: dev, fake } = space({ deleteEnabled: true, busyMs: 50 });
    const server = createServer(
      { version: "dev-test" },
      {
        host: {
          docker: fake as never,
          updates: { start: async () => ({}) } as never,
          space: dev,
        },
      },
    );
    servers.push(server);
    const plan = await server.inject("/api/host/space");
    expect(plan.statusCode).toBe(200);
    // An injected request runs once it is awaited.
    const freeing = server
      .inject({ method: "POST", url: "/api/host/space/free" })
      .then((response) => response);
    while (!dev.freeing())
      await new Promise((resolve) => setImmediate(resolve));
    const update = await server.inject({
      method: "POST",
      url: "/api/update",
      payload: {},
    });
    expect(update.statusCode).toBe(409);
    expect((await freeing).json()).toEqual({ freed: 1_300_000_000 });
  });
});
