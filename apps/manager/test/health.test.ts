import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { createHost } from "./host.js";

describe("manager health", () => {
  it("reports status and version", async () => {
    const server = createServer({ version: "1.2.3" });
    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "manager",
      status: "ok",
      version: "1.2.3",
    });
    await server.close();
  });

  it("is unhealthy on a host when Docker is out of reach", async () => {
    const host = await createHost();
    const server = createServer({ version: "1.2.3" }, { host });
    host.docker.pingError = new Error("connect ENOENT /var/run/docker.sock");

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "error",
      docker: "unreachable",
    });
    await server.close();
  });
});

describe("update API", () => {
  it("answers health but refuses new updates during startup recovery", async () => {
    const host = await createHost();
    host.release("dev-2");
    let isReady = false;
    const server = createServer(
      { version: "dev-1" },
      { host: { ...host, isReady: () => isReady } },
    );
    expect(
      (await server.inject({ method: "GET", url: "/api/health" })).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/update",
          payload: { version: "dev-2" },
        })
      ).statusCode,
    ).toBe(503);
    expect(await host.context.journal.read()).toBeNull();
    isReady = true;
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/update",
          payload: { version: "dev-2" },
        })
      ).statusCode,
    ).toBe(202);
    await host.updates.wait();
    await server.close();
  });

  it("starts an update and reports its progress", async () => {
    const host = await createHost();
    host.release("dev-2");
    const server = createServer({ version: "dev-1" }, { host });

    const started = await server.inject({
      method: "POST",
      url: "/api/update",
      payload: { version: "dev-2" },
    });
    await host.updates.wait();
    const status = await server.inject({ method: "GET", url: "/api/update" });

    expect(started.statusCode).toBe(202);
    expect(status.json().update).toMatchObject({
      id: started.json().update.id,
      outcome: "updated",
    });
    await server.close();
  });

  it("refuses a version the host's channel does not take", async () => {
    const host = await createHost();
    const server = createServer({ version: "dev-1" }, { host });

    const response = await server.inject({
      method: "POST",
      url: "/api/update",
      payload: { version: "1.2.3" },
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("is not offered by a manager that supervises no host", async () => {
    const server = createServer({ version: "dev" });

    const response = await server.inject({
      method: "POST",
      url: "/api/update",
    });

    expect(response.statusCode).toBe(503);
    await server.close();
  });
});

describe("claimed state", () => {
  it("is kept and announced with the home's id as the core reports it", async () => {
    const reported: unknown[] = [];
    const server = createServer(
      { version: "dev-1" },
      { setClaimed: async (report) => void reported.push(report) },
    );
    const homeId = "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55";

    const response = await server.inject({
      method: "PUT",
      url: "/api/claimed",
      payload: { claimed: true, homeId },
    });
    const invalid = await Promise.all(
      [
        { claimed: "yes", homeId },
        { claimed: true, homeId: "a b" },
        // A core from before home ids.
        { claimed: true },
      ].map((payload) =>
        server.inject({ method: "PUT", url: "/api/claimed", payload }),
      ),
    );

    expect(response.statusCode).toBe(204);
    expect(invalid.map((r) => r.statusCode)).toEqual([400, 400, 400]);
    expect(reported).toEqual([{ claimed: true, homeId }]);
    await server.close();
  });
});

describe("the host's id", () => {
  it("is what the core binds sign-ins to", async () => {
    const server = createServer({ version: "dev-1" }, { hostId: "b0x" });
    const none = createServer({ version: "dev-1" });

    const response = await server.inject({ method: "GET", url: "/api/host" });
    const missing = await none.inject({ method: "GET", url: "/api/host" });

    expect(response.json()).toEqual({ id: "b0x" });
    expect(missing.statusCode).toBe(503);
    await server.close();
    await none.close();
  });
});

describe("loadConfig", () => {
  it("applies defaults that leave Docker alone", () => {
    expect(loadConfig({})).toEqual({
      socket: "./data/manager.sock",
      dataDir: "./data",
      coreDataDir: "./data/core",
      supervise: false,
      announce: false,
      hostDevDir: "/dev",
      coreUrl: "https://127.0.0.1:4100",
      certificateDays: 90,
      channel: "stable",
      imageOwner: "meetsanctum",
      devRegistry: "localhost:5000",
      version: "dev",
    });
  });

  it("reads a host's settings", () => {
    expect(
      loadConfig({
        MANAGER_SUPERVISE: "true",
        MANAGER_ANNOUNCE: "1",
        SANCTUM_CHANNEL: "dev",
      }),
    ).toMatchObject({ supervise: true, announce: true, channel: "dev" });
    expect(() => loadConfig({ SANCTUM_CHANNEL: "nightly" })).toThrow();
  });
});
