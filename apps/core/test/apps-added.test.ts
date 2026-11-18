import {
  appApiVersion,
  defineApp,
  toStaticManifest,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createAddedApps } from "../src/app-host/added.js";
import { createAvailableApps } from "../src/app-host/available.js";
import { servesAppApi, shortfallsOf } from "../src/app-host/fit.js";
import type { ApartPackage } from "../src/app-host/loader.js";
import {
  appsAdded,
  appsListed,
  appsOff,
  appVersions,
} from "../src/app-host/schema.js";
import { openCoreDatabase } from "../src/database.js";
import { base } from "./app-apart-support.js";
import { claimed, get, testCore } from "./support.js";

// The home's own list of apps: what a home that kept none records on its
// first start with it, what it could add, and what keeps an app from being
// added.

const mebibyte = 1024 * 1024;

async function database() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-added-"));
  const open = openCoreDatabase(folder);
  onTestFinished(async () => {
    open.close();
    await rm(folder, { recursive: true, force: true });
  });
  return open.db;
}

const manifestOf = (
  id: string,
  fields: Partial<Parameters<typeof defineApp>[0]> = {},
): StaticManifest =>
  toStaticManifest(
    defineApp({
      ...base,
      id,
      name: id.split(".")[1]!,
      permissions: [],
      actions: [],
      ...fields,
    }),
  );

describe("a home's first start with its own list", () => {
  it("records every app it had, those it ran or turned off included, once", async () => {
    const db = await database();
    const at = new Date("2026-11-17T10:00:00Z");
    db.insert(appVersions)
      .values({ appId: "sanctum.ran", version: "1.0.0", startedAt: at })
      .run();
    db.insert(appsOff).values({ appId: "sanctum.off", turnedOffAt: at }).run();
    const added = createAddedApps(db, { now: () => at });

    expect(added.listed()).toBe(false);
    expect(
      added.recordFirst(["sanctum.shipped", "sanctum.staged", "sanctum.ran"]),
    ).toBe(true);

    expect([...added.ids()].sort()).toEqual([
      "sanctum.off",
      "sanctum.ran",
      "sanctum.shipped",
      "sanctum.staged",
    ]);
    expect(added.listed()).toBe(true);
    // Nobody added them: the home had them.
    expect(db.select().from(appsAdded).all()).toContainEqual({
      appId: "sanctum.shipped",
      addedAt: at,
      personId: null,
      clientId: null,
    });
  });

  it("never records again, even once the home has no apps", async () => {
    const db = await database();
    const added = createAddedApps(db);
    added.recordFirst(["sanctum.weather"]);
    db.delete(appsAdded).run();

    expect(added.recordFirst(["sanctum.weather", "sanctum.moods"])).toBe(false);
    expect(added.ids().size).toBe(0);
    expect(db.select().from(appsListed).all()).toHaveLength(1);
  });

  it("leaves it for the next start when it knows of no app at all", async () => {
    const db = await database();
    const added = createAddedApps(db);

    expect(added.recordFirst([])).toBe(false);
    expect(added.listed()).toBe(false);
    expect(added.recordFirst(["sanctum.weather"])).toBe(true);
    expect([...added.ids()]).toEqual(["sanctum.weather"]);
  });
});

describe("a new home's first start", () => {
  const newHomeApps = ["sanctum.moods", "sanctum.weather"];

  it("records only the apps a new home starts with", async () => {
    const added = createAddedApps(await database());

    expect(
      added.recordFirst(
        ["sanctum.moods", "sanctum.weather", "sanctum.zigbee"],
        newHomeApps,
      ),
    ).toBe(true);

    expect([...added.ids()].sort()).toEqual([
      "sanctum.moods",
      "sanctum.weather",
    ]);
    expect(added.listed()).toBe(true);
  });

  it("keeps its list though the image ships none of them", async () => {
    const added = createAddedApps(await database());

    expect(added.recordFirst(["sanctum.zigbee"], newHomeApps)).toBe(true);
    expect(added.ids().size).toBe(0);
    expect(added.recordFirst(["sanctum.moods"], newHomeApps)).toBe(false);
  });

  it("waits for a start that knows of an app", async () => {
    const added = createAddedApps(await database());

    expect(added.recordFirst([], newHomeApps)).toBe(false);
    expect(added.listed()).toBe(false);
  });

  it("isn't a home that ran an app: that keeps every app it had", async () => {
    const db = await database();
    const at = new Date("2026-11-17T10:00:00Z");
    db.insert(appVersions)
      .values({ appId: "sanctum.zigbee", version: "0.7.0", startedAt: at })
      .run();
    const added = createAddedApps(db, { now: () => at });

    added.recordFirst(["sanctum.moods", "sanctum.esphome"], newHomeApps);

    expect([...added.ids()].sort()).toEqual([
      "sanctum.esphome",
      "sanctum.moods",
      "sanctum.zigbee",
    ]);
  });
});

