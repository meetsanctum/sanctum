import type { AppRemoval, DeviceInfo } from "@meetsanctum/app-sdk";

import type { Activity } from "../activity/activity.js";
import type { Principal } from "../auth/clients.js";
import type { DeviceChange, Devices } from "../devices/devices.js";
import type { Entities } from "../entities/entities.js";
import type { WorkflowsForApps } from "../workflows/for-apps.js";
import { ActionCallError, withTimeout } from "./errors.js";
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

// How long one try at those steps may take. A manager that keeps failing
// leaves them for the next try, the hourly check's or an add's, and doesn't
// hold up adding, removing and deleting meanwhile.
const finishWithinMs = 2 * 60_000;

export function createAppRemoving(options: {
  gate: Gate;
  turns: ListTurns;
  host: Pick<AppHost, "list" | "remove" | "manifest">;
  removed: RemovedApps;
  updates: Pick<AppUpdates, "shownFor">;
  workflows: () => WorkflowsForApps;
  devices: Pick<Devices, "ofDriver">;
  entities: Pick<Entities, "removeApp">;
  activity: Pick<Activity, "for">;
  manager: {
    removeAppContainer(app: string): Promise<void>;
    servicesHeldBy?(
      app: string,
      options?: { signal?: AbortSignal },
    ): Promise<string[]>;
    releaseService(
      service: string,
      app: string,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  };
  finishWithinMs?: number;
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
  // next try.
  async function finish(appId: string) {
    const withinMs = options.finishWithinMs ?? finishWithinMs;
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), withinMs);
    const { signal } = giveUp;
    try {
      // An installed app stops and its container goes; one a core that
      // stopped part way left isn't installed, and only its container goes.
      if (options.host.list().some((app) => app.id === appId)) {
        // Past the limit its own release goes on, and a request for its
        // services waits for it (services.ts), as when it's added again.
        await withTimeout(options.host.remove(appId), withinMs);
      } else {
        // What it brought, if a removal that failed part way left it.
        options.entities.removeApp(appId);
        await options.manager.removeAppContainer(appId);
      }
      const held = await options.manager.servicesHeldBy?.(appId, { signal });
      for (const service of held ?? []) {
        await options.manager.releaseService(service, appId, { signal });
      }
      options.removed.done(appId);
    } finally {
      clearTimeout(timer);
    }
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
    // It's removed once that has committed: a step that fails now is done
    // again at the next start, and doesn't make the removal fail.
    await finish(appId).catch((error: unknown) =>
      log(
        `apps: ${appId}'s removal finishes at the next start (${message(error)})`,
      ),
    );
  }

  return {
    /** What removing it takes from the home, for its dialog. */
    removal,

    /** Removes an installed app, but a system app. */
    remove(principal: Principal, appId: string) {
      return options.turns.take(() => remove(principal, appId));
    },

    /** Finishes one app's removal now, within a turn already taken. */
    finish,

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
