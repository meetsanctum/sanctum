import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { testCore } from "./support.js";

describe("core health", () => {
  it("reports status and version, to anyone", async () => {
    const { server } = await testCore();
    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "core",
      status: "ok",
      version: "1.2.3",
      updatePending: false,
    });
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 4100,
      allowedOrigins: [],
      dataDir: "./data",
      // HTTPS unless `pnpm dev` asks for plain HTTP.
      plainHttp: false,
      officialAppsDir: "../../catalog/apps",
      appsApart: [],
      officialAppsApart: ["sanctum.weather", "sanctum.natural-light"],
      packagesDir: "/packages",
      managerSocket: "../manager/data/manager.sock",
      version: "dev",
    });
    expect(loadConfig({ CORE_PLAIN_HTTP: "true" }).plainHttp).toBe(true);
  });

  it("reads system and official app folders apart", () => {
    expect(
      loadConfig({
        CORE_SYSTEM_APPS_DIR: "/app/catalog/system",
        CORE_OFFICIAL_APPS_DIR: "/app/catalog/official",
      }),
    ).toMatchObject({
      systemAppsDir: "/app/catalog/system",
      officialAppsDir: "/app/catalog/official",
    });
  });

  it("reads a comma-separated list of allowed origins", () => {
    expect(
      loadConfig({
        CORE_ALLOWED_ORIGINS: " http://localhost:5173, app://sanctum,",
      }).allowedOrigins,
    ).toEqual(["http://localhost:5173", "app://sanctum"]);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ CORE_PORT: "99999" })).toThrow();
  });
});