describe("the first app someone adds", () => {
  it("establishes the home's list before any more packages arrive", async () => {
    const db = await database();
    const at = new Date("2026-11-17T12:00:00Z");
    const added = createAddedApps(db, { now: () => at });
    expect(added.recordFirst([])).toBe(false);

    expect(added.add("sanctum.example", { clientId: "client-1" })).toBe(true);
    expect(added.listed()).toBe(true);
    expect(db.select().from(appsListed).all()).toEqual([{ id: 1, since: at }]);
    expect(added.recordFirst(["sanctum.example", "sanctum.other"])).toBe(false);
    expect([...added.ids()]).toEqual(["sanctum.example"]);
  });

  it("records neither the app nor the list if its activity entry fails", async () => {
    const added = createAddedApps(await database());
    expect(() =>
      added.add("sanctum.example", { clientId: "client-1" }, () => {
        throw new Error("the entry could not be written");
      }),
    ).toThrow("the entry could not be written");
    expect(added.listed()).toBe(false);
    expect([...added.ids()]).toEqual([]);
  });
});

describe("what keeps an app from being added", () => {
  const host = {
    memory: { total: 2048 * mebibyte, available: 1024 * mebibyte },
    storage: { free: 8192 * mebibyte, images: [] },
  };
  const app = manifestOf("sanctum.example");

  it("nothing, when it fits", () => {
    expect(shortfallsOf(app, { pagesNeed: null, host })).toEqual([]);
  });

  it("an app API this Sanctum doesn't serve, or a range that says none", () => {
    expect(appApiVersion).toBe("1.0.0");
    expect(servesAppApi({ core: "^1.0.0" })).toBe(true);
    expect(servesAppApi({ core: "^2.0.0" })).toBe(false);
    expect(servesAppApi({ core: "any" })).toBe(false);
    expect(
      shortfallsOf({ ...app, core: "^2.0.0" }, { pagesNeed: null, host }),
    ).toEqual([{ kind: "sanctum", range: "^2.0.0" }]);
  });

  it("pages built for a kit this Sanctum can't serve", () => {
    expect(shortfallsOf(app, { pagesNeed: "sanctum", host })).toEqual([
      { kind: "pages", needs: "sanctum" },
    ]);
  });

  it("memory, leaving what Status warns under", () => {
    const tight = {
      ...host,
      memory: { total: 2048 * mebibyte, available: 200 * mebibyte },
    };
    // 5% of 2 GB is kept, so 200 MB leaves about 97 MB for the app's 128.
    expect(shortfallsOf(app, { pagesNeed: null, host: tight })).toEqual([
      {
        kind: "memory",
        needs: 128 * mebibyte,
        free: 200 * mebibyte - 2048 * mebibyte * 0.05,
      },
    ]);
  });

  it("space for its data, beside what the images it has may grow to and what updates need", () => {
    const tight = {
      ...host,
      storage: {
        free: 1900 * mebibyte,
        // 200 MB more promised to this one.
        images: [
          { state: "ok", sizeMb: 256, bytes: 56 * mebibyte },
          { state: "damaged", sizeMb: 4096, bytes: 0 },
        ],
      },
    };
    expect(shortfallsOf(app, { pagesNeed: null, host: tight })).toEqual([
      {
        kind: "space",
        needs: 256 * mebibyte,
        free: (1900 - 200 - 1536) * mebibyte,
      },
    ]);
  });

  it("nothing it can't know, as on a host that doesn't say", () => {
    expect(shortfallsOf(app, { pagesNeed: null, host: null })).toEqual([]);
    expect(
      shortfallsOf(app, {
        pagesNeed: null,
        host: { memory: null, storage: null },
      }),
    ).toEqual([]);
  });
});

