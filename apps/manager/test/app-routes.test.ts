import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appContainerName,
  createAppContainers,
  nodeImage,
} from "../src/apps/containers.js";
import { createLanHolders, holderName } from "../src/apps/lan.js";
import { coreContainerOptions } from "../src/core-container.js";
import { createServer } from "../src/server.js";
import type { UpdateService } from "../src/update/service.js";
import { FakeDocker } from "./fake-docker.js";
import { playNft } from "./fake-nft.js";

const app = "sanctum.weather";
const folder = "0.3.0+1a2b3c4d5e6f7a8b";
const path = `/api/apps/${app}/container`;

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function manager(options: { lan?: boolean } = {}) {
  const docker = new FakeDocker();
  docker.load(nodeImage, { title: "node", version: "24" });
  docker.load("sanctum-manager:test", { title: "manager", version: "test" });
  const nft = playNft(docker);
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-apps-"));
  await mkdir(join(dataDir, "packages", app, folder), { recursive: true });
  await writeFile(join(dataDir, "packages", app, folder, "package.json"), "{}");
  const apps = createAppContainers({
    docker,
    dataDir,
    log: vi.fn(),
    totalMemory: () => 2 * 1024 * 1024 * 1024,
    ownFolder: async () => {},
    images: { ensure: async () => "sanctum-app-data-sanctum.weather" },
    ...(options.lan
      ? {
          lan: createLanHolders({
            docker,
            image: async () => "sanctum-manager:test",
            run: "manager-1",
            reachable: () => true,
            log: vi.fn(),
          }),
        }
      : {}),
  });
  const server = createServer(
    { version: "dev-1" },
    {
      host: {
        docker,
        updates: {} as UpdateService,
        apps,
        appUsage: async () => ({
          memoryBytes: 40,
          processor: 0.5,
          dataBytes: 9,
        }),
      },
    },
  );
  servers.push(server);
  return { docker, nft, server };
}

describe("what a manager can do", () => {
  it("can't run apps until the core's container has what they need", async () => {
    const { docker, server } = await manager();
    const ask = () => server.inject({ url: "/api/capabilities" });
    expect((await ask()).json()).toEqual({
      appContainers: false,
      memoryLimits: true,
      discovery: false,
      lan: false,
      portRanges: false,
      deletesData: false,
      reserves: false,
    });

    docker.load("sanctum-core:1", { title: "sanctum-core", version: "1" });
    await docker.createContainer(coreContainerOptions("sanctum-core:1"));

    expect((await ask()).json()).toEqual({
      appContainers: true,
      memoryLimits: true,
      discovery: false,
      lan: false,
      portRanges: false,
      deletesData: false,
      reserves: false,
    });
  });

  it("says when memory limits are off", async () => {
    const { docker, server } = await manager();
    docker.memoryLimit = false;

    const answer = await server.inject({ url: "/api/capabilities" });

    expect(answer.json()).toMatchObject({ memoryLimits: false });
  });

  it("can do none of it without a host to supervise", async () => {
    const server = createServer({ version: "dev-1" });
    servers.push(server);

    const answer = await server.inject({ url: "/api/capabilities" });
    const start = await server.inject({
      method: "PUT",
      url: path,
      payload: {},
    });

    expect(answer.json()).toEqual({
      appContainers: false,
      memoryLimits: false,
      discovery: false,
      lan: false,
      portRanges: false,
      deletesData: false,
      reserves: false,
    });
    expect(start.statusCode).toBe(503);
  });

  it("gives one that reaches devices a network of its own, and changes what it may reach", async () => {
    const { docker, nft, server } = await manager({ lan: true });
    docker.load("sanctum-core:1", { title: "sanctum-core", version: "1" });
    await docker.createContainer(coreContainerOptions("sanctum-core:1"));
    const policy = {
      core: "core-1",
      count: 1,
      addresses: ["192.168.1.40"],
      ports: [6053, [50_000, 50_010]],
    };

    expect(
      (await server.inject({ url: "/api/capabilities" })).json(),
    ).toMatchObject({ appContainers: true, lan: true });
    const started = await server.inject({
      method: "PUT",
      url: path,
      payload: { folder, memoryMb: 128, lan: policy },
    });
    expect(started.statusCode).toBe(200);
    const holder = (await docker.getContainer(holderName(app)).inspect()).Id;
    expect(started.json().lan).toEqual({
      core: "core-1",
      count: 1,
      manager: "manager-1",
      holder,
    });
    expect(nft.tables.get(holder)).toContain(
      "elements = { 6053, 50000-50010 }",
    );

    const change = (body: object) =>
      server.inject({ method: "PUT", url: `${path}/lan`, payload: body });
    const changed = await change({
      ...policy,
      count: 2,
      ports: [6053, [50_001, 50_010]],
      manager: "manager-1",
      holder,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ count: 2, holder });
    expect(nft.tables.get(holder)).toContain(
      "elements = { 6053, 50001-50010 }",
    );
    const removed = await change({
      ...policy,
      count: 3,
      ports: [6053],
      manager: "manager-1",
      holder,
    });
    expect(removed.statusCode).toBe(200);
    expect(nft.tables.get(holder)).toContain("elements = { 6053 }");
    expect(
      (await change({ ...policy, count: 4, manager: "m", holder: "other" }))
        .statusCode,
    ).toBe(409);
    expect((await change({ ...policy, ports: [0] })).statusCode).toBe(400);
  });

  it.each([
    'core"; policy accept',
    "core\nrun",
    "core run",
    "core\\run",
    "core\n",
  ])(
    "refuses a core run that cannot be safely written and recovered from its rules: %j",
    async (core) => {
      const { docker, server } = await manager({ lan: true });
      const policy = { core, count: 1, addresses: [], ports: [6053] };

      const started = await server.inject({
        method: "PUT",
        url: path,
        payload: { folder, memoryMb: 128, lan: policy },
      });
      const changed = await server.inject({
        method: "PUT",
        url: `${path}/lan`,
        payload: { ...policy, manager: "manager-1", holder: "holder" },
      });

      expect(started.statusCode).toBe(400);
      expect(changed.statusCode).toBe(400);
      expect(docker.container(holderName(app))).toBeUndefined();
    },
  );

  it("reports no staged apps without a host, so the core can start its apps at once", async () => {
    const server = createServer({ version: "dev-1" });
    servers.push(server);

    const answer = await server.inject({ url: "/api/apps/staged" });

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ apps: {} });
  });
});

