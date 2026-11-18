import { and, eq, inArray, like, ne } from "drizzle-orm";

import type { Activity } from "../activity/activity.js";
import type { Principal } from "../auth/clients.js";
import { durably, type CoreDatabase } from "../database.js";
import { devices } from "../devices/schema.js";
import type { ManagerCapabilities } from "../manager-answers.js";
import { ManagerRefusal, ManagerUnavailable } from "../manager.js";
import { pinnedApps } from "../pins/schema.js";
import { workflowsOffForApps } from "../workflows/schema.js";
import type { AddedApps } from "./added.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import { permissionsRule } from "./grants.js";
import type { ListTurns } from "./list-turns.js";
import { keptForMs, type RemovedApps } from "./removed.js";
import {
  appGrants,
  appSecrets,
  appSettings,
  appsOff,
  appUpdates,
  appVersions,
} from "./schema.js";

// Deleting a removed app's own data, which nothing brings back: by Delete now,
// or once its 30 days are over. The manager deletes its data image, its update
// copies and what Go back kept, and erases the data of each service it used
// that no other app in the home uses, as Zigbee2MQTT's holds the Zigbee network.
// Then one transaction deletes the core's rows: its settings, permission
// answers, secrets and versions, a driver's devices with their history and
// places, its pin, the workflows its removal turned off still waiting for it,
// and its removal itself, and the activity log says so. A step that fails
// leaves its deletion recorded for the next try, as the next deadline check,
// and adding waits until every part has gone. It takes turns with adding and
// removing. Backups of core.db may hold its secrets
// until they're pruned.

const servicePrefix = "services:";
// How often the deadlines are checked, once every one missed while the home
// was off has been caught up at start.
const checkEveryMs = 60 * 60_000;

export function createAppDeleting(options: {
  db: CoreDatabase;
  gate: Gate;
  turns: ListTurns;
  removed: RemovedApps;
  added: Pick<AddedApps, "ids">;
  activity: Pick<Activity, "for">;
  manager: {
    capabilities(): ManagerCapabilities;
    deleteAppData?(app: string): Promise<void>;
    eraseServiceData?(service: string): Promise<void>;
  };
  // What it brought that the core still holds, as entities a removal that
  // stopped part way left.
  entities: { removeApp(appId: string): void };
  now?: () => Date;
  log: (message: string) => void;
}) {
  const { db, log } = options;
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;

  // The services it used, by its answers, that no other app the home has or
  // keeps uses.
  function servicesOnlyIt(appId: string) {
    const used = db
      .select({ permission: appGrants.permission })
      .from(appGrants)
      .where(
        and(
          eq(appGrants.appId, appId),
          like(appGrants.permission, `${servicePrefix}%`),
        ),
      )
      .all()
      .map((row) => row.permission);
    if (used.length === 0) return [];
    const others = new Set([...options.added.ids(), ...options.removed.ids()]);
    others.delete(appId);
    const shared = new Set(
      db
        .select({ appId: appGrants.appId, permission: appGrants.permission })
        .from(appGrants)
        .where(
          and(ne(appGrants.appId, appId), inArray(appGrants.permission, used)),
        )
        .all()
        .filter((row) => others.has(row.appId))
        .map((row) => row.permission),
    );
    return used
      .filter((permission) => !shared.has(permission))
      .map((permission) => permission.slice(servicePrefix.length));
  }

  async function deleteData(
    appId: string,
    who: { personId?: string; clientId?: string; actor?: string },
  ) {
    const row = options.removed.get(appId);
    if (!row) throw new ActionCallError("not_found");
    // Its removal ends first, and an app added back has its data in use.
    if (!row.isDone || options.added.ids().has(appId)) {
      throw new ActionCallError("conflict");
    }
    const { deleteAppData, eraseServiceData } = options.manager;
    if (
      !options.manager.capabilities().deletesData ||
      !deleteAppData ||
      !eraseServiceData
    ) {
      throw new ActionCallError("unavailable");
    }
    options.removed.beginDeleting(appId);
    try {
      await deleteAppData(appId);
      for (const service of servicesOnlyIt(appId)) {
        await eraseServiceData(service);
      }
    } catch (error) {
      if (error instanceof ManagerRefusal && error.status === 409) {
        throw new ActionCallError("conflict");
      }
      if (
        error instanceof ManagerRefusal ||
        error instanceof ManagerUnavailable
      ) {
        throw new ActionCallError("unavailable");
      }
      throw error;
    }
    options.entities.removeApp(appId);
    durably(db, () => {
      for (const table of [
        appSettings,
        appGrants,
        appSecrets,
        appVersions,
        appUpdates,
        appsOff,
        pinnedApps,
      ]) {
        db.delete(table).where(eq(table.appId, appId)).run();
      }
      db.delete(devices).where(eq(devices.driver, appId)).run();
      db.delete(workflowsOffForApps)
        .where(eq(workflowsOffForApps.app, appId))
        .run();
      options.removed.forget(appId);
      options.activity.for(appId)({
        action: "app.delete",
        outcome: "ok",
        subjectId: appId,
        ...who,
        detail: { name: row.name, version: row.version },
      });
    });
    log(`apps: deleted ${appId}'s data`);
  }

  // Check inside the turn: an earlier add and removal can reset a deadline.
  // The whole sweep owns one turn, so stopping waits for every deletion.
  function expire() {
    return options.turns.take(async () => {
      const due = options.removed
        .list()
        .filter(
          (row) =>
            row.isDone &&
            (row.isDeleting ||
              row.removedAt.getTime() + keptForMs <= now().getTime()),
        );
      for (const { appId } of due) {
        await deleteData(appId, { actor: "sanctum" }).catch((error: unknown) =>
          log(
            `apps: ${appId}'s data stays for now (${error instanceof Error ? error.message : String(error)})`,
          ),
        );
      }
    });
  }

  return {
    /** Deletes a removed app's data now, as someone asked. */
    deleteNow(principal: Principal, appId: string) {
      const who = {
        personId: principal.person?.id,
        clientId: principal.client.id,
      };
      try {
        options.gate.admit(principal, permissionsRule);
      } catch (error) {
        if (error instanceof ActionCallError) {
          options.activity.for(appId)({
            action: "app.delete",
            outcome: "refused",
            reason: error.code,
            subjectId: appId,
            ...who,
          });
        }
        throw error;
      }
      return options.turns.take(() => deleteData(appId, who));
    },

    /** Deletes what's past its 30 days and resumes interrupted deletions. */
    expire,

    /** Catches up, then checks now and then, as a step of starting (core.ts). */
    start() {
      void expire();
      timer = setInterval(() => void expire(), checkEveryMs);
      timer.unref();
    },

    close() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

export type AppDeleting = ReturnType<typeof createAppDeleting>;
