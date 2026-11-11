import { defineApp, toStaticManifest } from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { describe, expect, it, vi } from "vitest";

import { apart, base, running, useCleanUps } from "./app-apart-support.js";

useCleanUps();

describe("replacing an app that runs apart", () => {
  it("keeps the new socket when removal is still stopping the old app", async () => {
    let release!: () => void;
    let starts = 0;
    const app = defineApp({
      ...base,
      id: "test.reinstalled",
      permissions: [],
      actions: [],
      start: async () => void (starts += 1),
      stop: () => new Promise<void>((done) => (release = done)),
    });
    const { core, reconnect } = await apart(app);
    await running(core, app.id);

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
    // Give the replacement a chance to bind while the old stop is held.
    await new Promise((done) => setTimeout(done, 40));
    release();
    await Promise.all([removing, installing]);
    reconnect();

    await running(core, app.id);
    expect(starts).toBe(2);
  });
});
