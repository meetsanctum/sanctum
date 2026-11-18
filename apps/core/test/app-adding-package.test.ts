import { defineApp, toStaticManifest } from "@meetsanctum/app-sdk";
import { manifestFileName } from "@meetsanctum/app-sdk/package";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import type { Principal } from "../src/auth/clients.js";
import { createCore, type CoreManager } from "../src/core.js";
import { base } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";

it("installs the package checked at Add even if the manager stages another meanwhile", async () => {
  const folder = await mkdtemp(join(tmpdir(), "s-add-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const appId = "sanctum.example";
  const packagesDir = join(folder, "packages");
  for (const version of ["1.0.0", "1.1.0"]) {
    const packageFolder = join(packagesDir, appId, version);
    await mkdir(packageFolder, { recursive: true });
    await writeFile(
      join(packageFolder, manifestFileName),
      JSON.stringify(
        toStaticManifest(
          defineApp({
            ...base,
            id: appId,
            version,
            permissions: [],
            actions: [],
          }),
        ),
      ),
    );
  }
  const staged = vi.fn<CoreManager["stagedApps"]>().mockResolvedValue({});
  const manager: CoreManager = {
    ...fakeManager().manager,
    stagedApps: staged,
    hostId: () => undefined,
    reportClaimed: async () => undefined,
    signCertificate: async () => {
      throw new Error("no certificate over plain HTTP");
    },
    close: () => undefined,
  };
  const core = createCore(
    {
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [],
      dataDir: folder,
      plainHttp: true,
      officialAppsDir: join(folder, "no-catalog"),
      appsApart: [],
      packagesDir,
      kitDir: join(folder, "no-kit"),
      managerSocket: join(folder, "manager.sock"),
      newHomeApps: [
        "sanctum.moods",
        "sanctum.natural-light",
        "sanctum.weather",
      ],
      version: "1.0.0",
    },
    {
      log: () => undefined,
      testReplacements: {
        manager,
        ticking: false,
        recordsStarts: false,
        listens: false,
        moduleOptions: { appSockets: join(folder, "sockets") },
      },
    },
  );
  onTestFinished(() => core.stop().then(() => undefined));
  await core.start();
  await vi.waitFor(() => expect(core.modules!.apps.hasInstalled()).toBe(true));
  core.modules!.addedApps.recordFirst(["sanctum.kept"]);
  staged
    .mockResolvedValue({ [appId]: { version: "1.1.0", folder: "1.1.0" } })
    .mockResolvedValueOnce({
      [appId]: { version: "1.0.0", folder: "1.0.0" },
    });
  const principal = {
    client: { id: "client-1", kind: "shared" },
    scope: "full",
  } as Principal;

  const info = await core.modules!.appAdding.add(principal, appId, "1.0.0");

  expect(info.version).toBe("1.0.0");
  expect(info.build).toBe("1.0.0");
});
