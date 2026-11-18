import {
  defineApp,
  toStaticManifest,
  type Sighting,
} from "@meetsanctum/app-sdk";
import { manifestFileName } from "@meetsanctum/app-sdk/package";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import { createCore, type CoreManager } from "../src/core.js";
import { base } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";

// A home without the app that finds a kind of device on its network looks for
// those devices anyway, and Add devices offers the app once one announces
// itself, though the sightings reach no app.

const kitchen: Sighting = {
  service: "_example._tcp",
  name: "kitchen-sensor",
  host: "kitchen-sensor.local",
  addresses: ["192.168.1.40"],
  port: 8080,
  txt: {},
};

it("offers an app the home could add once its devices announce themselves", async () => {
  const folder = await mkdtemp(join(tmpdir(), "s-device-offers-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const appId = "sanctum.example";
  const packagesDir = join(folder, "packages");
  const packageFolder = join(packagesDir, appId, "1.0.0");
  await mkdir(packageFolder, { recursive: true });
  await writeFile(
    join(packageFolder, manifestFileName),
    JSON.stringify(
      toStaticManifest(
        defineApp({
          ...base,
          id: appId,
          name: "Example",
          permissions: [
            { id: "devices.register", reason: "For the test.", needed: true },
            {
              id: "discover:mdns:_example._tcp",
              reason: "For the test.",
              needed: true,
            },
          ],
          actions: [],
          driver: { async command() {}, async discovered() {} },
        }),
      ),
    ),
  );
  const fake = fakeManager();
  const manager: CoreManager = {
    ...fake.manager,
    stagedApps: async () => ({
      [appId]: { version: "1.0.0", folder: "1.0.0" },
    }),
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
      newHomeApps: [],
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
  const pairing = () => core.modules!.pairing.info();

  await vi.waitFor(
    () => expect(fake.network.asked.at(-1)).toEqual(["_example._tcp"]),
    // Looking for nothing, discovery asks again a second later.
    { timeout: 5_000 },
  );
  expect(pairing().offers).toEqual([]);

  fake.network.put(kitchen);

  await vi.waitFor(
    () =>
      expect(pairing().offers).toEqual([
        { app: appId, name: "Example", found: 1 },
      ]),
    { timeout: 5_000 },
  );
  // Nothing found reaches an app the home doesn't have.
  expect(pairing().found).toEqual([]);
});
