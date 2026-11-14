import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appContainerName,
  createAppContainers,
  nodeImage,
} from "../src/apps/containers.js";
import { coreContainerOptions } from "../src/core-container.js";
import { createServer } from "../src/server.js";
import type { UpdateService } from "../src/update/service.js";
import { FakeDocker } from "./fake-docker.js";

const app = "sanctum.weather";
const folder = "0.3.0+1a2b3c4d5e6f7a8b";
const path = `/api/apps/${app}/container`;

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function manager() {
  const docker = new FakeDocker();
  docker.load(nodeImage, { title: "node", version: "24" });
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
  return { docker, server };
}

describe("what a manager can do", () => {
  it("can't run apps until the core's container has what they need", async () => {
    const { docker, server } = await manager();
    const ask = () => server.inject({ url: "/api/capabilities" });
    expect((await ask()).json()).toEqual({
      appContainers: false,
      memoryLimits: true,
      discovery: false,
    });

    docker.load("sanctum-core:1", { title: "sanctum-core", version: "1" });
    await docker.createContainer(coreContainerOptions("sanctum-core:1"));

    expect((await ask()).json()).toEqual({
      appContainers: true,
      memoryLimits: true,
      discovery: false,
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
    });
    expect(start.statusCode).toBe(503);
  });

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
