import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { listenOnSocket, socketFetch } from "../src/socket.js";
import { waitForHealth } from "../src/update/health.js";
import { managerContainerName } from "../src/update/manager-update.js";
import { FakeDocker } from "./fake-docker.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function socketPath() {
  const root = await mkdtemp(join(tmpdir(), "sanctum-"));
  return join(root, "run", "manager.sock");
}

function manager(version = "dev-1") {
  const server = createServer({ version });
  servers.push(server);
  return server;
}

// A process that listens on the socket and is killed, as a crash would,
// leaving the socket file behind.
function crashWhileListening(path: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    child.on("error", reject);
    child.on("exit", () => resolve());
  });
}

describe("the manager's socket", () => {
  it("lets only the manager's user and group in", async () => {
    const path = await socketPath();

    await listenOnSocket(manager(), path, process.getgid!());

    const socket = await stat(path);
    const directory = await stat(dirname(path));
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o660);
    expect(directory.mode & 0o777).toBe(0o750);
    expect(socket.gid).toBe(process.getgid!());
    const health = await socketFetch(path)("http://manager/api/health");
    expect(await health.json()).toMatchObject({ service: "manager" });
  });

  it("replaces a socket a crash left behind", async () => {
    const path = await socketPath();
    await mkdir(dirname(path), { recursive: true });
    await crashWhileListening(path);
    expect(existsSync(path)).toBe(true);

    await listenOnSocket(manager(), path);

    expect((await socketFetch(path)("http://manager/api/health")).ok).toBe(
      true,
    );
  });

  it("refuses to take over from a manager that still answers", async () => {
    const path = await socketPath();
    await listenOnSocket(manager(), path);

    await expect(listenOnSocket(manager(), path)).rejects.toThrow(
      /Another manager is listening/,
    );
    expect((await socketFetch(path)("http://manager/api/health")).ok).toBe(
      true,
    );
  });

  it("preserves a regular file at the configured socket path", async () => {
    const path = await socketPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "keep this data");

    await expect(listenOnSocket(manager(), path)).rejects.toThrow(
      /not a socket/,
    );
    expect(await readFile(path, "utf8")).toBe("keep this data");
  });

  it("fails like fetch when nothing answers", async () => {
    const path = await socketPath();

    await expect(
      socketFetch(path)("http://manager/api/health"),
    ).rejects.toThrow(TypeError);
  });

  it("fails like fetch when the manager stops during a response", async () => {
    const path = await socketPath();
    const server = manager();
    server.get("/interrupted", (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-length": "100" });
      reply.raw.write("{");
      setImmediate(() => reply.raw.destroy());
    });
    await listenOnSocket(server, path);

    await expect(
      socketFetch(path)("http://manager/interrupted"),
    ).rejects.toThrow(TypeError);
  });

  it("answers the updater's health check", async () => {
    const path = await socketPath();
    await listenOnSocket(manager("dev-2"), path);
    const docker = new FakeDocker();
    docker.load("sanctum-manager:dev-2", {
      title: "sanctum-manager",
      version: "dev-2",
    });
    docker.run({ name: managerContainerName, Image: "sanctum-manager:dev-2" });

    await waitForHealth({
      accept: (body) => body.status === "ok" && body.version === "dev-2",
      containerName: managerContainerName,
      docker,
      fetch: socketFetch(path),
      timing: { timeoutMs: 1_000, settleMs: 0, intervalMs: 5 },
      url: "http://manager/api/health",
    });
  });
});
