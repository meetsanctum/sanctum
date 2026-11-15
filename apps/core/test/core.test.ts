import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoreConfig } from "../src/config.js";
import { startCore, type Core } from "../src/core.js";
import { updatePendingFile } from "../src/update-pending.js";
import { hostId, managerSocket, type SocketRequest } from "./support.js";

// A whole core as a host starts it (core.ts), against a manager that answers on
// its socket with no apps staged, over plain HTTP on a port of its own.

const running = new Set<Core>();
const folders: string[] = [];
afterEach(async () => {
  for (const core of running) await core.stop();
  running.clear();
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

// What a manager with nothing staged says to each of the core's questions.
function manager({ method, url }: SocketRequest) {
  if (method === "GET" && url === "/api/host") {
    return { status: 200, body: { id: hostId } };
  }
  if (method === "PUT" && url === "/api/claimed") return { status: 204 };
  if (method === "GET" && url.startsWith("/api/apps/staged")) {
    return { status: 200, body: { apps: {} } };
  }
  return { status: 404, body: { error: "not_found" } };
}

async function hostFolder() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-core-"));
  folders.push(folder);
  return folder;
}

function configOf(dataDir: string, managerSocket: string): CoreConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [],
    dataDir,
    plainHttp: true,
    officialAppsDir: join(dataDir, "no-catalog"),
    appsApart: [],
    packagesDir: join(dataDir, "no-packages"),
    managerSocket,
    version: "1.2.3",
  };
}

async function serving(config: CoreConfig) {
  const logs: string[] = [];
  const exits: number[] = [];
  const core = await startCore(config, {
    log: (message) => logs.push(message),
    exit: (code) => exits.push(code),
  });
  running.add(core);
  await core.listen();
  const [address] = core.server.addresses();
  const url = (path: string) => `http://127.0.0.1:${address!.port}${path}`;
  return {
    core,
    logs,
    exits,
    get: (path: string) => fetch(url(path)),
    async stop() {
      running.delete(core);
      await core.stop();
    },
  };
}

describe("a whole core", () => {
  it("serves once it listens, and the next core on its data knows it stopped", async () => {
    const dataDir = await hostFolder();
    const { socketPath, received } = await managerSocket(manager);
    const config = configOf(dataDir, socketPath);

    const first = await serving(config);
    const health = await first.get("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      service: "core",
      status: "ok",
      version: "1.2.3",
      updatePending: false,
    });
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({ method: "PUT", url: "/api/claimed" }),
      ),
    );
    await first.stop();

    const next = await serving(config);
    const starts = next.core.modules.activity
      .page({ limit: 10 })
      .entries.filter((entry) => entry.action === "sanctum.start")
      .map((entry) => entry.detail);
    expect(starts).toEqual([
      { version: "1.2.3", stoppedAt: expect.any(String), unexpected: false },
      { version: "1.2.3", stoppedAt: null, unexpected: false },
    ]);
    expect(first.exits).toEqual([]);
    expect(next.exits).toEqual([]);
  });

  it("answers only its health check until the manager commits its update", async () => {
    const dataDir = await hostFolder();
    const { socketPath } = await managerSocket(manager);
    await writeFile(join(dataDir, updatePendingFile), "update-1");

    const { get, logs } = await serving(configOf(dataDir, socketPath));
    expect(await (await get("/api/health")).json()).toMatchObject({
      updatePending: true,
    });
    const refused = await get("/api/places");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "update_pending" });
    expect(logs).toContainEqual(
      expect.stringContaining("waiting for the update to commit"),
    );

    await rm(join(dataDir, updatePendingFile));
    await vi.waitFor(
      async () =>
        expect(await (await get("/api/health")).json()).toMatchObject({
          updatePending: false,
        }),
      { timeout: 5_000, interval: 100 },
    );
    expect((await get("/api/places")).status).not.toBe(503);
  });
});
