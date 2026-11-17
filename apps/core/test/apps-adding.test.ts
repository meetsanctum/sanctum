import {
  defineApp,
  toStaticManifest,
  type AppInfo,
  type AvailableApp,
} from "@meetsanctum/app-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import type { Principal } from "../src/auth/clients.js";
import { createAppAdding } from "../src/app-host/adding.js";
import { createAddedApps } from "../src/app-host/added.js";
import { installedInfoOf } from "../src/app-host/app-info.js";
import { ActionCallError } from "../src/app-host/errors.js";
import type { Gate } from "../src/app-host/gate.js";
import type { ApartPackage } from "../src/app-host/loader.js";
import { appsAdded } from "../src/app-host/schema.js";
import { newSupervision } from "../src/app-host/supervisor.js";
import { openCoreDatabase } from "../src/database.js";
import { base } from "./app-apart-support.js";
import { claimed, post, testCore } from "./support.js";

// Adding an app the home's image brings, from its add sheet: what's checked
// again, what's recorded with it, and what it answers.

const at = new Date("2026-11-17T12:00:00Z");

async function database() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-adding-"));
  const open = openCoreDatabase(folder);
  onTestFinished(async () => {
    open.close();
    await rm(folder, { recursive: true, force: true });
  });
  return open.db;
}

const esphome: AvailableApp = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
  summary: "Brings example devices into your home.",
  icon: null,
  requests: [],
  memory: 128,
  data: 256,
  adds: {
    devices: true,
    widgets: 0,
    roomSections: 0,
    devicePages: 1,
    pieces: 2,
  },
  shortfalls: [],
};

const someone = {
  client: { id: "client-1" },
  person: { id: "person-1" },
  scope: "full",
} as unknown as Principal;

async function addingWith(
  options: {
    available?: AvailableApp[];
    installs?: (pkg: ApartPackage) => Promise<void>;
    hasInstalled?: boolean;
    refuses?: boolean;
  } = {},
) {
  const db = await database();
  const added = createAddedApps(db, { now: () => at });
  added.recordFirst(["sanctum.weather"]);
  const entries: Record<string, unknown>[] = [];
  const installing: string[] = [];
  const logs: string[] = [];
  const installedNow = new Set<string>();
  const adding = createAppAdding({
    gate: {
      admit: () => {
        if (options.refuses) throw new ActionCallError("forbidden");
      },
    } as unknown as Gate,
    available: {
      find: async (appId) => {
        const app = (options.available ?? [esphome]).find(
          (each) => each.id === appId,
        );
        if (!app) return undefined;
        return {
          app,
          pkg: {
            origin: "official",
            apart: {
              manifest: toStaticManifest(
                defineApp({
                  ...base,
                  id: app.id,
                  version: app.version,
                  permissions: [],
                  actions: [],
                }),
              ),
              folder: `${app.version}+test`,
              digest: "test",
            },
          },
        };
      },
    },
    added,
    activity: {
      for: (source) => (entry) => {
        entries.push({ source, ...entry });
        return "entry";
      },
    },
    hasInstalled: () => options.hasInstalled ?? true,
    install:
      options.installs ??
      (async (pkg) => {
        const appId = pkg.apart.manifest.id;
        installing.push(appId);
        installedNow.add(appId);
      }),
    info: (appId) =>
      installedNow.has(appId)
        ? ({ id: appId, state: "starting" } as AppInfo)
        : undefined,
    log: (line) => logs.push(line),
  });
  return { db, added, adding, entries, installing, logs };
}

