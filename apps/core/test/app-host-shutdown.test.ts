import { defineApp, toStaticManifest } from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { describe, expect, it, vi } from "vitest";

import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { testCore } from "./support.js";

useCleanUps();

describe("the app host stopping during installation", () => {
  it("can close after loading the packages fails", async () => {
    const core = await testCore();

    await expect(
      core.apps.start(Promise.reject(new Error("the packages can't be read"))),
    ).rejects.toThrow("the packages can't be read");

    await expect(core.apps.close()).resolves.toBeUndefined();
  });

  it("installs nothing after stopping while an old removal finishes", async () => {
    let release!: () => void;
    const app = defineApp({
      ...base,
      id: "sanctum.example",
      permissions: [],
      actions: [],
      stop: () => new Promise<void>((done) => (release = done)),
    });
    const { core } = await apart(app);
    await running(core, app.id);
    const reconcile = vi.spyOn(core.entities, "reconcileTypes");
    const removing = core.apps.remove(app.id);
    await vi.waitFor(() => expect(release).toBeDefined());
    const manifest = toStaticManifest(app);
    const installing = core.apps.start([
      {
        apart: {
          manifest,
          digest: manifestDigest(JSON.stringify(manifest)),
          folder: "1.0.0+test",
        },
        origin: "official",
      },
    ]);
    // The installer has reached the old removal before the host stops.
    await new Promise((resolve) => setImmediate(resolve));
    const closing = core.apps.close();
    release();
    await Promise.all([removing, installing, closing]);

    expect(reconcile).not.toHaveBeenCalled();
  });
});
