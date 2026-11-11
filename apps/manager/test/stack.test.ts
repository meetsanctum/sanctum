import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateJournal } from "../src/update/journal.js";

// A development stack shares its Docker with other stacks: its names and
// labels carry the stack's, its manager refuses what isn't its own, and
// cleanup and power stay inside it. Names are read once as modules load, so
// each test loads them again under its own settings.

// Loading them again takes seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

function inStack(name = "one", settings: Record<string, string> = {}) {
  vi.stubEnv("SANCTUM_STACK", name);
  for (const [key, value] of Object.entries(settings)) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("on a host", () => {
  it("keeps every name and label as it was", async () => {
    vi.resetModules();
    const { coreContainerOptions, sanctumNetworkName } =
      await import("../src/core-container.js");
    const { serviceContainerName } =
      await import("../src/services/containers.js");
    const { mosquittoUrl } = await import("../src/services/mosquitto.js");

    const options = coreContainerOptions("core:1");

    expect(options.name).toBe("sanctum-core");
    expect(options.Labels).toEqual({
      "sanctum.managed": "true",
      "sanctum.role": "core",
    });
    expect(options.HostConfig?.RestartPolicy).toEqual({
      Name: "unless-stopped",
    });
    expect(options.HostConfig?.PortBindings).toEqual({
      "4100/tcp": [{ HostPort: "4100" }],
    });
    expect(sanctumNetworkName).toBe("sanctum");
    expect(serviceContainerName("mosquitto")).toBe("sanctum-mosquitto");
    expect(mosquittoUrl).toBe("mqtt://sanctum-mosquitto:1883");
  });

  it("refuses what belongs to a stack", async () => {
    vi.resetModules();
    const { assertManaged } = await import("../src/docker-resources.js");

    expect(() =>
      assertManaged({
        name: "sanctum-core",
        labels: { "sanctum.managed": "true", "sanctum.stack": "one" },
      }),
    ).toThrow("Refusing to manage");
  });

  it("keeps a stopped development stack's images when pruning a host", async () => {
    vi.resetModules();
    const { pruneImages } = await import("../src/update/images.js");
    const { FakeDocker } = await import("./fake-docker.js");
    const docker = new FakeDocker();
    const hostImage = docker.load("core:old", {
      title: "sanctum-core",
      version: "old",
    });
    const stackImage = docker.load("core:stack", {
      title: "sanctum-core",
      version: "dev-stack",
    });
    docker.images.get(stackImage)!.labels["sanctum.stack"] = "one";

    await pruneImages(docker, "core", []);

    expect(docker.images.has(hostImage)).toBe(false);
    expect(docker.images.has(stackImage)).toBe(true);
  });
});

describe("in a stack", () => {
  it("gives the core its stack's names, port and code", async () => {
    inStack("one", {
      SANCTUM_STACK_CORE_IMAGE: "sanctum-one-core:dev",
      SANCTUM_STACK_CORE_PORT: "41000",
      SANCTUM_STACK_CORE_BINDS:
        "/w/a/dist:/app/a/dist:ro;/w/b/dist:/app/b/dist:ro;",
      SANCTUM_STACK_CORE_ENV: "CORE_PLAIN_HTTP=true",
    });
    const { coreContainerOptions, coreVolumeName } =
      await import("../src/core-container.js");

    const options = coreContainerOptions("sanctum-one-core:dev");

    expect(options.name).toBe("sanctum-one-core");
    expect(options.Labels).toMatchObject({ "sanctum.stack": "one" });
    expect(options.Labels?.["sanctum.stack.core-binds"]).toBe(
      "/w/a/dist:/app/a/dist:ro;/w/b/dist:/app/b/dist:ro",
    );
    expect(options.Env).toContain("CORE_PLAIN_HTTP=true");
    expect(options.HostConfig?.Binds).toEqual([
      `${coreVolumeName}:/data`,
      "sanctum-one-manager-socket:/run/sanctum",
      "/w/a/dist:/app/a/dist:ro",
      "/w/b/dist:/app/b/dist:ro",
    ]);
    // Only this Mac reaches a development core, on the stack's own port.
    expect(options.HostConfig?.PortBindings).toEqual({
      "4100/tcp": [{ HostIp: "127.0.0.1", HostPort: "41000" }],
    });
    expect(options.HostConfig?.RestartPolicy).toEqual({ Name: "no" });
    expect(options.NetworkingConfig?.EndpointsConfig).toEqual({
      "sanctum-one": {},
    });
    expect(coreVolumeName).toBe("sanctum-one-core-data");
  });

  it("gives services and their data the stack's names", async () => {
    inStack();
    const { serviceContainerOptions } =
      await import("../src/services/containers.js");
    const { mosquittoUrl } = await import("../src/services/mosquitto.js");

    const options = serviceContainerOptions("mosquitto", { image: "broker:1" });

    expect(options.name).toBe("sanctum-one-mosquitto");
    expect(options.Labels).toMatchObject({ "sanctum.stack": "one" });
    expect(options.HostConfig?.RestartPolicy).toEqual({ Name: "no" });
    expect(mosquittoUrl).toBe("mqtt://sanctum-one-mosquitto:1883");
  });

  it("refuses another stack's resources and a host's", async () => {
    inStack();
    const { assertManaged } = await import("../src/docker-resources.js");
    const resource = (labels: Record<string, string>) => ({
      name: "sanctum-one-core",
      labels: { "sanctum.managed": "true", ...labels },
    });

    expect(() =>
      assertManaged(resource({ "sanctum.stack": "one" })),
    ).not.toThrow();
    expect(() => assertManaged(resource({ "sanctum.stack": "two" }))).toThrow(
      "Refusing to manage",
    );
    expect(() => assertManaged(resource({}))).toThrow("Refusing to manage");
  });

  it("labels the networks and volumes it creates", async () => {
    inStack();
    const { ensureNetwork, ensureVolume } =
      await import("../src/docker-resources.js");
    const { FakeDocker } = await import("./fake-docker.js");
    const docker = new FakeDocker();

    await ensureNetwork(docker, "sanctum-one");
    await ensureVolume(docker, "sanctum-one-core-data");

    expect(docker.networks.get("sanctum-one")).toMatchObject({
      "sanctum.stack": "one",
    });
    expect(docker.volumes.get("sanctum-one-core-data")).toMatchObject({
      "sanctum.stack": "one",
    });
  });

  it("won't restart or shut down the machine under every stack", async () => {
    inStack();
    const { createPower, PowerConflictError } =
      await import("../src/host/power.js");
    const createContainer = vi.fn();
    const power = createPower({
      docker: { createContainer, getContainer: vi.fn() },
      busy: async () => false,
      log: () => undefined,
    });

    await expect(power.request("restart")).rejects.toBeInstanceOf(
      PowerConflictError,
    );
    await expect(power.request("shutdown")).rejects.toBeInstanceOf(
      PowerConflictError,
    );
    expect(createContainer).not.toHaveBeenCalled();
    expect(power.asked()).toBeNull();
  });

  it("prunes only its own images", async () => {
    inStack();
    const { pruneImages } = await import("../src/update/images.js");
    const remove = vi.fn(async (_id: string) => undefined);
    const images: Array<{ Id: string; labels: Record<string, string> }> = [
      {
        Id: "sha256:mine",
        labels: { "sanctum.service": "core", "sanctum.stack": "one" },
      },
      {
        Id: "sha256:theirs",
        labels: { "sanctum.service": "core", "sanctum.stack": "two" },
      },
    ];
    const docker = {
      listImages: async (options?: { filters?: Record<string, string[]> }) =>
        images
          .filter(({ labels }) =>
            (options?.filters?.label ?? []).every((filter) => {
              const [key, value] = filter.split("=");
              return labels[key as string] === value;
            }),
          )
          .map(({ Id }) => ({ Id })),
      listContainers: async () => [],
      getImage: (id: string) => ({
        inspect: async () => ({
          Id: id,
          Config: { Labels: images.find((image) => image.Id === id)?.labels },
        }),
        remove: () => remove(id),
      }),
    };

    await pruneImages(docker as never, "core", []);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("sha256:mine");
  });

  it("leaves another stack's images and the shared services' out of Free up space", async () => {
    inStack();
    const { createSpace } = await import("../src/host/space.js");
    const { mosquittoImage } = await import("../src/services/mosquitto.js");
    const { notFound } = await import("./fake-docker.js");
    const image = (
      Id: string,
      tag: string,
      labels?: Record<string, string>,
    ) => ({ Id, RepoTags: [tag], Labels: labels, Size: 1e6, SharedSize: 0 });
    const space = createSpace({
      docker: {
        df: async () => ({
          Images: [
            image("sha256:mine", "sanctum-one-core:mine", {
              "sanctum.service": "core",
              "sanctum.stack": "one",
            }),
            image("sha256:theirs", "sanctum-two-core:theirs", {
              "sanctum.service": "core",
              "sanctum.stack": "two",
            }),
            image("sha256:broker-old", `${mosquittoImage}-old`),
          ],
        }),
        listContainers: async () => [],
        getContainer: () => ({
          inspect: async () => {
            throw notFound();
          },
        }),
        getImage: () => ({
          inspect: async () => {
            throw notFound();
          },
        }),
      } as never,
      channel: "dev",
      version: "dev-stack",
      journal: {
        read: async () => ({
          outcome: "updated",
          core: { fromVersion: "dev-old", fromImageId: "sha256:before" },
          manager: {},
        }),
      } as never,
      busy: async () => false,
      free: async () => null,
      recount: () => undefined,
      log: () => undefined,
    });

    const plan = await space.plan();

    expect(plan.images.map((each) => each.version)).toEqual(["mine"]);
  });

  it("keeps an updater stopped when Docker restarts during a stack's update", async () => {
    inStack();
    const { handOverManager, managerContainerName, updaterContainerName } =
      await import("../src/update/manager-update.js");
    const { FakeDocker } = await import("./fake-docker.js");
    const docker = new FakeDocker();
    docker.load("manager:old", { title: "sanctum-manager", version: "old" });
    const next = docker.load("manager:new", {
      title: "sanctum-manager",
      version: "new",
    });
    docker.run({
      name: managerContainerName,
      Image: "manager:old",
      Labels: {
        "com.docker.compose.project": "sanctum-one",
        "com.docker.compose.service": "manager",
        "sanctum.stack": "one",
      },
      Env: ["SANCTUM_STACK=one"],
    });
    const journal: UpdateJournal = {
      id: "test",
      version: "new",
      startedAt: new Date().toISOString(),
      phase: "manager",
      log: [],
      core: { status: "updated", image: "core:new" },
      manager: {
        status: "pending",
        image: "manager:new",
        imageId: next,
        version: "new",
      },
    };

    await handOverManager(
      {
        docker,
        journal: { read: async () => journal, save: async () => undefined },
        dataDir: "/data",
        coreDataDir: "/core-data",
        coreUrl: "http://127.0.0.1:4100",
        managerSocket: "/run/sanctum/manager.sock",
        timing: { timeoutMs: 100, settleMs: 0, intervalMs: 5 },
        log: () => undefined,
      },
      journal,
      "old",
    );

    expect(
      docker.container(updaterContainerName)?.options.HostConfig?.RestartPolicy,
    ).toEqual({ Name: "no" });
  });
});
