import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createAddedApps } from "../src/app-host/added.js";
import { createAppDeleting } from "../src/app-host/deleting.js";
import type { Gate } from "../src/app-host/gate.js";
import { createListTurns } from "../src/app-host/list-turns.js";
import { createRemovedApps, keptForMs } from "../src/app-host/removed.js";
import { appGrants, appSettings, appsRemoved } from "../src/app-host/schema.js";
import { openCoreDatabase } from "../src/database.js";
import { devices } from "../src/devices/schema.js";
import { lampsCore } from "./devices-support.js";
import { get, post } from "./support.js";

// Deleting a removed app's data, by Delete now or once its 30 days are over:
// the manager's part, which services' data goes with it, and the core's rows.

describe("deleting a removed app's data", () => {
  async function removedLamps() {
    const home = await lampsCore({ origin: "official" });
    await post(home.core, "/api/apps/test.lamps/remove", {}, home.maya);
    return home;
  }

  it("deletes its devices, its answers and settings, and its removal, at once when asked", async () => {
    const { core, maya, lamp } = await removedLamps();

    const response = await post(
      core,
      "/api/apps/test.lamps/data/delete",
      {},
      maya,
    );

    expect(response.statusCode).toBe(200);
    expect(
      core.db
        .select()
        .from(devices)
        .all()
        .map((device) => device.id),
    ).not.toContain(lamp);
    expect(core.db.select().from(appsRemoved).all()).toEqual([]);
    expect(
      core.db
        .select()
        .from(appGrants)
        .all()
        .filter((grant) => grant.appId === "test.lamps"),
    ).toEqual([]);
    expect(
      core.db
        .select()
        .from(appSettings)
        .all()
        .filter((row) => row.appId === "test.lamps"),
    ).toEqual([]);
    expect(
      core.activity
        .recent()
        .filter((entry) => entry.action === "app.delete")
        .map(({ outcome, subjectId }) => ({ outcome, subjectId })),
    ).toEqual([{ outcome: "ok", subjectId: "test.lamps" }]);
    // Asked again, there's nothing left to delete.
    expect(
      (await post(core, "/api/apps/test.lamps/data/delete", {}, maya))
        .statusCode,
    ).toBe(404);
  });

  it("keeps it for 30 days, then deletes it", async () => {
    const { core } = await removedLamps();

    core.advance(keptForMs - 60_000);
    await core.appDeleting.expire();
    expect(core.removedApps.get("test.lamps")).toBeDefined();

    core.advance(60_000);
    await core.appDeleting.expire();
    expect(core.removedApps.get("test.lamps")).toBeUndefined();
  });

  it("is the household's, and only for an app that's removed", async () => {
    const { core, maya } = await lampsCore({ origin: "official" });

    expect(
      (await post(core, "/api/apps/test.lamps/data/delete", {})).statusCode,
    ).toBe(401);
    expect(
      (await post(core, "/api/apps/test.lamps/data/delete", {}, maya))
        .statusCode,
    ).toBe(404);
    expect((await get(core, "/api/apps", maya)).statusCode).toBe(200);
  });
});

describe("the data of the services it used", () => {
  const at = new Date("2026-11-17T12:00:00Z");

  async function setup(other: "added" | "removed" | "none") {
    const folder = await mkdtemp(join(tmpdir(), "sanctum-deleting-"));
    const open = openCoreDatabase(folder);
    onTestFinished(async () => {
      open.close();
      await rm(folder, { recursive: true, force: true });
    });
    const { db } = open;
    const added = createAddedApps(db, { now: () => at });
    const removed = createRemovedApps(db, { now: () => at });
    const grant = (appId: string) =>
      db
        .insert(appGrants)
        .values({
          appId,
          permission: "services:zigbee2mqtt",
          granted: true,
          updatedAt: at,
        })
        .run();
    grant("sanctum.example");
    removed.record(
      "sanctum.example",
      {},
      { name: "Example", version: "1.0.0" },
    );
    removed.done("sanctum.example");
    if (other !== "none") {
      grant("sanctum.other");
      if (other === "added") added.add("sanctum.other", {});
      else {
        removed.record(
          "sanctum.other",
          {},
          { name: "Other", version: "1.0.0" },
        );
      }
    }
    const asked: string[] = [];
    const deleting = createAppDeleting({
      db,
      gate: {} as Gate,
      turns: createListTurns(),
      removed,
      added,
      activity: { for: () => () => "entry" },
      manager: {
        capabilities: () => ({
          appContainers: true,
          memoryLimits: true,
          discovery: false,
          lan: false,
          deletesData: true,
          reserves: false,
        }),
        deleteAppData: async (app) => void asked.push(`data ${app}`),
        eraseServiceData: async (service) =>
          void asked.push(`service ${service}`),
      },
      entities: { removeApp: () => undefined },
      // The other's removal hasn't finished, so its data stays this time.
      finishRemoval: async () => {
        throw new Error("not yet");
      },
      now: () => new Date(at.getTime() + keptForMs),
      log: () => undefined,
    });
    await deleting.expire();
    return asked;
  }

  it("goes with it when no other app uses them", async () => {
    expect(await setup("none")).toEqual([
      "data sanctum.example",
      "service zigbee2mqtt",
    ]);
  });

  it("stays while another app the home has, or keeps, uses them", async () => {
    expect(await setup("added")).toEqual(["data sanctum.example"]);
    expect(await setup("removed")).toEqual(["data sanctum.example"]);
  });
});
