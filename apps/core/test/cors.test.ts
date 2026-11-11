import { beforeEach, describe, expect, it } from "vitest";

import { testCore, type TestCore } from "./support.js";

let server: TestCore["server"];

beforeEach(async () => {
  ({ server } = await testCore({
    allowedOrigins: ["http://localhost:5173", "app://sanctum"],
  }));
});

describe("core CORS", () => {
  it("lets an allowed origin read responses", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "app://sanctum" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "app://sanctum",
    );
    expect(response.headers.vary).toContain("Origin");
  });

  it("answers a preflight from an allowed origin", async () => {
    const response = await server.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("allows authenticated JSON posts from an allowed origin", async () => {
    const response = await server.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "app://sanctum",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "app://sanctum",
    );
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );
    expect(response.headers["access-control-allow-headers"]).toContain(
      "content-type",
    );
  });

  it("answers a preflight from another origin without access", async () => {
    const response = await server.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("gives other origins no access", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://example.com" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("lets an allowed origin read refusals", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/auth/clients",
      headers: { origin: "app://sanctum" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_client_token" });
    expect(response.headers["access-control-allow-origin"]).toBe(
      "app://sanctum",
    );
  });

  it("allows no cross-origin access by default", async () => {
    const { server: closed } = await testCore();
    const response = await closed.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