describe("the apps a home could add", () => {
  const packageOf = (manifest: StaticManifest): ApartPackage => ({
    apart: { manifest, digest: "d", folder: `${manifest.version}+test` },
    origin: "official",
  });
  const manifests = new Map(
    [
      manifestOf("sanctum.weather", { name: "Weather", summary: "Forecast." }),
      manifestOf("sanctum.zigbee", {
        name: "Zigbee",
        runtime: { memory: 256, data: 512 },
        permissions: [
          { id: "services:zigbee2mqtt", reason: "To run it.", needed: true },
        ],
      }),
      manifestOf("sanctum.moods", { name: "Moods" }),
    ].map((manifest) => [manifest.id, manifest]),
  );

  function available(options: {
    shipped: string[];
    added: string[];
    staged: string[];
    broken?: string[];
  }) {
    const logs: string[] = [];
    const apps = createAvailableApps({
      shipped: () => options.shipped,
      added: { ids: () => new Set(options.added) },
      staged: async () =>
        Object.fromEntries(
          options.staged.map((id) => [id, { folder: "1.0.0+test" }]),
        ),
      loadPackage: async (appId) => {
        if (options.broken?.includes(appId)) throw new Error("unreadable");
        return packageOf(manifests.get(appId)!);
      },
      pagesNeedIn: async (appId) =>
        appId === "sanctum.zigbee" ? "pages" : null,
      host: async () => null,
      log: (line) => logs.push(line),
    });
    return { apps, logs };
  }

  it("those the image ships that the home hasn't added, staged, by name", async () => {
    const { apps } = available({
      shipped: ["sanctum.moods", "sanctum.weather", "sanctum.zigbee"],
      added: ["sanctum.moods"],
      staged: ["sanctum.moods", "sanctum.weather", "sanctum.zigbee"],
    });
    expect(await apps.list()).toEqual([
      {
        id: "sanctum.weather",
        name: "Weather",
        version: "1.0.0",
        summary: "Forecast.",
        icon: null,
        requests: [],
        memory: 128,
        data: 256,
        adds: {
          devices: false,
          widgets: 0,
          roomSections: 0,
          devicePages: 0,
          pieces: 0,
        },
        shortfalls: [],
      },
      {
        id: "sanctum.zigbee",
        name: "Zigbee",
        version: "1.0.0",
        summary: null,
        icon: null,
        requests: [
          {
            id: "services:zigbee2mqtt",
            reason: "To run it.",
            needed: true,
            asked: null,
            startsOn: false,
          },
        ],
        memory: 256,
        data: 512,
        adds: {
          devices: false,
          widgets: 0,
          roomSections: 0,
          devicePages: 0,
          pieces: 0,
        },
        shortfalls: [{ kind: "pages", needs: "pages" }],
      },
    ]);
  });

  it("not one whose package isn't staged yet, or can't be read", async () => {
    const { apps, logs } = available({
      shipped: ["sanctum.moods", "sanctum.weather", "sanctum.zigbee"],
      added: [],
      staged: ["sanctum.moods", "sanctum.zigbee"],
      broken: ["sanctum.zigbee"],
    });
    expect((await apps.list()).map((app) => app.id)).toEqual(["sanctum.moods"]);
    expect(logs).toEqual([
      "apps: sanctum.zigbee can't be offered (unreadable)",
    ]);
  });

  it("in a development stack, whose image ships none, what's staged", async () => {
    const { apps } = available({
      shipped: [],
      added: ["sanctum.weather"],
      staged: ["sanctum.moods", "sanctum.weather"],
    });
    expect((await apps.list()).map((app) => app.id)).toEqual(["sanctum.moods"]);
  });

  it("are household information, for every client", async () => {
    const core = await testCore();
    expect((await get(core, "/api/apps/available")).statusCode).toBe(401);
    const response = await get(
      core,
      "/api/apps/available",
      await claimed(core),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("an app built for another app API", () => {
  it("isn't installed, and the log says why", async () => {
    const newer = defineApp({
      ...base,
      id: "test.newer",
      core: "^2.0.0",
      permissions: [],
      actions: [],
    });
    const core = await testCore({ apps: [{ app: newer, origin: "official" }] });

    expect(core.apps.list().map((app) => app.id)).not.toContain("test.newer");
    expect(core.logs).toContain(
      "apps: test.newer was not installed (it targets app API ^2.0.0, and this core serves 1.0.0)",
    );
  });
});
