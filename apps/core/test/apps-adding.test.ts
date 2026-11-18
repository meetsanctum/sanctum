import {
  defineApp,
  permissionInfo,
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
import { createListTurns } from "../src/app-host/list-turns.js";
import { createRemovedApps } from "../src/app-host/removed.js";
import { installedInfoOf } from "../src/app-host/app-info.js";
import { ActionCallError } from "../src/app-host/errors.js";
import type { Gate } from "../src/app-host/gate.js";
import { createHardwareOffers } from "../src/app-host/hardware-offers.js";
import type { ApartPackage } from "../src/app-host/loader.js";
import { appsAdded, sticksSeen } from "../src/app-host/schema.js";
import { newSupervision } from "../src/app-host/supervisor.js";
import { openCoreDatabase } from "../src/database.js";
import { ManagerRefusal, ManagerUnavailable } from "../src/manager.js";
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

const zigbee = {
  ...esphome,
  requests: [
    permissionInfo({
      id: "services:zigbee2mqtt",
      reason: "Connects devices",
      needed: true,
    }),
  ],
};
const stick = { path: "/dev/serial/by-id/zigbee-stick", label: "Zigbee stick" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
}

async function addingWith(
  options: {
    available?: AvailableApp[];
    installs?: (pkg: ApartPackage) => Promise<void>;
    hasInstalled?: boolean;
    refuses?: boolean;
    beforeFind?: () => Promise<void>;
    reserve?: Parameters<typeof createAppAdding>[0]["reserve"];
    // How it's listed once installed.
    state?: AppInfo["state"];
    finishRemoval?: (
      removed: ReturnType<typeof createRemovedApps>,
    ) => (appId: string) => Promise<void>;
  } = {},
) {
  const db = await database();
  const added = createAddedApps(db, { now: () => at });
  added.add("sanctum.weather", {});
  const entries: Record<string, unknown>[] = [];
  const installing: string[] = [];
  const logs: string[] = [];
  const installedNow = new Set<string>();
  const removedApps = createRemovedApps(db, { now: () => at });
  const gate = {
    admit: () => {
      if (options.refuses) throw new ActionCallError("forbidden");
    },
  } as unknown as Gate;
  const available = options.available ?? [esphome];
  const offers = createHardwareOffers({
    db,
    gate,
    added,
    available: {
      findWithPermission: async (permissionId) =>
        available.find((app) =>
          app.requests.some(({ id }) => id === permissionId),
        ) ?? null,
    },
    manager: { zigbeeSticks: async () => [stick] },
    hasInstalled: () => options.hasInstalled ?? true,
    log: (line) => logs.push(line),
  });
  const adding = createAppAdding({
    turns: createListTurns(),
    removed: removedApps,
    finishRemoval: options.finishRemoval?.(removedApps),
    workflows: () => ({ added: () => [] }),
    devices: { ofDriver: () => [] },
    gate,
    available: {
      find: async (appId) => {
        await options.beforeFind?.();
        const app = available.find((each) => each.id === appId);
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
    offers,
    activity: {
      for: (source) => (entry) => {
        entries.push({ source, ...entry });
        return "entry";
      },
    },
    hasInstalled: () => options.hasInstalled ?? true,
    reserve: options.reserve,
    install:
      options.installs ??
      (async (pkg) => {
        const appId = pkg.apart.manifest.id;
        installing.push(appId);
        installedNow.add(appId);
      }),
    info: (appId) =>
      installedNow.has(appId)
        ? ({ id: appId, state: options.state ?? "starting" } as AppInfo)
        : undefined,
    log: (line) => logs.push(line),
  });
  return { db, added, adding, entries, installing, logs, offers };
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

  it("forgets its removal when it's added back, and not while that's under way", async () => {
    const { db, adding } = await addingWith();
    const removed = createRemovedApps(db, { now: () => at });
    removed.record(
      "sanctum.example",
      {},
      { name: "Example", version: "1.0.0" },
    );

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "conflict" });

    removed.done("sanctum.example");
    await adding.add(someone, "sanctum.example", "1.0.0");
    expect(removed.get("sanctum.example")).toBeUndefined();
  });

  it("finishes a removal whose last steps failed before adding it back", async () => {
    const { db, adding } = await addingWith({
      finishRemoval: (removed) => async (appId) => removed.done(appId),
    });
    const removed = createRemovedApps(db, { now: () => at });
    removed.record(
      "sanctum.example",
      {},
      { name: "Example", version: "1.0.0" },
    );

    await adding.add(someone, "sanctum.example", "1.0.0");

    expect(removed.get("sanctum.example")).toBeUndefined();
  });

  it("refuses to add back an app whose data deletion has not finished", async () => {
    const { db, adding, installing } = await addingWith();
    const removed = createRemovedApps(db, { now: () => at });
    removed.record(
      "sanctum.example",
      {},
      { name: "Example", version: "1.0.0" },
    );
    removed.done("sanctum.example");
    removed.beginDeleting("sanctum.example");

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(installing).toEqual([]);
    expect(removed.get("sanctum.example")?.isDeleting).toBe(true);
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

  it("holds what it needs in the manager before it's added, its services too", async () => {
    const reserved: unknown[] = [];
    const { adding } = await addingWith({
      available: [zigbee],
      reserve: async (appId, need) => void reserved.push([appId, need]),
    });

    await adding.add(someone, "sanctum.example", "1.0.0");

    expect(reserved).toEqual([
      [
        "sanctum.example",
        { memoryMb: 128, dataMb: 256, services: ["zigbee2mqtt"] },
      ],
    ]);
  });

  it("refuses it when the manager has no room left for it since the sheet", async () => {
    const { added, adding, installing, entries } = await addingWith({
      reserve: async () => {
        throw new ManagerRefusal(
          "sanctum.example needs 128 MB, and only 60 MB are left beside the others",
          409,
        );
      },
    });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(added.ids().has("sanctum.example")).toBe(false);
    expect(installing).toEqual([]);
    expect(entries).toMatchObject([
      { outcome: "refused", reason: "unavailable" },
    ]);
  });

  it("waits while the manager can't answer, so its services can't go uncounted", async () => {
    const { added, adding, logs } = await addingWith({
      reserve: async () => {
        throw new ManagerUnavailable("The manager did not answer");
      },
    });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect(added.ids().has("sanctum.example")).toBe(false);
    expect(logs).toEqual([
      "apps: sanctum.example's room wasn't reserved (The manager did not answer)",
    ]);
  });

  it.each(["off", "paused"] as const)(
    "lets its reservation go when it's added back %s, with no start to take it over",
    async (state) => {
      const released: string[] = [];
      const { adding } = await addingWith({
        state,
        reserve: async (appId) => async () => void released.push(appId),
      });

      await adding.add(someone, "sanctum.example", "1.0.0");

      expect(released).toEqual(["sanctum.example"]);
    },
  );

  it("keeps its reservation for the start that takes it over", async () => {
    const released: string[] = [];
    const { adding } = await addingWith({
      reserve: async (appId) => async () => void released.push(appId),
    });

    await adding.add(someone, "sanctum.example", "1.0.0");

    expect(released).toEqual([]);
  });

  it("lets its reservation go when it doesn't install", async () => {
    const released: string[] = [];
    const { adding } = await addingWith({
      installs: async () => {
        throw new Error("its package isn't staged");
      },
      reserve: async (appId) => async () => void released.push(appId),
    });

    await expect(
      adding.add(someone, "sanctum.example", "1.0.0"),
    ).rejects.toMatchObject({ code: "app_failed" });
    expect(released).toEqual(["sanctum.example"]);
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

describe("adding an app with a hardware offer", () => {
  it("releases what it reserved if the offer ends while reserving", async () => {
    const reserving = deferred();
    const reserved = deferred();
    let isReleased = false;
    const { added, adding, offers } = await addingWith({
      available: [zigbee],
      reserve: async () => {
        reserving.resolve();
        await reserved.promise;
        return async () => {
          isReleased = true;
        };
      },
    });
    await offers.look();
    const { id } = offers.current()!;
    const result = adding.add(someone, zigbee.id, zigbee.version, id);
    await reserving.promise;
    await offers.dismiss(someone, id);
    reserved.resolve();

    await expect(result).rejects.toMatchObject({ code: "conflict" });
    expect(isReleased).toBe(true);
    expect(added.ids().has(zigbee.id)).toBe(false);
  });

  it("refuses the add if another client dismisses the offer during the checks", async () => {
    const refetch = deferred();
    const checked = deferred();
    const { added, adding, offers } = await addingWith({
      available: [zigbee],
      beforeFind: () => {
        checked.resolve();
        return refetch.promise;
      },
    });
    await offers.look();
    const { id } = offers.current()!;
    const result = adding.add(someone, zigbee.id, zigbee.version, id);
    await checked.promise;
    await offers.dismiss(someone, id);
    refetch.resolve();

    await expect(result).rejects.toMatchObject({ code: "conflict" });
    expect(added.ids().has(zigbee.id)).toBe(false);
  });

  it.each(["the offer", "Settings"])(
    "ends and records the offer before an app added from %s starts",
    async (source) => {
      const started = deferred();
      const install = deferred();
      const { db, added, adding, offers } = await addingWith({
        available: [zigbee],
        installs: async () => {
          started.resolve();
          await install.promise;
          throw new Error("couldn't start");
        },
      });
      await offers.look();
      const offerId = source === "the offer" ? offers.current()?.id : undefined;
      expect(offers.current()).not.toBeNull();
      const result = adding.add(someone, zigbee.id, zigbee.version, offerId);
      await started.promise;

      expect(added.ids().has(zigbee.id)).toBe(true);
      expect(offers.current()).toBeNull();
      expect(db.select().from(sticksSeen).get()?.path).toBe(stick.path);
      install.resolve();
      await expect(result).rejects.toMatchObject({ code: "app_failed" });
    },
  );
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
    const stale = await post(
      core,
      "/api/apps/add",
      { ...body, offerId: "ended" },
      signedIn,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "conflict" });
  });
});
