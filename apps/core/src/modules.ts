import { sunTimesSchema, sunType } from "@meetsanctum/app-sdk";

import { createActivity } from "./activity/activity.js";
import {
  createManagerAuditCopy,
  type ManagerAudit,
} from "./activity/manager-audit.js";
import { createActivityViews } from "./activity/views.js";
import { createGate } from "./app-host/gate.js";
import {
  createAppHost,
  type AppHost,
  type JobCalls,
  type KeptWorkflowCalls,
} from "./app-host/host.js";
import { createNet } from "./app-host/net.js";
import { publicInternet } from "./app-host/public-internet.js";
import type { ServiceManager } from "./app-host/services.js";
import { createAppGrants } from "./app-host/grants.js";
import { createAppsOff } from "./app-host/off.js";
import type { AppContainerManager } from "./app-host/supervisor.js";
import { createAppCommits } from "./app-host/commits.js";
import { loadApartPackage } from "./app-host/loader.js";
import { createAppUpdates, type AppUpdateManager } from "./app-host/updates.js";
import { createAppVersions } from "./app-host/versions.js";
import { createAppSettings } from "./app-host/settings.js";
import { createAuth, loginRule } from "./auth/auth.js";
import type { Limits } from "./auth/limits.js";
import { createDashboards } from "./dashboards/dashboards.js";
import type { CoreDatabase } from "./database.js";
import { createDevices, type DeviceChange } from "./devices/devices.js";
import { createFirmware } from "./devices/firmware.js";
import { createHolds } from "./devices/holds.js";
import { createLights } from "./devices/lights.js";
import { createMotion } from "./devices/motion.js";
import { createPairing } from "./devices/pairing.js";
import { createPresses } from "./devices/presses.js";
import { createEntities, type Entities } from "./entities/entities.js";
import { createHistory, type History } from "./history/history.js";
import { createLiveUpdates } from "./live-updates.js";
import { createPeople } from "./people/people.js";
import { createPins } from "./pins/pins.js";
import { createPlaces } from "./places/places.js";
import { createPower, type PowerManager } from "./system/power.js";
import { createRestores } from "./system/restore.js";
import { createSpace, type SpaceManager } from "./system/space.js";
import { createStatus, type StatusManager } from "./system/status.js";
import { createUpdates, type UpdateManager } from "./system/updates.js";
import type { SunDays } from "./workflows/jobs.js";
import { createWorkflows, type Workflows } from "./workflows/workflows.js";

// The core's modules on its database, wired together: People, Auth, System,
// Places, Devices with pairing and the lights of a place together, remotes'
// presses and devices' history, the entities apps bring, the app host with
// its permission gate and apps' settings, Workflows, the home's dashboards
// and pinned apps and the activity log with the manager's audit. Clients
// follow devices, presses, places, pairing, entities, settings, dashboards,
// pinned apps and the activity log over Auth's live socket; running apps
// follow devices, presses, places, people and entities through the host.

