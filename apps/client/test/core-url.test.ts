import { afterEach, describe, expect, it, vi } from "vitest";

import { coreUrl, setCoreBaseUrl } from "../src/core-url";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("coreUrl", () => {
  it("resolves against the configured core", () => {
    vi.stubEnv("VITE_SANCTUM_CORE_URL", "https://sanctum.local:4100");
    vi.stubGlobal("location", { origin: "app://sanctum" });

    expect(coreUrl("/api/health")).toBe(
      "https://sanctum.local:4100/api/health",
    );
  });

  it("falls back to the page's origin when no core is configured", () => {
    vi.stubEnv("VITE_SANCTUM_CORE_URL", "");
    vi.stubGlobal("location", { origin: "http://192.168.1.20:4100" });

    expect(coreUrl("/api/health")).toBe("http://192.168.1.20:4100/api/health");
  });
});

describe("coreBaseUrl", () => {
  afterEach(() => setCoreBaseUrl(null));

  it("follows the host this client chose", () => {
    vi.stubEnv("VITE_SANCTUM_CORE_URL", "http://127.0.0.1:4100");
    setCoreBaseUrl("http://192.168.1.20:4100");

    expect(coreUrl("/api/auth/me")).toBe(
      "http://192.168.1.20:4100/api/auth/me",
    );
  });
});
