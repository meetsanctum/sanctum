import type { AppInfo, AvailableApp } from "@meetsanctum/app-sdk";

import type { Activity } from "../activity/activity.js";
import type { Principal } from "../auth/clients.js";
import type { AddedApps } from "./added.js";
import type { AvailableApps } from "./available.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import { permissionsRule } from "./grants.js";

// Adding an app the home's image brings, from its add sheet: it must still be
// one the home could add, at the version the sheet showed, with nothing
// keeping it from being added, checked again here since the sheet may have
// been open a while. The home's list then holds it, the activity log says who
// added it, and it installs as the home's apps do when the core starts, which
// grants what it needs and what it starts with and starts it. One add at a
// time, so two sheets can't both take the memory or space that's left.

export function createAppAdding(options: {
  gate: Gate;
  available: Pick<AvailableApps, "list">;
  added: Pick<AddedApps, "add" | "ids">;
  activity: Pick<Activity, "for">;
  // Whether the home's apps are installed, so the list is complete.
  hasInstalled: () => boolean;
  // Installs and starts an app the household just added.
  install: (appId: string) => Promise<void>;
  // How the home's apps are listed now, for the answer.
  info: (appId: string) => AppInfo | undefined;
  log: (message: string) => void;
}) {
  const { gate, log } = options;
  let turn: Promise<unknown> = Promise.resolve();

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
    const app: AvailableApp | undefined = (await options.available.list()).find(
      (each) => each.id === appId,
    );
    if (!app) throw new ActionCallError("not_found");
    const detail = { name: app.name, version: app.version };
    // The sheet showed another version, as when Sanctum updated meanwhile.
    if (app.version !== version) throw refuse("conflict", detail);
    if (app.shortfalls.length > 0) throw refuse("unavailable", detail);
    // Who added it is written with it, so neither is without the other.
    const isAdded = options.added.add(appId, who, () =>
      options.activity.for(appId)({
        action: "app.add",
        outcome: "ok",
        subjectId: appId,
        ...who,
        detail,
      }),
    );
    if (!isAdded) throw refuse("conflict", detail);
    try {
      await options.install(appId);
    } catch (error) {
      // It stays added, and the next start installs it.
      log(
        `apps: ${appId} was added and didn't install (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const info = options.info(appId);
    if (!info) throw new ActionCallError("app_failed");
    return info;
  }

  return {
    /** Adds an app the home could add; answers it as the home's apps list it. */
    add(principal: Principal, appId: string, version: string) {
      const result = turn.then(() => add(principal, appId, version));
      turn = result.catch(() => undefined);
      return result;
    },
  };
}

export type AppAdding = ReturnType<typeof createAppAdding>;
