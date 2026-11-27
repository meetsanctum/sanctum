import {
  aiAssistantPermission,
  registerPermission,
  type AppGoBack,
  type AppRunning,
  type AppSettings,
  type AppInfo,
  type Sighting,
} from "@meetsanctum/app-sdk";
import { randomUUID } from "node:crypto";

import type { Activity } from "../activity/activity.js";
import type { AssistantCalls } from "../agents/assistants.js";
import { createRequests } from "./requests.js";
import type { Turns } from "../models/turns.js";
import type { ManagerClient } from "../manager.js";
import type { AgentsCanUse, AppOffers } from "../agents/can-use.js";
import type { Devices } from "../devices/devices.js";
import type { Pairing } from "../devices/pairing.js";
import type { Firmware } from "../devices/firmware.js";
import type { Found } from "../devices/found.js";
import type { Problems } from "../devices/problems.js";
import type { Presses } from "../devices/presses.js";
import type { Entities } from "../entities/entities.js";
import type { People } from "../people/people.js";
import type { PlacesModule } from "../places/places.js";
import type { AppPieces } from "./contract.js";
import { createActionCalls } from "./action-calls.js";
import { createActionRunner } from "./actions.js";
import { announcerOf, appStateOf, installedInfoOf } from "./app-info.js";
import { deviceKinds } from "./calls.js";
import { createAppChoices } from "./choices.js";
import type { AppCommits } from "./commits.js";
import type { AppUpdates } from "./updates.js";
import { createAppContexts } from "./contexts.js";
import { createEventsForApps } from "./events-for-apps.js";
import { createDriverCalls } from "./drivers.js";
import { ActionCallError, type ActionCallErrorCode } from "./errors.js";
import type { Gate } from "./gate.js";
import type { AppGrants } from "./grants.js";
import type { InstalledApp } from "./installed.js";
import type { ApartPackage } from "./loader.js";
import { createAppLifecycle } from "./lifecycle.js";
import type { NetFetch } from "./net.js";
import { createAppServices, type ServiceManager } from "./services.js";
import type { Blobs } from "../blobs/blobs.js";
import type { Listening } from "../speech/listening.js";
import type { AppSecrets } from "./secrets.js";
import type { AppSettingsStore } from "./settings.js";
import { createSupervisor, type AppContainerManager } from "./supervisor.js";
import type { AppsOff } from "./off.js";
import type { EmittedEvent, JobCalls, KeptWorkflowCalls } from "./app-work.js";
import { createApartStarts } from "./apart-starts.js";
import { createDiscoveryHandOut } from "./discovered.js";
import { createLanPolicies } from "./lan.js";
import { createAppInstaller } from "./install.js";
import type { AppVersions } from "./versions.js";
import type { WaitingUpdates } from "./waiting.js";
import { createAppUpdateChoices } from "./update-choices.js";
import { createAppRunChoices } from "./run-choices.js";

// The app host: installs the apps the core found, gives each its own
// database and the services it declares, starts and stops them
// (lifecycle.ts), runs their actions, hands running apps the core's events
// they follow (events-for-apps.ts) and hands driver apps what Devices asks of
// them (drivers.ts). Every call goes through the permission gate. Every app
// runs apart, in its own container with its own database, and the core knows
// it by its manifest alone, never importing its code (apart.ts). The services it holds
// follow its grants (run-choices.ts), and its actions run as calls from
// clients, workflows and jobs (action-calls.ts). What an app brings to the
// home stays only while it is installed; its settings, which change through
// the gate too, stay with its database.