export async function createModules(
  db: CoreDatabase,
  options: {
    dataDir: string;
    // The core's own version.
    version: string;
    manager: ServiceManager &
      AppContainerManager &
      AppUpdateManager &
      UpdateManager &
      StatusManager &
      PowerManager &
      SpaceManager & {
        // The manager's audit after an entry (activity/manager-audit.ts);
        // tests may leave it out.
        audit?: (after: number) => Promise<ManagerAudit>;
      };
    // The host's id, which the manager keeps.
    hostId: () => string | undefined;
    // The home's id, which this database keeps (loadHomeId).
    homeId: string;
    // The pin of the host CA the core serves; none over plain HTTP.
    pin?: () => string | null;
    // Called once the claim has committed.
    onClaimed?: () => void;
    log: (message: string) => void;
    // How the core reaches the internet, for the location suggestion and
    // apps' ctx.net.fetch(); tests give one that refuses.
    fetch?: typeof fetch;
    limits?: Limits;
    now?: () => Date;
    appTimeoutMs?: number;
    appSockets?: string;
    // Where the manager stages apps' versions, which an update may go back to.
    packagesDir?: string;
    // For tests: how soon an update asks for its turn again, and its versions.
    appUpdates?: {
      turnPauseMs?: number;
      catchUpPauseMs?: number;
      retryAfterMs?: number;
      loadPackage?: Parameters<typeof createAppUpdates>[0]["loadPackage"];
    };
    supervision?: Parameters<typeof createAppHost>[0]["supervision"];
    // How long an update under way may say nothing, and how long Check
    // connection waits for a device (devices/firmware.ts).
    firmwareStaleMs?: number;
    probeWaitMs?: number;
    confirmMs?: number;
    // How long a remote's hold dims at most without its release, and how
    // long a light it stopped has to say where it got to (holds.ts).
    holdLimitMs?: number;
    holdSettleMs?: number;
    // For tests: the home's time zone and sun times, which otherwise come
    // from Places and from the app that provides the sun.
    timeZone?: () => string | null;
    sun?: () => SunDays | null;
  },
) {
  const { now, log } = options;
  // Devices and pairing hand driver apps what they ask through the app
  // host, which in turn gives apps their calls into Devices and the core's
  // events. Workflows run apps' actions through the host, which hands them
  // apps' events and jobs.
  let host: AppHost | undefined;
  let workflows: Workflows | undefined;
  let history: History | undefined;
  const activity = createActivity(db, { now });
  const people = createPeople(db, {
    ...loginRule(db),
    record: activity.for("people"),
    onChange: (change) => host?.personChanged(change),
  });
  const auth = await createAuth(db, {
    people,
    hostId: options.hostId,
    homeId: options.homeId,
    pin: options.pin,
    onClaimed: options.onClaimed,
    limits: options.limits,
    now,
  });
  // A restore from a backup signs every device out before the core serves
  // anyone.
  const record = activity.for("system");
  const restores = createRestores(db, {
    dataDir: options.dataDir,
    signOutEveryone: auth.signOutEveryone,
    record,
    log,
    now: now ?? (() => new Date()),
  });
  restores.applyMarker();
  const system = {
    restores,
    updates: createUpdates({
      manager: options.manager,
      version: options.version,
      record,
    }),
    // The host's status, and the space each installed app's data takes.
    status: createStatus({
      manager: options.manager,
      dataDir: options.dataDir,
      version: options.version,
      appIds: () => host?.list().map((app) => app.id) ?? [],
      now,
    }),
    // Restart and Shut down, which every client hears of first.
    power: createPower({
      manager: options.manager,
      record,
      announce: (going) => live.system(going),
    }),
    space: createSpace({ manager: options.manager, record }),
    record,
  };
  const gate = createGate(people);
  const live = createLiveUpdates(auth.connections, gate);
  const places = createPlaces(db, {
    record: activity.for("places"),
    timeZone: options.timeZone,
    // Devices named after their room follow it.
    onChange(list, before) {
      live.places(list);
      host?.placesChanged(before, list);
      devices.renameAll();
    },
    onLocationChange: (before, after) => host?.locationChanged(before, after),
    onRoomRemoving(roomId) {
      const affected = devices
        .list()
        .filter((device) => device.roomId === roomId);
      return () => {
        for (const before of affected) {
          const change = {
            id: before.id,
            before,
            after: devices.get(before.id),
          };
          live.device(change);
          host?.deviceChanged(change);
          updateHome(change);
        }
      };
    },
    fetch: options.fetch,
    log,
    now,
  });
  const dashboards = createDashboards(db, {
    record: activity.for("dashboards"),
    onChange: live.dashboards,
    now,
  });
  const pins = createPins(db, { onChange: live.pins });
  function updateHome(change: DeviceChange) {
    try {
      dashboards.deviceChanged(change);
    } catch (error) {
      log(
        `dashboards: a change of ${change.id} did not reach Home (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  // Workflows follow changes once they have committed; one that fails on a
  // change must not fail the caller that made it.
  const following = (what: string, follow: () => void) => {
    try {
      follow();
    } catch (error) {
      log(
        `workflows: a change of ${what} was not handled (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };
  const entities = createEntities(db, {
    onChange(change) {
      live.entity(change);
      host?.entityChanged(change);
      following(`${change.app}'s ${change.key}`, () =>
        workflows?.entityChanged(change),
      );
    },
    now,
  });
  const devices = createDevices(db, {
    gate,
    places,
    activity,
    deliver: (driver, command, actor) => host!.deliver(driver, command, actor),
    driverRun: (driver) => host!.driverRun(driver),
    removeFromDriver: (driver, removal, actor) =>
      host!.removeDevice(driver, removal, actor),
    onReport: (id) => firmware.reported(id),
    beforeCommand: (device, capability) => holds.interrupt(device, capability),
    onChange(change) {
      live.device(change);
      host?.deviceChanged(change);
      if (change.after === null) pairing.removed(change.id);
      following(change.id, () => workflows?.deviceChanged(change));
      updateHome(change);
      try {
        history?.deviceChanged(change);
      } catch (error) {
        log(
          `history: a change of ${change.id} was not recorded (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    },
    confirmMs: options.confirmMs,
    now,
  });
  history = createHistory(db, {
    devices,
    record: activity.for("history"),
    log,
    now,
  });
  // A remote's held button brightening or dimming lights, through each
  // light's driver.
  const holds = createHolds({
    devices,
    gate,
    move: (driver, move, actor) => host!.move(driver, move, actor),
    canMove: (driver) => host?.canMove(driver) ?? false,
    record: activity.for("devices"),
    limitMs: options.holdLimitMs,
    settleMs: options.holdSettleMs,
    now,
  });
  const lights = createLights({
    devices,
    places,
    gate,
    entities,
    holds,
    now,
  });
  const motion = createMotion({ devices, places });
  const firmware = createFirmware({
    db,
    devices,
    drivers: {
      firmware: (driver, hook, device, actor) =>
        host!.firmware(driver, hook, device, actor),
      probe: (driver, device, actor) => host!.probe(driver, device, actor),
    },
    record: activity.for("devices"),
    now,
    staleMs: options.firmwareStaleMs,
    probeWaitMs: options.probeWaitMs,
  });
  // A press reaches live clients, where a capture waits for it, and
  // otherwise running apps and workflows too.
  const presses = createPresses({
    devices,
    activity,
    onPress(press) {
      holds.pressed(press);
      live.press(press);
      if (press.isCaptured) return;
      host?.devicePressed(press);
      following(`${press.device.id}'s press`, () => workflows?.pressed(press));
    },
    onRelease: ({ device, capability }) => holds.released(device, capability),
    captureRefusal: (appId) =>
      host ? host.captureRefusal(appId) : "unavailable",
    now,
  });
  const pairing = createPairing({
    drivers: {
      list: () => host!.pairingDrivers(),
      open: (driver, seconds, actor) =>
        host!.openPairing(driver, seconds, actor),
      close: (driver, actor) => host!.closePairing(driver, actor),
    },
    deviceId: (driver, key) => devices.idFor(driver, key),
    record: activity.for("devices"),
    onChange: live.pairing,
    log,
    now,
  });
  const appJobs: JobCalls = {
    schedule: (app, job) => workflows!.jobs.schedule(app, job),
    cancel: (app, key) => workflows!.jobs.cancel(app, key),
    list: (app) => workflows!.jobs.list(app),
  };
  const keptWorkflows: KeptWorkflowCalls = {
    put: (app, workflow) => workflows!.kept.put(app, workflow),
    remove: (app, key) => workflows!.kept.remove(app, key),
    sweep: (app, claimed) => workflows!.kept.sweep(app, claimed),
    list: (app) => workflows!.kept.list(app),
  };
  const appVersions = createAppVersions(db, { now });
  const appSettingsStore = createAppSettings(db, { now });
  const appUpdates = createAppUpdates({
    db,
    dataDir: options.dataDir,
    versions: appVersions,
    settings: appSettingsStore,
    manager: options.manager,
    log,
    now: () => now?.() ?? new Date(),
    ...options.appUpdates,
    loadPackage:
      options.appUpdates?.loadPackage ??
      ((appId, folder) =>
        loadApartPackage(
          options.packagesDir ?? "/packages",
          appId,
          folder,
          "official",
        )),
  });
  const apps = createAppHost({
    gate,
    activity,
    manager: options.manager,
    people,
    places,
    devices,
    presses: () => presses,
    onEvent: (event) => workflows?.appEvent(event),
    jobs: appJobs,
    workflows: keptWorkflows,
    pairing: () => pairing,
    firmware: () => firmware,
    entities,
    settings: appSettingsStore,
    updates: appUpdates,
    grants: createAppGrants(db, { now }),
    commits: createAppCommits({
      db,
      versions: appVersions,
      updates: appUpdates,
      entities,
      jobs: appJobs,
      workflows: keptWorkflows,
    }),
    off: createAppsOff(db, { now }),
    onSettings: live.settings,
    onApp: live.app,
    net: createNet(options.fetch ?? publicInternet()),
    log,
    timeoutMs: options.appTimeoutMs,
    appSockets: options.appSockets,
    supervision: options.supervision,
    now,
  });
  host = apps;
  workflows = createWorkflows(db, {
    host: apps,
    devices,
    places,
    lights,
    motion,
    entities,
    record: activity.for("workflows"),
    activity,
    log,
    now,
    // The home's time zone, which Places keeps, and its sunrises and
    // sunsets from whichever app provides the standard sun entity.
    timeZone: options.timeZone ?? (() => places.timeZone()),
    sun: options.sun ?? (() => sunDays(entities)),
  });
  // Each entry by its names now; a shared client's entries keep its name
  // then. Live clients hear of an entry once it has committed, and of what
  // led to it again, since what a press or run led to grew.
  activity.nameClients((id) => auth.clients.name(id) ?? undefined);
  const activityViews = createActivityViews(activity, {
    person: (id) => people.list().find((person) => person.id === id) ?? null,
    client: (id) => auth.clients.name(id),
    app: (id) => apps.list().find((app) => app.id === id)?.name ?? null,
    action: (app, id) => apps.actionTitle(app, id),
    workflow: (id) => workflows!.brief(id),
    device: (id) => devices.get(id)?.name ?? null,
    room: (id) =>
      places.list().rooms.find((room) => room.id === id)?.name ?? null,
    floor: (id) =>
      places.list().floors.find((floor) => floor.id === id)?.name ?? null,
    dashboard: (id) =>
      dashboards.list().find((dashboard) => dashboard.id === id)?.name ?? null,
  });
  activity.follow((entry) => {
    if (entry.action === "sanctum.stop") return;
    try {
      for (const each of [entry, ...activityViews.causesOf(entry)]) {
        live.activity(activityViews.info(each));
      }
    } catch (error) {
      log(
        `activity: an entry did not reach live clients (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  });
  const audit = options.manager.audit;
  const managerAudit = audit
    ? createManagerAuditCopy({ db, activity, audit, log })
    : undefined;

  return {
    activity,
    activityViews,
    managerAudit,
    people,
    auth,
    system,
    gate,
    places,
    dashboards,
    pins,
    devices,
    lights,
    holds,
    pairing,
    presses,
    firmware,
    entities,
    apps,
    workflows,
    history,
    // Stops the timers, the apps, then history, which records that nothing
    // is known from then on, and the timers waiting for devices. Nothing
    // goes to a device again while the apps stop.
    async close() {
      managerAudit?.close();
      devices.closing();
      workflows!.close();
      await holds.close();
      await apps.close();
      history!.close();
      devices.close();
      firmware.close();
      pairing.stop();
    },
  };
}

export type Modules = Awaited<ReturnType<typeof createModules>>;

// The days of the home's sun, from the first app that provides it; none
// while no app does.
function sunDays(entities: Pick<Entities, "list">): SunDays | null {
  const [sun] = entities.list({ type: sunType.id });
  const state = sunTimesSchema.safeParse(sun?.state);
  return state.success ? state.data.days : null;
}
