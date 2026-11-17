import type { AppRemoval, DeviceInfo } from "@meetsanctum/app-sdk";

import type { Activity } from "../activity/activity.js";
import type { Principal } from "../auth/clients.js";
import type { DeviceChange, Devices } from "../devices/devices.js";
import type { WorkflowsForApps } from "../workflows/for-apps.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import { permissionsRule } from "./grants.js";
import type { AppHost } from "./host.js";
import type { ListTurns } from "./list-turns.js";
import type { RemovedApps } from "./removed.js";
import type { AppUpdates } from "./updates.js";

// Removing an app, which only someone does, from its settings. What it
// brings leaves the home at once, and its own data stays (removed.ts).
// First, in one transaction: the app comes off the home's list, its removal
// is recorded with who removed it, the workflows and jobs it keeps go, the
// household's workflows that use it turn off, and the activity log says so.
// Then every client hears it's gone, with a driver's devices, which are
// hidden, and the app stops, its container goes and the manager releases
// its services, keeping their data. A core that stops part way finishes
// those steps at its next start. Not while it's updating or going back,
// whose journals hold the app's data; removing waits its turn with adding.

export function createAppRemoving(options: {
  gate: Gate;
  turns: ListTurns;
  host: Pick<AppHost, "list" | "remove" | "manifest">;
  removed: RemovedApps;
  updates: Pick<AppUpdates, "shownFor">;
  workflows: () => WorkflowsForApps;
  devices: Pick<Devices, "ofDriver">;
  activity: Pick<Activity, "for">;
  manager: {
    removeAppContainer(app: string): Promise<void>;
    servicesHeldBy?(app: string): Promise<string[]>;
    releaseService(service: string, app: string): Promise<void>;
  };
  // What clients hear: the app gone, and each of its devices hidden.
  onRemoved?: (appId: string) => void;
  onDevice?: (change: DeviceChange) => void;
  log: (message: string) => void;
}) {
  const { gate, log } = options;
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  // What Remove's dialog names before anything changes.
  function removal(appId: string): AppRemoval {
    const manifest = options.host.manifest(appId);
    if (!manifest) throw new ActionCallError("not_found");
    const devices = manifest.driver ? options.devices.ofDriver(appId) : [];
    return {
      devices: devices.length,
      workflows: options
        .workflows()
        .using(
          appId,
          devices.map((device) => device.id),
        )
        .filter((workflow) => workflow.enabled)
        .map(({ id, name }) => ({ id, name })),
      widgets: manifest.provides.widgets.length,
      roomSections: manifest.provides.roomSections.length,
    };
  }

  // The steps after the first transaction, each again until it's done: a
  // container or a service that can't go now is logged, and goes with the
  // next start's finishing.
  async function finish(appId: string) {
    // An installed app stops and its container goes; one a core that
    // stopped part way left isn't installed, and only its container goes.
    if (options.host.list().some((app) => app.id === appId)) {
      await options.host.remove(appId);
    } else {
      await options.manager.removeAppContainer(appId);
    }
    const held = await options.manager.servicesHeldBy?.(appId);
    for (const service of held ?? []) {
      await options.manager.releaseService(service, appId);
    }
    options.removed.done(appId);
  }

  async function remove(principal: Principal, appId: string) {
    const who = {
      personId: principal.person?.id,
      clientId: principal.client.id,
    };
    const refuse = (code: ActionCallError["code"]) => {
      options.activity.for(appId)({
        action: "app.remove",
        outcome: "refused",
        reason: code,
        subjectId: appId,
        ...who,
      });
      return new ActionCallError(code);
    };
    try {
      gate.admit(principal, permissionsRule);
    } catch (error) {
      if (error instanceof ActionCallError) throw refuse(error.code);
      throw error;
    }
    const app = options.host.list().find((each) => each.id === appId);
    if (!app) throw new ActionCallError("not_found");
    if (app.origin === "system") throw refuse("forbidden");
    const stage = options.updates.shownFor(appId)?.stage;
    if (stage === "updating" || stage === "goingBack") {
      throw refuse("conflict");
    }
    const manifest = options.host.manifest(appId)!;
    const devices: DeviceInfo[] = manifest.driver
      ? options.devices.ofDriver(appId)
      : [];
    let endRuns = () => undefined as void;
    options.removed.record(
      appId,
      who,
      { name: app.name, version: app.version },
      () => {
        endRuns = options.workflows().removing(
          appId,
          devices.map((device) => device.id),
        );
        options.activity.for(appId)({
          action: "app.remove",
          outcome: "ok",
          subjectId: appId,
          ...who,
          detail: { name: app.name, version: app.version },
        });
      },
    );
    endRuns();
    for (const device of devices) {
      options.onDevice?.({ id: device.id, before: device, after: null });
    }
    options.onRemoved?.(appId);
    await finish(appId);
  }

  return {
    /** What removing it takes from the home, for its dialog. */
    removal,

    /** Removes an installed app, but a system app. */
    remove(principal: Principal, appId: string) {
      return options.turns.take(() => remove(principal, appId));
    },

    /** Finishes the removals a core that stopped left part way. */
    resume() {
      return options.turns.take(async () => {
        for (const { appId } of options.removed
          .list()
          .filter((row) => !row.isDone)) {
          await finish(appId).catch((error: unknown) =>
            log(`apps: ${appId}'s removal didn't finish (${message(error)})`),
          );
        }
      });
    },
  };
}

export type AppRemoving = ReturnType<typeof createAppRemoving>;
