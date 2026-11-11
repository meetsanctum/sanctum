import {
  permissionIds,
  type StaticManifest,
  type AppSettings,
} from "@meetsanctum/app-sdk";

import type { Outcome } from "../activity/schema.js";
import type { Principal } from "../auth/clients.js";
import type { Who } from "./actions.js";
import type { CoreEvents } from "./core-events.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import { permissionsRule, type AppGrants } from "./grants.js";
import {
  settingsChanges,
  settingsRule,
  type AppSettingsStore,
} from "./settings.js";

// What the household chooses for an installed app: its settings and its
// grants. Each change passes the gate and goes to the activity log with
// whoever made it, and so does a refusal.

type Chosen = {
  origin: string;
  manifest: StaticManifest;
  granted: string[];
  grantsRevision: number;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createAppChoices<Entry extends Chosen>(options: {
  installed: ReadonlyMap<string, Entry>;
  gate: Gate;
  record: (
    appId: string,
    actionId: string,
    who: Who,
    outcome: Outcome,
    reason?: string,
    subjectId?: string,
  ) => unknown;
  settings: AppSettingsStore;
  // An app's settings as it reads them, which may fail as app code.
  settingsOf: (entry: Entry) => AppSettings;
  grants: AppGrants;
  coreEvents: Pick<CoreEvents, "permissions">;
  // Someone changed an app's settings.
  onSettings?: (appId: string, settings: AppSettings) => void;
  // Before a permission the app holds goes off, what it lets the app hold
  // outside the core, such as a broker account, is taken back; the switch
  // goes off only once it is. Nothing when there is nothing to take back;
  // rejects, leaving it on, when it cannot be.
  beforeOff?: (entry: Entry, permission: string) => Promise<void> | undefined;
  // Someone granted an app a permission or took it away.
  onPermission?: (entry: Entry, permission: string, granted: boolean) => void;
  // Someone asked for an app again after it stopped for good: whether it can be.
  onRestart?: (entry: Entry) => boolean;
  // Someone asked to go back from an app's last update: whether it can.
  onGoBack?: (entry: Entry, copyId: string) => Promise<boolean>;
  // Someone turned an app off or on.
  onOff?: (entry: Entry, off: boolean) => void;
  log: (message: string) => void;
}) {
  const { installed, gate, record, log } = options;
  // The apps whose grant change waits for something taken back.
  const waiting = new Set<string>();

  function entryOf(appId: string) {
    const entry = installed.get(appId);
    if (!entry) {
      throw new ActionCallError("not_found");
    }
    return entry;
  }

  // Lets the change through the gate, recording a refusal.
  function admit(
    principal: Principal,
    appId: string,
    action: string,
    rule: Parameters<Gate["admit"]>[1],
  ): Who {
    const who = {
      personId: principal.person?.id,
      clientId: principal.client.id,
    };
    try {
      gate.admit(principal, rule);
    } catch (error) {
      if (error instanceof ActionCallError) {
        record(appId, action, who, "refused", error.code);
      }
      throw error;
    }
    return who;
  }

  // Someone grants an app one permission it asks for, or takes it away.
  // A running app hears it as permissions.changed, and one that needs it
  // pauses until it is back. A change takes effect at once, unless what
  // the permission let the app hold must be taken back first; meanwhile
  // another change for the app is a conflict. Answers what the app may do
  // now.
  // Starts an app again that its supervisor gave up on, which only someone can
  // do. Like its grants, it's the household's to choose, on every client.
  function restart(request: { principal: Principal; appId: string }) {
    const { principal, appId } = request;
    const entry = entryOf(appId);
    const who = admit(principal, appId, "restart", permissionsRule);
    if (!options.onRestart?.(entry)) {
      record(appId, "restart", who, "refused", "conflict");
      throw new ActionCallError("conflict");
    }
    record(appId, "restart", who, "ok");
  }

  // Goes back from an app's last update, losing what it has saved since, so the
  // client asks first. Like its grants, it's the household's to choose.
  async function goBack(request: {
    principal: Principal;
    appId: string;
    copyId: string;
  }) {
    const { principal, appId, copyId } = request;
    const entry = entryOf(appId);
    const who = admit(principal, appId, "go-back", permissionsRule);
    if (!(await options.onGoBack?.(entry, copyId))) {
      record(appId, "go-back", who, "refused", "conflict");
      throw new ActionCallError("conflict");
    }
    record(appId, "go-back", who, "ok");
  }

  // Turns an app off or on, in its settings. Like its grants, it's the household's
  // to choose, on every client. System apps stay on.
  function setOff(request: {
    principal: Principal;
    appId: string;
    off: boolean;
  }) {
    const { principal, appId, off } = request;
    const entry = entryOf(appId);
    const action = off ? "turn-off" : "turn-on";
    const who = admit(principal, appId, action, permissionsRule);
    if (entry.origin === "system") {
      record(appId, action, who, "refused", "forbidden");
      throw new ActionCallError("forbidden");
    }
    options.onOff?.(entry, off);
    record(appId, action, who, "ok");
  }

  async function setPermission(request: {
    principal: Principal;
    appId: string;
    permission: string;
    granted: boolean;
  }): Promise<string[]> {
    const { principal, appId, permission, granted } = request;
    const entry = entryOf(appId);
    const action = "permissions.update";
    const who = admit(principal, appId, action, permissionsRule);
    if (!permissionIds(entry.manifest.permissions).includes(permission)) {
      throw new ActionCallError("invalid_request");
    }
    if (waiting.has(appId)) {
      throw new ActionCallError("conflict");
    }
    const takingBack =
      !granted && entry.granted.includes(permission)
        ? options.beforeOff?.(entry, permission)
        : undefined;
    if (takingBack) {
      waiting.add(appId);
      try {
        await takingBack;
      } catch (error) {
        record(
          appId,
          action,
          who,
          "failed",
          "unavailable",
          `${permission} off`,
        );
        throw error;
      } finally {
        waiting.delete(appId);
      }
    }
    // The app may have been removed or replaced while the manager answered.
    if (installed.get(appId) !== entry) {
      throw new ActionCallError("not_found");
    }
    const changed = options.grants.set(
      entry.manifest,
      permission,
      granted,
      () =>
        record(
          appId,
          action,
          who,
          "ok",
          undefined,
          `${permission} ${granted ? "on" : "off"}`,
        ),
    );
    if (changed) {
      const before = entry.granted;
      entry.granted = options.grants.of(entry.manifest);
      entry.grantsRevision += 1;
      options.coreEvents.permissions(appId, before, entry.granted);
      options.onPermission?.(entry, permission, granted);
    }
    return [...entry.granted];
  }

  return {
    // An installed app's settings, with its schema's defaults.
    settings(appId: string): AppSettings {
      return options.settingsOf(entryOf(appId));
    },

    // Someone changes some of an app's settings. Answers all its settings
    // now.
    updateSettings(request: {
      principal: Principal;
      appId: string;
      changes: unknown;
    }): AppSettings {
      const { principal, appId } = request;
      const entry = entryOf(appId);
      const action = "settings.update";
      const who = admit(principal, appId, action, settingsRule);
      const changes = settingsChanges.safeParse(request.changes);
      if (!changes.success) {
        throw new ActionCallError("invalid_request");
      }
      let settings: AppSettings | undefined;
      try {
        settings = options.settings.change(
          entry.manifest.id,
          entry.manifest.settings,
          changes.data,
          () =>
            record(
              appId,
              action,
              who,
              "ok",
              undefined,
              Object.keys(changes.data).sort().join(","),
            ),
        );
      } catch (error) {
        log(`apps: ${appId}'s settings failed (${message(error)})`);
        throw new ActionCallError("app_failed");
      }
      if (!settings) {
        throw new ActionCallError("invalid_request");
      }
      options.onSettings?.(appId, settings);
      return settings;
    },

    setPermission,
    restart,
    goBack,
    setOff,
  };
}
