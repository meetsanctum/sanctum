import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  updatePendingFile,
  watchUpdatePending,
} from "../src/update-pending.js";
import { testCore } from "./support.js";

describe("an uncommitted update", () => {
  it("lets the core answer only its health check", async () => {
    const { server } = await testCore({ updatePending: () => true });

    const health = await server.inject({ method: "GET", url: "/api/health" });
    const other = await server.inject({
      method: "GET",
      url: "/api/auth/status",
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", updatePending: true });
    expect(other.statusCode).toBe(503);
    expect(other.json()).toEqual({ error: "update_pending" });
    expect(other.headers["retry-after"]).toBe("5");
  });

  it("ends when the manager removes the marker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-core-"));
    await writeFile(join(dataDir, updatePendingFile), "update-1");
    const pending = watchUpdatePending(dataDir, 5);
    expect(pending.isPending()).toBe(true);

    await rm(join(dataDir, updatePendingFile));

    await vi.waitFor(() => expect(pending.isPending()).toBe(false));
    pending.close();
  });

  it("does not apply to a core started without the marker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-core-"));
    const pending = watchUpdatePending(dataDir);

    expect(pending.isPending()).toBe(false);
    // A marker appearing later belongs to the next core, not this one.
    await writeFile(join(dataDir, updatePendingFile), "update-2");
    expect(pending.isPending()).toBe(false);
    pending.close();
  });
});
