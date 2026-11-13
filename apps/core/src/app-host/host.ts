import {
  appSectionOrderFrom,
  type Actor,
  type AppGoBack,
  type AppRunning,
  type AppSettings,
  type AppInfo,
  type Job,
  type JobRequest,
  type StaticManifest,
  type WorkflowInfo,
} from "@meetsanctum/app-sdk";
import { coreSocketName } from "@meetsanctum/app-sdk/protocol";
import { join } from "node:path";

import type { Activity } from "../activity/activity.js";
import type { Principal } from "../auth/clients.js";
import type { Devices } from "../devices/devices.js";
import type { Pairing } from "../devices/pairing.js";
import type { Firmware } from "../devices/firmware.js";
import type { Presses } from "../devices/presses.js";
import type { Entities } from "../entities/entities.js";
import type { People } from "../people/people.js";
import type { PlacesModule } from "../places/places.js";
import {
  checkManifest,
  contractOf,
  type AppPieces,
  type DeclaredAction,
} from "./contract.js";
import { createActionRunner, type Who } from "./actions.js";
import { apartApp, apartStorage } from "./apart.js";
import { announcerOf, appStateOf, installedInfoOf } from "./app-info.js";
import { deviceKinds } from "./calls.js";
import { createAppChoices } from "./choices.js";
import type { AppCommits } from "./commits.js";
import type { AppUpdates } from "./updates.js";
import { createAppContexts } from "./contexts.js";
import { createCoreEvents } from "./core-events.js";
import { createDriverCalls } from "./drivers.js";
import { ActionCallError, type ActionCallErrorCode } from "./errors.js";
import type { Gate } from "./gate.js";
import type { AppGrants } from "./grants.js";
import type { InstalledApp } from "./installed.js";
import { createAppLifecycle } from "./lifecycle.js";
import { createAppLink } from "./link.js";
import { createRequestsUnderWay, type NetFetch } from "./net.js";
import {
  createAppServices,
  declaredServices,
  mayRunServices,
  serviceOf,
  servicePermission,
  type ServiceManager,
} from "./services.js";
import type { AppSecrets } from "./secrets.js";
import type { AppSettingsStore } from "./settings.js";
import {
  createSupervisor,
  newSupervision,
  type AppContainerManager,
} from "./supervisor.js";
import type { AppsOff } from "./off.js";
import { createApartStarts } from "./apart-starts.js";

// The app host: installs the apps the core found, gives each its own
// database and the services it declares, starts and stops them
// (lifecycle.ts), runs their actions, hands running apps the core's events
// they follow (core-events.ts) and hands driver apps what Devices asks of
// them (drivers.ts). Every call goes through the permission gate. Every app
// runs apart, in its own container with its own database, and the core knows
// it by its manifest alone, never importing its code (apart.ts). The services it holds
// follow its grants: one switched off loses its broker account before the
// switch shows it off, and one switched back on gets a new login. What an
// app brings to the home stays only while it is installed; its settings,
// which change through the gate too, stay with its database.

// Where the core listens for apps apart, a folder for each app, shared with
// their containers by the manager.
const defaultAppSockets = "/run/sanctum-apps";

// Decided from where a package came from, never from its manifest.
export const origins = ["system", "official", "third-party"] as const;
export type Origin = (typeof origins)[number];

// An app, in its own container, of which the core knows its running version's
// manifest as its folder of packages holds it: never the one bundled in the
// core's image, which can be newer until its update starts.
export type ApartPackage = {
  apart: { manifest: StaticManifest; digest: string; folder: string };
  origin: Origin;
};

type Log = (message: string) => void;

/** An event an app emitted, as the core hands it on. */
export type AppEvent = {
  id: string;
  app: string;
  event: string;
  payload: unknown;
  at: Date;
};

/** Apps' jobs, which the Workflows module keeps. */
export type JobCalls = {
  schedule(appId: string, job: JobRequest): Job;
  cancel(appId: string, key: string): void;
  list(appId: string): Job[];
};

