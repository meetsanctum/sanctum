import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoreConfig } from "../src/config.js";
import { createCore, type Core } from "../src/core.js";
import { updatePendingFile } from "../src/update-pending.js";
import { managerSocket, type SocketRequest } from "./manager-support.js";
import { hostId } from "./support.js";

// A whole core as a host starts and stops it (core.ts), through the steps of
// each phase of its lifecycle, against a manager that answers on its socket
// with no apps staged, over plain HTTP on a port of its own.

const cores = new Set<Core>();
const folders: string[] = [];
afterEach(async () => {
  for (const core of cores) await core.stop("signal");
  cores.clear();
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

// What a manager with nothing staged says to each of the core's questions. It
// never signs a certificate.
function manager({ method, url }: SocketRequest) {
  if (method === "GET" && url === "/api/host") {
    return { status: 200, body: { id: hostId } };
  }
  if (method === "PUT" && url === "/api/claimed") return { status: 204 };
  if (method === "GET" && url.startsWith("/api/apps/staged")) {
    return { status: 200, body: { apps: {} } };
  }
  if (url === "/api/certificate") return { status: 503 };
  return { status: 404, body: { error: "not_found" } };
}

async function hostFolder() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-core-"));
  folders.push(folder);
  return folder;
}

function configOf(
  dataDir: string,
  managerSocket: string,
  overrides: Partial<CoreConfig> = {},
): CoreConfig {
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
    ...overrides,
  };
}

function coreOf(config: CoreConfig) {
  const logs: string[] = [];
  const core = createCore(config, { log: (line) => logs.push(line) });
  cores.add(core);
  return { core, logs };
}

async function serving(config: CoreConfig) {
  const { core, logs } = coreOf(config);
  await core.start();
  const [address] = core.server!.addresses();
  const get = (path: string) =>
    fetch(`http://127.0.0.1:${address!.port}${path}`);
  return { core, logs, get };
}

describe("a whole core", () => {
  it("starts through its named steps, serves, and the next core on its data knows it stopped", async () => {
    const dataDir = await hostFolder();
    const { socketPath, received } = await managerSocket(manager);
    const config = configOf(dataDir, socketPath);

    const first = await serving(config);
    expect(
      first.logs.filter((line) => line.startsWith("core: ")).slice(0, 3),
    ).toEqual([
      "core: starting",
      "core: starting: open core.db",
      "core: starting: load the home's id",
    ]);
    expect(first.logs).toContain("core: starting: listen");
    expect(first.logs.at(-1)).toBe("core: running");
    const health = await first.get("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      service: "core",
      status: "ok",
      version: "1.2.3",
      updatePending: false,
      phase: "running",
      readiness: "everyone",
    });
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({ method: "PUT", url: "/api/claimed" }),
      ),
    );

    expect(await first.core.stop("signal")).toEqual({
      code: 0,
      failedSteps: [],
    });
    expect(first.core.lifecycle.phase()).toBe("stopped");
    expect(first.logs).toContain("core: stopping: close core.db");
    expect(first.logs.at(-1)).toBe("core: stopped (0)");

    const next = await serving(config);
    const starts = next.core
      .modules!.activity.page({ limit: 10 })
      .entries.filter((entry) => entry.action === "sanctum.start")
      .map((entry) => entry.detail);
    expect(starts).toEqual([
      { version: "1.2.3", stoppedAt: expect.any(String), unexpected: false },
      { version: "1.2.3", stoppedAt: null, unexpected: false },
    ]);
  });

  it("answers only its health check until the manager commits its update", async () => {
    const dataDir = await hostFolder();
    const { socketPath } = await managerSocket(manager);
    await writeFile(join(dataDir, updatePendingFile), "update-1");

    const { core, get, logs } = await serving(configOf(dataDir, socketPath));
    expect(core.lifecycle.readiness()).toBe("healthOnly");
    expect(await (await get("/api/health")).json()).toMatchObject({
      updatePending: true,
      phase: "running",
      readiness: "healthOnly",
    });
    const refused = await get("/api/places");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "update_pending" });
    expect(logs).toContain("core: on trial");
    expect(logs).toContainEqual(
      expect.stringContaining("waiting for the update to commit"),
    );

    await rm(join(dataDir, updatePendingFile));
    await vi.waitFor(
      async () =>
        expect(await (await get("/api/health")).json()).toMatchObject({
          updatePending: false,
          readiness: "everyone",
        }),
      { timeout: 5_000, interval: 100 },
    );
    expect(logs).toContain("core: the update committed");
    expect((await get("/api/places")).status).not.toBe(503);
  });

  it("stops while it waits for its certificate, and never serves", async () => {
    const dataDir = await hostFolder();
    const { socketPath } = await managerSocket(manager);
    const { core, logs } = coreOf(
      configOf(dataDir, socketPath, { plainHttp: false }),
    );

    const starting = core.start();
    await vi.waitFor(() =>
      expect(logs).toContain("core: starting: wait for the certificate"),
    );
    expect(core.lifecycle.phase()).toBe("starting");

    expect(await core.stop("signal")).toEqual({ code: 0, failedSteps: [] });
    await starting;
    expect(core.lifecycle.phase()).toBe("stopped");
    expect(core.server).toBeUndefined();
    expect(logs).not.toContain("core: running");
    expect(logs).not.toContain("core: starting: listen");
  });

  it("stops once: a second signal waits for the first stop", async () => {
    const dataDir = await hostFolder();
    const { socketPath } = await managerSocket(manager);
    const { core, logs } = await serving(configOf(dataDir, socketPath));

    const first = core.stop("signal");
    const second = core.stop("signal");

    expect(second).toBe(first);
    await second;
    expect(logs.filter((line) => line === "core: stopping (signal)")).toEqual([
      "core: stopping (signal)",
    ]);
  });

  it("stops with exit code 1 when it can't open its database", async () => {
    const folder = await hostFolder();
    const notAFolder = join(folder, "core-data");
    await writeFile(notAFolder, "");
    const { socketPath } = await managerSocket(manager);
    const { core } = coreOf(configOf(notAFolder, socketPath));

    await core.start();

    expect(await core.stopped).toEqual({
      code: 1,
      failedSteps: ["open core.db"],
    });
  });
});