type Log = (message: string) => void;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createAppHost(options: {
  gate: Gate;
  activity: Activity;
  manager: ServiceManager &
    AppContainerManager &
    Pick<ManagerClient, "hostResources">;
  people: Pick<People, "list">;
  places: Pick<PlacesModule, "list" | "location" | "clock" | "setLanguage">;
  devices: Devices;
  // Where drivers' presses go, and apps' pages' captures of them.
  presses: () => Pick<Presses, "press" | "released" | "endCaptures">;
  // Where what drivers say of firmware goes.
  firmware: () => Pick<Firmware, "report">;
  // Where what drivers say is wrong with their devices goes.
  problems: () => Pick<Problems, "report">;
  // Where what drivers say they found and could add goes.
  found: () => Pick<Found, "report">;
  // Each event an app emits, once it goes out.
  onEvent?: (event: EmittedEvent) => void;
  jobs?: JobCalls;
  workflows?: KeptWorkflowCalls;
  entities: Entities;
  settings: AppSettingsStore;
  // Apps' own secrets, sealed by the core.
  secrets: AppSecrets;
  // The pictures drivers hand over, in the core's memory.
  blobs: Blobs;
  // Smart speakers' runs (speech/listening.ts).
  listening?: Listening;
  // What the manager found on the home's network (discovery/sightings.ts).
  sightings?: () => readonly Sighting[];
  grants: AppGrants;
  // What AI agents can use of each app, and of the core.
  agents: Pick<
    AgentsCanUse,
    "adopt" | "areaOn" | "canUse" | "readableDeviceKinds"
  >;
  commits: AppCommits;
  updates: AppUpdates;
  versions: Pick<AppVersions, "last">;
  waiting: WaitingUpdates;
  off: AppsOff;
  // Someone changed an app's settings.
  onSettings?: (appId: string, settings: AppSettings) => void;
  // An app's grants changed, or it stopped: as clients list it now.
  onApp?: (app: AppInfo) => void;
  net: NetFetch;
  pairing: () => Pick<Pairing, "joining">;
  // The turns in which apps ask the home's AI model.
  turns: Pick<Turns, "open" | "source">;
  // The tools an assistant app calls within its turns.
  assistant: AssistantCalls;
  log: Log;
  timeoutMs?: number;
  now?: () => Date;
  // Where the core listens for apps apart.
  appSockets?: string;
  // How its supervisor paces them, for tests.
  supervision?: Pick<
    Parameters<typeof createSupervisor>[0],
    | "restartPausesMs"
    | "waitPausesMs"
    | "connectWithinMs"
    | "quietMs"
    | "attentionMs"
  >;
}) {
  const { gate, activity, manager, log } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const installed = new Map<string, InstalledApp>();
  const removals = new Map<string, Promise<void>>();
  const eventsForApps = createEventsForApps({ timeoutMs, log });
  const appServices = createAppServices({ manager, timeoutMs, log });

  // Only while it is still installed: a removal or a new install may have
  // overtaken the change.
  const announceNow = announcerOf(options.onApp, log, ({ manifest }) =>
    options.updates.shownFor(manifest.id),
  );
  // What drivers hear of the home's network, and what those that reach
  // devices may reach, follow whether each runs.
  let handOut: ReturnType<typeof createDiscoveryHandOut> | undefined;
  const lan = createLanPolicies({
    core: randomUUID(),
    manager,
    installed,
    sightings: () => options.sightings?.() ?? [],
    onReach: () => handOut?.sync(),
    log,
  });
  const announce = (entry: InstalledApp) => {
    if (installed.get(entry.app.id) !== entry) return;
    announceNow(entry);
    lan.sync();
    handOut?.sync();
  };

  // Counts a call under way until it settles.
  function track<T>(entry: InstalledApp, call: Promise<T>): Promise<T> {
    entry.calls.add(call);
    const settled = () => void entry.calls.delete(call);
    call.then(settled, settled);
    return call;
  }

  const contexts = createAppContexts({
    ...options,
    modelSource: options.turns.source,
    host: () => options.manager.hostResources(),
    entities: options.entities,
    now,
    isInstalled: (entry) => installed.get(entry.app.id) === entry,
    isOff: (appId) => installed.get(appId)?.off === true,
  });
  const { settingsOf, contextFor, deliver } = contexts;
  // A driver's devices stay paired while it's down. A database failure must
  // neither end the core's timer nor prevent the driver's container stopping.
  function markDriverOffline(entry: InstalledApp) {
    if (!entry.manifest.driver) return;
    options.listening?.driverStopped(entry.app.id);
    try {
      options.devices.markDriverOffline(entry.app.id);
    } catch (error) {
      log(
        `${entry.app.id}'s devices couldn't be marked offline: ${String(error)}`,
      );
    }
  }
  const supervisor = createSupervisor({
    manager,
    reconcile: (entry) => reconcile(entry),
    gone: (entry) => gone(entry),
    announce,
    settled: markDriverOffline,
    updateFailed: (entry, failure) => options.updates.failed(entry, failure),
    updateNotReady: (entry, waitingFor) =>
      options.updates.notReady(entry, waitingFor),
    lan,
    log,
    now,
    ...options.supervision,
  });
  const install = createAppInstaller({
    installed,
    entities: options.entities,
    updates: options.updates,
    grants: options.grants,
    agents: options.agents,
    versions: options.versions,
    waiting: options.waiting,
    off: options.off,
    appServices,
    supervisor: () => supervisor,
    contexts,
    appSockets: options.appSockets,
    timeoutMs,
    log,
    now,
  });
  let isOnTrial = false;
  // The core is stopping: nothing more installs or starts.
  let isClosing = false;
  let installing = Promise.resolve();
  // Whether the packages the core started with are installed. Until then the
  // home's apps aren't known, which is not the same as having none.
  let hasInstalled = false;
  // The apps whose entities stay: those checked as they installed, and those
  // the core says are coming, as one whose package isn't staged yet.
  const kept = new Set<string>();
  const waitingForCommit: InstalledApp[] = [];
  const apartStarts = createApartStarts({
    installed,
    removals,
    updates: options.updates,
    supervisor,
    install,
    stopApp: (entry, info) => stopApp(entry, info),
    announce,
    log,
  });
  const startApart = apartStarts.start;
  const { accepts, stopApp, reconcile, gone, uninstall } = createAppLifecycle({
    installed,
    eventsForApps,
    contexts,
    people: options.people,
    places: options.places,
    devices: options.devices,
    entities: options.entities,
    presses: options.presses,
    commits: options.commits,
    updates: options.updates,
    supervisor: () => supervisor,
    canStart: (entry) => lan.canRun(entry),
    stopped: (entry) => requests.stopped(entry),
    timeoutMs,
    log,
  });

  const { record, recordRefusal, execute } = createActionRunner<InstalledApp>({
    activity,
    timeoutMs,
    log,
    contextFor,
    deliver,
    turnFor: (entry, who) =>
      options.turns.open({
        appId: entry.app.id,
        appName: entry.manifest.name,
        who,
      }),
    deviceById: options.devices.row,
  });
  const { offChangeOf, ...runChoices } = createAppRunChoices({
    installed,
    off: options.off,
    waiting: options.waiting,
    presses: options.presses,
    appServices,
    lan,
    syncDiscovery: () => handOut?.sync(),
    supervisor,
    reconcile,
    startApart,
    announce,
    markDriverOffline,
    log,
  });
  const choices = createAppChoices({
    installed,
    ...runChoices,
    onPermission(entry, permission, granted) {
      if (!granted && permission === aiAssistantPermission) {
        requests.stopped(entry);
      }
      // A driver that may no longer register devices hands over no runs.
      if (!granted && permission === registerPermission) {
        options.listening?.driverStopped(entry.app.id);
      }
      runChoices.onPermission(entry, permission, granted);
    },
    ...createAppUpdateChoices({
      installed,
      updates: options.updates,
      waiting: options.waiting,
      offChangeOf,
      announce,
      log,
    }),
    gate,
    record,
    settings: options.settings,
    settingsOf,
    grants: options.grants,
    eventsForApps,
    onSettings: options.onSettings,
    log,
  });

  const { call, invoke } = createActionCalls({
    installed,
    gate,
    supervisor,
    accepts,
    agentWho: activity.agentWho,
    agentCanUse: (appId, actionId) =>
      options.agents.canUse(appId, actionId, "action"),
    recordRefusal,
    execute,
    track,
    timeoutMs,
  });

  const requests = createRequests({
    installed,
    accepts,
    arrives: (entry, signal) =>
      appStateOf(entry) === "paused"
        ? Promise.resolve(false)
        : supervisor.arrives(entry, timeoutMs, signal),
    contextFor,
    coreOf: contexts.coreOf,
    turnFor: (entry, who) =>
      options.turns.open({
        appId: entry.app.id,
        appName: entry.manifest.name,
        who,
      }),
    track,
    log,
  });

  const drivers = createDriverCalls({
    installed,
    accepts,
    permit: gate.permit,
    arrives: (entry) =>
      appStateOf(entry) === "paused"
        ? Promise.resolve(false)
        : supervisor.arrives(entry, timeoutMs),
    contextFor,
    track,
    timeoutMs,
    log,
  });
  handOut = createDiscoveryHandOut({
    installed,
    accepts,
    sightings: () => options.sightings?.() ?? [],
    reachable: (entry) => lan.reachable(entry),
    discovered: (appId, discovery) => drivers.discovered(appId, discovery),
    log,
  });

  return {
    // Installs the packages the core found, then starts them. A package
    // that cannot be installed is logged and left out, and the others go on.
    // It can be called again for packages that arrive later. Resolves once
    // each app listens on its socket, after any recovery of an update, or has
    // failed to, which its supervisor or the next recovery then takes up; on
    // trial, once each waits for the commit, which opens its socket. Its
    // container and start come after that, as its supervisor has them.
    async start(
      packages: readonly ApartPackage[] | Promise<readonly ApartPackage[]>,
      {
        onTrial = false,
        coming,
        adding = [],
      }: {
        onTrial?: boolean;
        // Read after package selection records the home's list.
        coming?: () => readonly string[];
        // Those someone just added, which say so until their first start
        // returns.
        adding?: readonly string[];
      } = {},
    ) {
      isOnTrial = onTrial;
      let allInstalled!: () => void;
      installing = new Promise<void>((resolve) => {
        allInstalled = resolve;
      });
      const added: InstalledApp[] = [];
      const checked = new Set<string>();
      try {
        const resolvedPackages = await packages;
        for (const appId of coming?.() ?? []) kept.add(appId);
        for (const pkg of resolvedPackages) {
          if (isClosing) break;
          const appId = pkg.apart.manifest.id;
          try {
            // Its old stop and socket cleanup must finish before a new install
            // binds the same path.
            await removals.get(appId);
            if (isClosing) break;
            // One someone is adding is as its sheet showed, and an update
            // under way goes on as it began, as does staying on the version
            // before one someone went back from, which waits for nothing;
            // otherwise one that needs what nobody allowed waits.
            const isAdding = adding.includes(appId);
            const isDecided = options.updates.isUnderWay(pkg);
            if (
              isAdding ||
              (isDecided &&
                options.updates.shownFor(appId)?.stage === "wentBack")
            ) {
              options.waiting.forget(appId);
            }
            const chosen =
              isAdding || isDecided ? pkg : await options.waiting.choose(pkg);
            if (isClosing) break;
            const current = await options.updates.packageFor(chosen);
            if (isClosing) break;
            install(current, checked, { isAdding });
            const entry = installed.get(appId)!;
            if (adding.includes(appId)) entry.supervision.isAdding = true;
            added.push(entry);
          } catch (error) {
            log(`apps: ${appId} was not installed (${message(error)})`);
          }
        }
        // A core that stops meanwhile keeps what every app brought: those it
        // didn't reach aren't gone.
        if (isClosing) return;
        // What apps that are no longer here brought goes with them, and so
        // does what the core could not check.
        for (const appId of checked) kept.add(appId);
        options.entities.keepApps([...kept]);
      } finally {
        hasInstalled = true;
        // Closing also waits for an install that failed before it finished.
        allInstalled();
      }
      await Promise.all(
        added.map(async (entry) => {
          // The core may have stopped after saving the choice and before this.
          if (entry.off) markDriverOffline(entry);
          if (isOnTrial) waitingForCommit.push(entry);
          else await startApart(entry);
        }),
      );
    },

    // A core update on trial has committed, or there was none, so the apps that
    // run apart start. A rollback restores the core's data but not theirs, so they
    // wait for this. It resolves with every app installed and none waited for, so
    // workflows find their pieces from the first tick and a slow app holds up nothing.
    async committed() {
      await installing;
      if (isClosing) return;
      isOnTrial = false;
      await Promise.all(waitingForCommit.splice(0).map(startApart));
      options.updates.retryCatchUp();
    },

    // Stops a removed app and releases its services, keeping its data.
    // An interrupted removal can leave only its entities and container.
    async remove(appId: string) {
      apartStarts.cancel(appId);
      const entry = installed.get(appId);
      const pending = !entry && removals.get(appId);
      if (pending) return pending;
      if (entry?.origin === "system") {
        throw new ActionCallError("forbidden");
      }
      installed.delete(appId);
      kept.delete(appId);
      options.blobs.removeApp(appId);
      const ended = entry && supervisor.end(entry);
      // Before it yields, so an app installed again waits for its release.
      const release = entry && appServices.removing(appId, entry.services);
      const removing = (async () => {
        try {
          if (entry) {
            // A start or stop already under way still owns its context.
            await entry.lifecycle;
            await ended;
            await uninstall(entry);
            // Removing the container stops whatever the hook couldn't.
            await stopApp(entry, { reason: "removing" }).catch(
              (error: unknown) =>
                log(`apps: ${appId} didn't stop cleanly (${message(error)})`),
            );
            try {
              entry.storage.close();
              await entry.link.close();
            } catch (error) {
              log(`apps: ${appId}'s link didn't close (${message(error)})`);
            }
          }
          options.entities.removeApp(appId);
          await manager.removeAppContainer(appId);
        } finally {
          await release?.();
        }
      })();
      removals.set(appId, removing);
      try {
        await removing;
      } finally {
        if (removals.get(appId) === removing) removals.delete(appId);
      }
    },

    // An installed app's action by its title, for the activity log.
    actionTitle(appId: string, actionId: string): string | null {
      return (
        installed.get(appId)?.contract.actions.get(actionId)?.title ?? null
      );
    },

    /** Whether the apps it started with are installed, so `list` is the home's apps. */
    hasInstalled: () => hasInstalled,

    /** Resolves once the apps it started with are installed. */
    whenInstalled: () => installing,

    /** One installed app as clients list it. */
    info(appId: string): AppInfo | undefined {
      const entry = installed.get(appId);
      return entry
        ? installedInfoOf(entry, options.updates.shownFor(appId))
        : undefined;
    },

    list() {
      return [...installed.values()].map((entry) => ({
        ...installedInfoOf(entry, options.updates.shownFor(entry.manifest.id)),
        origin: entry.origin,
      }));
    },

    /** What going back from its last update would return to, if anything. */
    async goBackOption(appId: string): Promise<AppGoBack | null> {
      const entry = installed.get(appId);
      return entry ? options.updates.goBackOption(entry) : null;
    },

    /** How one is running now in its own container, for its settings page. */
    async running(appId: string): Promise<AppRunning | null> {
      const entry = installed.get(appId);
      if (!entry) return null;
      const usage = await manager.appUsage(appId).catch(() => null);
      return {
        memoryBytes: usage?.memoryBytes ?? null,
        processor: usage?.processor ?? null,
        dataBytes: usage?.dataBytes ?? null,
        restarts: supervisor.restartsOf(entry),
      };
    },

    /** An installed app's static manifest, for its settings page. */
    manifest(appId: string) {
      const entry = installed.get(appId);
      return entry?.manifest;
    },

    call,

    invoke,

    /** Whether an app is installed. */
    has(appId: string) {
      return installed.has(appId);
    },

    /** The folder of the version an installed app runs, which its pages come from, and its name. */
    runningPackage(appId: string) {
      const entry = installed.get(appId);
      return entry
        ? { folder: entry.apartIn, name: entry.manifest.name }
        : null;
    },

    // What an installed app holds, which the workflows it keeps act with.
    holds(appId: string) {
      const entry = installed.get(appId);
      return entry ? { app: appId, granted: [...entry.granted] } : null;
    },

    // The services the drivers that may look for devices are looking for,
    // and handing each what changed (discovered.ts).
    discoveryServices: () => handOut!.services(),
    discoveryChanged: () => {
      lan.sync();
      handOut!.sync();
    },

    /** Whether an app is installed and takes calls now: not paused. */
    isRunning(appId: string) {
      const entry = installed.get(appId);
      return entry ? accepts(entry) : false;
    },

    // Why an app's page may not capture a remote's presses now (presses.ts),
    // or null when it may: it takes calls and reads remotes' buttons.
    captureRefusal(appId: string): ActionCallErrorCode | null {
      const entry = installed.get(appId);
      if (!entry) {
        return "not_found";
      }
      if (!accepts(entry)) {
        return "unavailable";
      }
      return deviceKinds(entry.granted).reads.has("button")
        ? null
        : "forbidden";
    },

    /** Someone's request, for Sanctum's Assistant (requests.ts). */
    ask: requests.ask,
    answersRequests: requests.answers,
    hasRequestRoom: requests.hasRoom,
    forgetRequests: requests.forget,
    stopRequests: requests.close,
    clearRequestWindows: requests.clearWindows,

    /** One of an installed app's actions. */
    action(appId: string, actionId: string) {
      return installed.get(appId)?.contract.actions.get(actionId);
    },

    /** The action of an installed app's that runs its entities of a type. */
    runner(appId: string, typeId: string) {
      const actions = installed.get(appId)?.contract.actions.values() ?? [];
      return [...actions].find((action) => action.runs === typeId);
    },

    /** What each installed app offers AI agents. */
    offers(): AppOffers[] {
      return [...installed.values()].map((entry) => ({
        app: entry.app.id,
        offers: entry.contract.offers,
      }));
    },

    /** The workflow pieces of each installed app. */
    pieces(): AppPieces[] {
      return [...installed.values()].map((entry) => entry.contract.pieces);
    },

    ...choices,

    ...drivers,

    // Which run of a driver app this is, or nothing when it isn't installed. A
    // command never goes again to a later one (devices.ts).
    driverRun(driverId: string) {
      return installed.get(driverId)?.runId;
    },

    // What a driver app that takes calls now declares of its driver, with
    // the run that does, or nothing while none does (devices/asking.ts).
    drivingNow(driverId: string) {
      const entry = installed.get(driverId);
      return entry && accepts(entry) && entry.manifest.driver
        ? { run: entry.runId, driver: entry.manifest.driver }
        : undefined;
    },

    // The event bus's follower that hands running apps what happened to the
    // core's nouns, once it has committed (events-for-apps.ts).
    eventsForApps: eventsForApps.follower,

    // Ends what the core has of every app, then their connections, once an
    // install under way has stopped. Their containers go on: each runner
    // stops its app there as its connection goes, and says hello to the next
    // core, which starts it again in the same container. A host that shuts
    // down stops the containers themselves. Every app's end is tried, even
    // after one fails, and the failures are thrown together.
    async close() {
      isClosing = true;
      await installing;
      handOut?.close();
      lan.close();
      options.updates.close();
      const replacementsEnded = apartStarts.close();
      const entries = [...installed.values()];
      installed.clear();
      const ended = entries.map((entry) => supervisor.end(entry));
      const stopped = await Promise.allSettled(
        entries.map(async (entry, index) => {
          await entry.lifecycle;
          await ended[index];
          await stopApp(entry, { reason: "shutdown", gone: true });
        }),
      );
      const replaced = await Promise.allSettled([replacementsEnded]);
      // A removal may still be touching app state after its caller timed out.
      await Promise.allSettled(removals.values());
      const closed = await Promise.allSettled(
        entries.map(async ({ storage, link }) => {
          try {
            storage.close();
          } finally {
            await link.close();
          }
        }),
      );
      const failures = [...stopped, ...replaced, ...closed].flatMap((each) =>
        each.status === "rejected" ? [message(each.reason)] : [],
      );
      if (failures.length > 0) {
        throw new Error(failures.join("; "));
      }
    },
  };
}

export type AppHost = ReturnType<typeof createAppHost>;