describe("adding an app", () => {
  it("records it with who added it, says so in the log, and installs it", async () => {
    const { db, added, adding, entries, installing } = await addingWith();

    const info = await adding.add(someone, "sanctum.example", "1.0.0");

    expect(info).toEqual({ id: "sanctum.example", state: "starting" });
    expect(installing).toEqual(["sanctum.example"]);
    expect(added.ids().has("sanctum.example")).toBe(true);
    expect(db.select().from(appsAdded).all()).toContainEqual({
      appId: "sanctum.example",
      addedAt: at,
      personId: "person-1",
      clientId: "client-1",
    });
    expect(entries).toEqual([
      {
        source: "sanctum.example",
        action: "app.add",
        outcome: "ok",
        subjectId: "sanctum.example",
        personId: "person-1",
        clientId: "client-1",
        detail: { name: "Example", version: "1.0.0" },
      },
    ]);
  });

  it("refuses one already added, or added on another client meanwhile", async () => {
    const { adding, entries, installing } = await addingWith();

    const [first, second] = await Promise.allSettled([
      adding.add(someone, "sanctum.example", "1.0.0"),
      adding.add(someone, "sanctum.example", "1.0.0"),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({
      status: "rejected",
      reason: { code: "conflict" },
    });
    expect(installing).toEqual(["sanctum.example"]);
    expect(entries.map((entry) => entry.outcome)).toEqual(["ok", "refused"]);
  });

  it("refuses a version the sheet didn't show, as after Sanctum updated", async () => {
    const { added, adding, entries } = await addingWith();

    await expect(
      adding.add(someone, "sanctum.example", "0.9.0"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(added.ids().has("sanctum.example")).toBe(false);
    expect(entries).toMatchObject([
      { action: "app.add", outcome: "refused", reason: "conflict" },
    ]);
  });

  it("refuses one that something keeps from being added now", async () => {
    const { added, adding, installing } = await addingWith({
      available: [
        {
          ...esphome,
          shortfalls: [{ kind: "memory", needs: 128, free: 60 }],
        },
      ],
    });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(added.ids().has("sanctum.example")).toBe(false);
    expect(installing).toEqual([]);
  });

  it("knows no app the home couldn't add", async () => {
    const { adding, entries } = await addingWith({ available: [] });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(entries).toEqual([]);
  });

  it("waits until the home's apps are installed", async () => {
    const { adding } = await addingWith({ hasInstalled: false });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("goes through the gate, and the log says who was refused", async () => {
    const { adding, entries } = await addingWith({ refuses: true });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(entries).toMatchObject([
      { outcome: "refused", reason: "forbidden", personId: "person-1" },
    ]);
  });

  it("stays added when it doesn't install, for the next start", async () => {
    const { added, adding, logs } = await addingWith({
      installs: async () => {
        throw new Error("its package isn't staged");
      },
    });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "app_failed" });
    expect(added.ids().has("sanctum.example")).toBe(true);
    expect(logs).toEqual([
      "apps: sanctum.example was added and didn't install (its package isn't staged)",
    ]);
  });
});

describe("an app someone just added", () => {
  const entry = (isAdding: boolean, phase: "starting" | "running") => ({
    manifest: toStaticManifest(
      defineApp({
        ...base,
        id: "sanctum.example",
        permissions: [],
        actions: [],
      }),
    ),
    granted: [],
    settings: null,
    supervision: { ...newSupervision(at), isAdding, phase },
  });

  it("says so until its first start returns", () => {
    const info = (isAdding: boolean, phase: "starting" | "running") =>
      installedInfoOf(
        entry(isAdding, phase) as unknown as Parameters<
          typeof installedInfoOf
        >[0],
      ).run;

    expect(info(true, "starting")).toMatchObject({
      isFirstStart: true,
      isAdding: true,
    });
    expect(info(false, "starting")).not.toHaveProperty("isAdding");
  });
});

describe("the add route", () => {
  it("is the household's, for every client, and knows only apps it could add", async () => {
    const core = await testCore();
    const body = { id: "sanctum.example", version: "1.0.0" };
    expect((await post(core, "/api/apps/add", body)).statusCode).toBe(401);
    const signedIn = await claimed(core);
    expect(
      (await post(core, "/api/apps/add", { id: "sanctum.example" }, signedIn))
        .statusCode,
    ).toBe(400);
    const response = await post(core, "/api/apps/add", body, signedIn);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });
});
