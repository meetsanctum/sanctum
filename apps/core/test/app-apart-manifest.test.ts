import { defineApp, toStaticManifest } from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { base, cleanUps, useCleanUps } from "./app-apart-support.js";
import { testCore } from "./support.js";

useCleanUps();

describe("an app apart's manifest", () => {
  it("refuses an incomplete manifest before it can break the app list", async () => {
    const folder = await mkdtemp(join(tmpdir(), "sanctum-manifest-"));
    cleanUps.push(() => rm(folder, { recursive: true, force: true }));
    const core = await testCore({ appSockets: folder });
    cleanUps.push(() => core.apps.close());
    const manifest = toStaticManifest(
      defineApp({
        ...base,
        id: "test.incomplete",
        permissions: [],
        actions: [],
      }),
    );
    delete (manifest as Partial<typeof manifest>).pages;

    await core.apps.start([
      {
        apart: {
          manifest,
          digest: manifestDigest(JSON.stringify(manifest)),
          folder: "1.0.0+test",
        },
        origin: "official",
      },
    ]);

    expect(core.apps.has(manifest.id)).toBe(false);
    expect(core.apps.list()).toEqual([]);
    expect(core.logs.join("\n")).toContain("its manifest is incomplete");
  });
});