describe("the apps' containers API", () => {
  it("says what one holds and uses, and refuses an id that isn't an app's", async () => {
    const { server } = await manager();

    const usage = await server.inject({ url: `/api/apps/${app}/usage` });
    const refused = await server.inject({ url: "/api/apps/nothing/usage" });

    expect(usage.json()).toEqual({
      memoryBytes: 40,
      processor: 0.5,
      dataBytes: 9,
    });
    expect(refused.statusCode).toBe(400);
  });

  it("keeps one that runs as it would make it, when the core asks", async () => {
    const { docker, server } = await manager();
    const start = (payload: object) =>
      server.inject({ method: "PUT", url: path, payload });
    await start({ folder, memoryMb: 128 });
    const first = docker.container(appContainerName(app))!.id;

    const kept = await start({ folder, memoryMb: 128, keep: true });

    expect(kept.json()).toMatchObject({ state: "running", kept: true });
    expect(docker.container(appContainerName(app))!.id).toBe(first);
  });

  it("starts, reports, stops and removes one", async () => {
    const { docker, server } = await manager();

    const started = await server.inject({
      method: "PUT",
      url: path,
      payload: { folder, memoryMb: 128 },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ app, state: "running", folder });
    expect((await server.inject({ url: path })).json()).toMatchObject({
      state: "running",
    });
    expect(
      (await server.inject({ url: "/api/apps/containers" })).json(),
    ).toMatchObject({ containers: [{ app, state: "running" }] });

    const stopped = await server.inject({
      method: "POST",
      url: `${path}/stop`,
    });
    expect(stopped.json()).toMatchObject({ state: "stopped", exitCode: 143 });

    const removed = await server.inject({ method: "DELETE", url: path });
    expect(removed.statusCode).toBe(204);
    expect(docker.container(appContainerName(app))).toBeUndefined();
    expect((await server.inject({ url: path })).json()).toEqual({
      app,
      state: "none",
    });
  });

  it.each([
    ["no folder", { memoryMb: 128 }],
    ["a folder climbing out", { folder: "../../secrets", memoryMb: 128 }],
    ["two dots in a folder", { folder: "1.0.0..", memoryMb: 128 }],
    ["too little memory", { folder, memoryMb: 16 }],
    ["memory that isn't whole", { folder, memoryMb: 128.5 }],
  ])("refuses %s", async (_case, payload) => {
    const { docker, server } = await manager();

    const answer = await server.inject({ method: "PUT", url: path, payload });

    expect(answer.statusCode).toBe(400);
    expect(docker.container(appContainerName(app))).toBeUndefined();
  });

  it.each(["not-an-id", "..%2F..%2Fetc", "Sanctum.Weather"])(
    "refuses the id %s",
    async (id) => {
      const { server } = await manager();

      const answer = await server.inject({
        url: `/api/apps/${id}/container`,
      });

      expect(answer.statusCode).toBe(400);
    },
  );

  it("says why it can't start one", async () => {
    const { server } = await manager();

    const unstaged = await server.inject({
      method: "PUT",
      url: path,
      payload: { folder: "9.9.9+none", memoryMb: 128 },
    });
    const tooBig = await server.inject({
      method: "PUT",
      url: path,
      payload: { folder, memoryMb: 2048 },
    });

    expect(unstaged.statusCode).toBe(404);
    expect(tooBig.statusCode).toBe(409);
    expect(tooBig.json().error).toContain("needs 2048 MB");
  });
});