/** The workflows apps keep, which the Workflows module keeps for them. */
export type KeptWorkflowCalls = {
  put(appId: string, workflow: unknown): WorkflowInfo;
  remove(appId: string, key: string): void;
  // Inside a commit's transaction; what it answers runs once that has committed.
  sweep(appId: string, claimed: ReadonlySet<string>): () => void;
  list(appId: string): WorkflowInfo[];
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createAppHost(options: {
  gate: Gate;
  activity: Activity;
  manager: ServiceManager & AppContainerManager;
  people: Pick<People, "list">;
  places: Pick<PlacesModule, "list" | "location">;
  devices: Devices;
  // Where drivers' presses go, and apps' pages' captures of them.
  presses: () => Pick<Presses, "press" | "released" | "endCaptures">;
  // Where what drivers say of firmware goes.
  firmware: () => Pick<Firmware, "report">;
  // Each event an app emits, once it goes out.
  onEvent?: (event: AppEvent) => void;
  jobs?: JobCalls;
  workflows?: KeptWorkflowCalls;
  entities: Entities;
  settings: AppSettingsStore;
  // Apps' own secrets, sealed by the core.
  secrets: AppSecrets;
  grants: AppGrants;
  commits: AppCommits;
  updates: AppUpdates;
  off: AppsOff;
  // Someone changed an app's settings.
  onSettings?: (appId: string, settings: AppSettings) => void;
  // An app's grants changed, or it stopped: as clients list it now.
  onApp?: (app: AppInfo) => void;
  net: NetFetch;
  pairing: () => Pick<Pairing, "joining">;
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
  const coreEvents = createCoreEvents({ timeoutMs, log });
  const appServices = createAppServices({ manager, timeoutMs, log });

  const stateOf = appStateOf;
  // Only while it is still installed: a removal or a new install may have
  // overtaken the change.
  const announceNow = announcerOf(options.onApp, log, ({ manifest }) =>
    options.updates.shownFor(manifest.id),
  );
  const announce = (entry: InstalledApp) =>
    installed.get(entry.app.id) === entry && announceNow(entry);

  // Counts a call under way until it settles.
  function track<T>(entry: InstalledApp, call: Promise<T>): Promise<T> {
    entry.calls.add(call);
    const settled = () => void entry.calls.delete(call);
    call.then(settled, settled);
    return call;
  }

  const contexts = createAppContexts({
    ...options,
    entities: options.entities,
    now,
    isOff: (appId) => installed.get(appId)?.off === true,
  });
  const { settingsOf, contextFor, coreOf, deliver } = contexts;
  // A driver's devices stay paired while it's down. A database failure must
  // neither end the core's timer nor prevent the driver's container stopping.
  function markDriverOffline(entry: InstalledApp) {
    if (!entry.manifest.driver) return;
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
    log,
    now,
    ...options.supervision,
  });
  let isOnTrial = false;
  let installing = Promise.resolve();
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
  const followingOff = new WeakMap<InstalledApp, Promise<void>>();
  async function followOff(entry: InstalledApp) {
    await reconcile(entry);
    if (installed.get(entry.app.id) !== entry) return;
    if (entry.off) {
      markDriverOffline(entry);
      await supervisor.turnedOff(entry);
    } else if (!entry.link.isConnected()) {
      // Back on the connection it never lost, if someone was quick; otherwise it
      // needs a new container, which says when it's ready.
      startApart(entry);
    }
    announce(entry);
  }
  const { accepts, stopApp, reconcile, gone } = createAppLifecycle({
    installed,
    coreEvents,
    contexts,
    people: options.people,
    places: options.places,
    devices: options.devices,
    entities: options.entities,
    presses: options.presses,
    commits: options.commits,
    updates: options.updates,
    supervisor: () => supervisor,
    timeoutMs,
    log,
  });

  // `checked` collects the apps whose entities were checked against their
  // types, which keep them even when the rest of the install fails.
  function install(pkg: ApartPackage, checked: Set<string>) {
    const { origin } = pkg;
    const appId = pkg.apart.manifest.id;
    if (installed.has(appId)) {
      throw new Error("another package has the same id");
    }
    const manifest = checkManifest(pkg.apart.manifest);
    const contract = contractOf(manifest);
    const services = declaredServices(manifest);
    if (services.length > 0 && !mayRunServices.includes(origin)) {
      throw new Error(`a ${origin} app cannot have services`);
    }
    // The first places among a room's sections are Sanctum's own, such as
    // Moods'.
    if (
      origin === "third-party" &&
      manifest.provides.roomSections.some(
        (section) => section.order < appSectionOrderFrom,
      )
    ) {
      throw new Error(
        `a third-party app's room section takes an order from ${appSectionOrderFrom}`,
      );
    }
    // What it brought before is checked against the types it declares now,
    // before its database opens: one that cannot open, as after a failed
    // migration, leaves what it brought, such as a forecast kept offline.
    options.entities.reconcileTypes(appId, contract.entityTypes.values());
    checked.add(appId);
    const link = createAppLink({
      appId,
      version: manifest.version,
      manifest: pkg.apart.digest,
      refuses: () => options.updates.holdsBack(appId, pkg.apart.folder),
      socket: join(
        options.appSockets ?? defaultAppSockets,
        appId,
        coreSocketName,
      ),
      log,
      onReady() {
        const entry = installed.get(appId);
        if (entry) supervisor.ready(entry);
      },
      onGone(_reason, hung) {
        const entry = installed.get(appId);
        if (entry) supervisor.lost(entry, hung);
      },
    });
    const storage = apartStorage(appId);
    const code = apartApp(
      manifest,
      link,
      coreOf,
      (ctx) => contexts.timeLeft(ctx) ?? timeoutMs,
      () => installed.get(appId)?.updating?.id,
    );
    options.grants.adopt(manifest);
    const granted = options.grants.of(manifest);
    const held = (name: string) => granted.includes(servicePermission(name));
    for (const name of services.filter((each) => !held(each))) {
      appServices.releaseOff(appId, name);
    }
    appServices.releaseUndeclared(appId, services);
    installed.set(appId, {
      app: code,
      manifest,
      contract,
      origin,
      granted,
      grantsRevision: 0,
      storage,
      actions: new Map(code.actions.map((each) => [each.id, each])),
      settings: manifest.settings,
      services: new Map(
        services
          .filter(held)
          .map((name) => [name, appServices.request(appId, name)]),
      ),
      calls: new Set(),
      requests: createRequestsUnderWay(appId),
      lifecycle: Promise.resolve(),
      runId: 0,
      off: options.off.isOff(appId),
      link,
      apartIn: pkg.apart.folder,
      digest: pkg.apart.digest,
      supervision: newSupervision(now()),
    });
  }

  const { record, execute } = createActionRunner<InstalledApp>({
    activity,
    timeoutMs,
    log,
    contextFor,
    deliver,
  });
  const choices = createAppChoices({
    installed,
    // It stops, or starts again, after whatever it's doing now. A driver's devices
    // are offline meanwhile, and it says otherwise as it comes back.
    onOff(entry, off) {
      if (entry.off === off) return;
      options.off.set(entry.app.id, off);
      entry.off = off;
      announce(entry);
      // One at a time for an app, each doing what was last asked for: its stop can
      // take seconds, and someone can change their mind while it does.
      const work = (followingOff.get(entry) ?? Promise.resolve())
        .then(() => followOff(entry))
        .catch((error: unknown) => {
          log(
            `apps: ${entry.app.id} didn't follow Turn off (${String(error)})`,
          );
        });
      followingOff.set(entry, work);
    },
    // Only one its supervisor has given up on.
    onRestart(entry) {
      if (entry.supervision.phase !== "failed") return false;
      void supervisor.restart(entry);
      return true;
    },
    onGoBack: (entry, copyId) =>
      options.updates.startGoingBack(entry, copyId).catch((error: unknown) => {
        log(`apps: ${entry.app.id} can't go back (${String(error)})`);
        return false;
      }),
    gate,
    record,
    settings: options.settings,
    settingsOf,
    grants: options.grants,
    coreEvents,
    onSettings: options.onSettings,
    beforeOff(entry, permission) {
      const service = serviceOf(permission);
      return service
        ? appServices.revoke(entry.app.id, entry.services, service)
        : undefined;
    },
    // What it set going under a permission that is off ends, a service
    // switched back on gets a new login, and it pauses, starts or restarts.
    onPermission(entry, permission, granted) {
      const service = serviceOf(permission);
      if (granted && service && mayRunServices.includes(entry.origin)) {
        entry.services.set(service, appServices.request(entry.app.id, service));
      }
      if (!granted) {
        const isPaused = stateOf(entry) === "paused";
        // Ending these cannot wait behind a start hook, which may itself
        // be waiting for one of the requests we must abort.
        if (isPaused) entry.requests.end();
        else entry.requests.revoke(permission);
        if (isPaused || !deviceKinds(entry.granted).reads.has("button")) {
          options.presses().endCaptures(entry.app.id);
        }
      }
      const settled = reconcile(
        entry,
        service ? { restartFor: "its changed services" } : {},
      );
      // One taken away pauses it at once. One given back has it starting
      // at once, which its supervisor announces, and is announced again once
      // it runs, so no client sees it running before it takes calls.
      if (granted) void settled.then(() => announce(entry));
      else announce(entry);
    },
    log,
  });

  function find(appId: string, actionId: string) {
    const entry = installed.get(appId);
    const action = entry?.contract.actions.get(actionId);
    if (!entry || !action) {
      throw new ActionCallError("not_found");
    }
    return { entry, action };
  }

  // Runs an action the gate has admitted, while the app takes calls. A
  // call refused because it does not may have changed something, so it is
  // logged unless it only reads: pages keep reading a paused app.
  async function run(
    entry: InstalledApp,
    action: DeclaredAction,
    actor: Actor,
    who: Who,
    input: unknown,
  ) {
    const deadline = Date.now() + timeoutMs;
    // One on its way back is waited for, within a call's time, rather than fail.
    if (!accepts(entry) && stateOf(entry) !== "paused") {
      await supervisor.arrives(entry, timeoutMs);
    }
    const withinMs = deadline - Date.now();
    if (
      installed.get(entry.app.id) !== entry ||
      !accepts(entry) ||
      withinMs <= 0
    ) {
      if (action.tier !== "read") {
        record(entry.app.id, action.id, who, "refused", "unavailable");
      }
      throw new ActionCallError("unavailable");
    }
    return track(entry, execute(entry, action, actor, who, input, withinMs));
  }

  const drivers = createDriverCalls({
    installed,
    accepts,
    arrives: (entry) =>
      stateOf(entry) === "paused"
        ? Promise.resolve(false)
        : supervisor.arrives(entry, timeoutMs),
    contextFor,
    track,
    timeoutMs,
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
        coming = [],
      }: { onTrial?: boolean; coming?: readonly string[] } = {},
    ) {
      isOnTrial = onTrial;
      for (const appId of coming) kept.add(appId);
      let allInstalled!: () => void;
      installing = new Promise<void>((resolve) => {
        allInstalled = resolve;
      });
      const added: InstalledApp[] = [];
      const checked = new Set<string>();
      for (const pkg of await packages) {
        const appId = pkg.apart.manifest.id;
        try {
          // Its old stop and socket cleanup must finish before a new install
          // binds the same path.
          await removals.get(appId);
          install(await options.updates.packageFor(pkg), checked);
          added.push(installed.get(appId)!);
        } catch (error) {
          log(`apps: ${appId} was not installed (${message(error)})`);
        }
      }
      // What apps that are no longer here brought goes with them, and so
      // does what the core could not check.
      for (const appId of checked) kept.add(appId);
      options.entities.keepApps([...kept]);
      allInstalled();
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
      isOnTrial = false;
      await Promise.all(waitingForCommit.splice(0).map(startApart));
      options.updates.retryCatchUp();
    },

    // Removes an installed app: its actions go, its storage closes and the
    // manager gives up the services it declared, keeping their data. The
    // app's own database file stays. System apps cannot be removed.
    async remove(appId: string) {
      apartStarts.cancel(appId);
      const entry = installed.get(appId);
      if (!entry) {
        return removals.get(appId);
      }
      if (entry.origin === "system") {
        throw new ActionCallError("forbidden");
      }
      installed.delete(appId);
      kept.delete(appId);
      const ended = supervisor.end(entry);
      // Before it yields, so an app installed again waits for its release.
      const release = appServices.removing(appId, entry.services);
      const removing = (async () => {
        try {
          // A pause may already be stopping it, or a resumed start still be
          // running: both own its context until they end.
          await entry.lifecycle;
          await ended;
          await stopApp(entry, { reason: "removing" });
          entry.storage.close();
          await entry.link.close();
          await manager.removeAppContainer(appId).catch((error: unknown) => {
            log(`apps: ${appId}'s container stays (${message(error)})`);
          });
          options.entities.removeApp(appId);
        } finally {
          await release();
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

    // Runs one action for the principal behind a request: the gate admits
    // the caller as an actor first.
    async call(request: {
      principal: Principal;
      appId: string;
      actionId: string;
      input: unknown;
    }): Promise<unknown> {
      const { principal } = request;
      const { entry, action } = find(request.appId, request.actionId);
      const who = {
        personId: principal.person?.id,
        clientId: principal.client.id,
      };
      let actor: Actor;
      try {
        actor = gate.admit(principal, action);
      } catch (error) {
        if (error instanceof ActionCallError) {
          record(entry.app.id, action.id, who, "refused", error.code);
        }
        throw error;
      }
      return run(entry, action, actor, who, request.input);
    },

    // Runs one action for a workflow or for the app itself, as a job does:
    // the gate permits the actor, then the call goes as any other.
    async invoke(request: {
      actor: Actor;
      appId: string;
      actionId: string;
      input: unknown;
    }): Promise<unknown> {
      const { actor } = request;
      const { entry, action } = find(request.appId, request.actionId);
      const who = { actor: `${actor.kind}:${actor.id}` };
      try {
        gate.permit(actor, action);
      } catch (error) {
        if (error instanceof ActionCallError) {
          record(entry.app.id, action.id, who, "refused", error.code);
        }
        throw error;
      }
      return run(entry, action, actor, who, request.input);
    },

    /** Whether an app is installed. */
    has(appId: string) {
      return installed.has(appId);
    },

    // What an installed app holds, which the workflows it keeps act with.
    holds(appId: string) {
      const entry = installed.get(appId);
      return entry ? { app: appId, granted: [...entry.granted] } : null;
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

    /** One of an installed app's actions. */
    action(appId: string, actionId: string) {
      return installed.get(appId)?.contract.actions.get(actionId);
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

    // What happened to the core's nouns, once it has committed, for the
    // running apps that follow it (core-events.ts).
    deviceChanged: coreEvents.device,
    devicePressed: coreEvents.pressed,
    placesChanged: coreEvents.places,
    locationChanged: coreEvents.location,
    personChanged: coreEvents.person,
    entityChanged: coreEvents.entity,

    // Ends what the core has of every app, then their connections. Their
    // containers go on: each runner stops its app there as its connection goes,
    // and says hello to the next core, which starts it again in the same
    // container. A host that shuts down stops the containers themselves.
    async close() {
      options.updates.close();
      const replacementsEnded = apartStarts.close();
      const entries = [...installed.values()];
      installed.clear();
      const ended = entries.map((entry) => supervisor.end(entry));
      await Promise.all(
        entries.map(async (entry, index) => {
          await entry.lifecycle;
          await ended[index];
          await stopApp(entry, { reason: "shutdown", gone: true });
        }),
      );
      await replacementsEnded;
      await Promise.all(
        entries.map(async ({ storage, link }) => {
          storage.close();
          await link.close();
        }),
      );
    },
  };
}

export type AppHost = ReturnType<typeof createAppHost>;
