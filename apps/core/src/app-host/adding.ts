import type { AppInfo } from "@meetsanctum/app-sdk";

import type { Activity } from "../activity/activity.js";
import type { Principal } from "../auth/clients.js";
import type { DeviceChange, Devices } from "../devices/devices.js";
import type { WorkflowsForApps } from "../workflows/for-apps.js";
import type { AddedApps } from "./added.js";
import type { AvailableApps } from "./available.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import { permissionsRule } from "./grants.js";
import type { ListTurns } from "./list-turns.js";
import type { ApartPackage } from "./loader.js";
import type { RemovedApps } from "./removed.js";

// Adding an app the home's image brings, from its add sheet: it must still be
// one the home could add, at the version the sheet showed, with nothing
// keeping it from being added, checked again here since the sheet may have
// been open a while. The home's list then holds it, the activity log says who
// added it, and it installs as the home's apps do when the core starts, which
// grants what it needs and what it starts with and starts it. One add at a
// time, so two sheets can't both take the memory or space that's left.
//
// Adding back an app the household removed, while its own data is kept,
// forgets its removal in the same transaction: a driver's devices show again
// as they were. Its first successful start restores the household's
// workflows its removal turned off, unless someone changed them since or
// they still miss something.

export function createAppAdding(options: {
  gate: Gate;
  turns: ListTurns;
  removed: Pick<RemovedApps, "get" | "forget">;
  workflows: () => Pick<WorkflowsForApps, "added">;
  devices: Pick<Devices, "ofDriver">;
  // Finishes the steps of its removal that failed, in this turn.
  finishRemoval?: (appId: string) => Promise<void>;
  // What clients hear of a driver's devices that show again.
  onDevice?: (change: DeviceChange) => void;
  available: Pick<AvailableApps, "find">;
  added: Pick<AddedApps, "add" | "ids">;
  activity: Pick<Activity, "for">;
  // Whether the home's apps are installed, so the list is complete.
  hasInstalled: () => boolean;
  // Installs and starts an app the household just added.
  install: (pkg: ApartPackage) => Promise<void>;
  // How the home's apps are listed now, for the answer.
  info: (appId: string) => AppInfo | undefined;
  log: (message: string) => void;
}) {
  const { gate, log } = options;

  async function add(
    principal: Principal,
    appId: string,
    version: string,
  ): Promise<AppInfo> {
    const who = {
      personId: principal.person?.id,
      clientId: principal.client.id,
    };
    const refuse = (
      code: ActionCallError["code"],
      detail?: Record<string, unknown>,
    ) => {
      options.activity.for(appId)({
        action: "app.add",
        outcome: "refused",
        reason: code,
        subjectId: appId,
        ...who,
        ...(detail ? { detail } : {}),
      });
      return new ActionCallError(code);
    };
    try {
      gate.admit(principal, permissionsRule);
    } catch (error) {
      if (error instanceof ActionCallError) throw refuse(error.code);
      throw error;
    }
    // Until the home's apps are installed, an app already added may not be
    // listed yet.
    if (!options.hasInstalled()) throw new ActionCallError("unavailable");
    if (options.added.ids().has(appId)) throw refuse("conflict");
    const offered = await options.available.find(appId);
    if (!offered) throw new ActionCallError("not_found");
    const { app, pkg } = offered;
    const detail = { name: app.name, version: app.version };
    // The sheet showed another version, as when Sanctum updated meanwhile.
    if (app.version !== version) throw refuse("conflict", detail);
    if (app.shortfalls.length > 0) throw refuse("unavailable", detail);
    let removal = options.removed.get(appId);
    // Its removal ends before it can come back: steps that failed when it
    // was removed are tried again now.
    if (removal && !removal.isDone) {
      await options
        .finishRemoval?.(appId)
        .catch((error: unknown) =>
          log(
            `apps: ${appId}'s removal didn't finish (${error instanceof Error ? error.message : String(error)})`,
          ),
        );
      removal = options.removed.get(appId);
    }
    if (removal && !removal.isDone) throw refuse("conflict", detail);
    // Who added it is written with it, so neither is without the other.
    const isAdded = options.added.add(appId, who, () => {
      if (removal) options.removed.forget(appId);
      options.activity.for(appId)({
        action: "app.add",
        outcome: "ok",
        subjectId: appId,
        ...who,
        detail,
      });
    });
    if (!isAdded) throw refuse("conflict", detail);
    if (removal) {
      for (const device of options.devices.ofDriver(appId)) {
        options.onDevice?.({ id: device.id, before: null, after: device });
      }
    }
    try {
      await options.install(pkg);
    } catch (error) {
      // It stays added, and the next start installs it.
      log(
        `apps: ${appId} was added and didn't install (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const info = options.info(appId);
    if (!info) throw new ActionCallError("app_failed");
    // An app kept off or paused has no start to wait for.
    if (removal && (info.state === "off" || info.state === "paused")) {
      options.workflows().added(appId);
    }
    return info;
  }

  return {
    /** Adds an app the home could add; answers it as the home's apps list it. */
    add(principal: Principal, appId: string, version: string) {
      return options.turns.take(() => add(principal, appId, version));
    },
  };
}

export type AppAdding = ReturnType<typeof createAppAdding>;
