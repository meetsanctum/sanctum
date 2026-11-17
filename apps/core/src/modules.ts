import { sunTimesSchema, sunType } from "@meetsanctum/app-sdk";

import { createActivity } from "./activity/activity.js";
import {
  createManagerAuditCopy,
  type ManagerAudit,
} from "./activity/manager-audit.js";
import { createActivityViews } from "./activity/views.js";
import { createAppAdding } from "./app-host/adding.js";
import { createAddedApps } from "./app-host/added.js";
import { createAvailableApps } from "./app-host/available.js";
import { createGate } from "./app-host/gate.js";
import type { JobCalls, KeptWorkflowCalls } from "./app-host/app-work.js";
import { createAppHost } from "./app-host/host.js";
import { createNet } from "./app-host/net.js";
import { publicInternet } from "./app-host/public-internet.js";
import type { ServiceManager } from "./app-host/services.js";
import { createAppGrants } from "./app-host/grants.js";
import { createAppsOff } from "./app-host/off.js";
import type { AppContainerManager } from "./app-host/supervisor.js";
import { createAppCommits } from "./app-host/commits.js";
import { loadApartPackage, type ApartPackage } from "./app-host/loader.js";
import { createAppUpdates, type AppUpdateManager } from "./app-host/updates.js";
import { createAppVersions } from "./app-host/versions.js";
import { createAppSecrets } from "./app-host/secrets.js";
import { createAppSettings } from "./app-host/settings.js";
import { createAuth, loginRule } from "./auth/auth.js";
import type { Limits } from "./auth/limits.js";
import { createDashboards } from "./dashboards/dashboards.js";
import type { CoreDatabase } from "./database.js";
import { createDevices } from "./devices/devices.js";
import { createFirmware } from "./devices/firmware.js";
import { createProblems } from "./devices/problems.js";
import { createFound } from "./devices/found.js";
import {
  createSightings,
  type SightingsManager,
} from "./discovery/sightings.js";
import { createHolds } from "./devices/holds.js";
import { createLights } from "./devices/lights.js";
import { createMotion } from "./devices/motion.js";
import { createPairing } from "./devices/pairing.js";
import { createPresses } from "./devices/presses.js";
import { createEntities, type Entities } from "./entities/entities.js";
import { createEventBus } from "./event-bus.js";
import { createHistory } from "./history/history.js";
import type { CoreSteps } from "./lifecycle.js";
import { createLiveUpdates } from "./live-updates.js";
import type { ManagerClient } from "./manager.js";
import { createPages } from "./pages/pages.js";
import { createPeople } from "./people/people.js";
import { createPins } from "./pins/pins.js";
import { createPlaces } from "./places/places.js";
import { createPower, type PowerManager } from "./system/power.js";
import { createRestores } from "./system/restore.js";
import { createSpace, type SpaceManager } from "./system/space.js";
import { createStatus, type StatusManager } from "./system/status.js";
import { createUpdates, type UpdateManager } from "./system/updates.js";
import type { SunDays } from "./workflows/jobs.js";
import { createWorkflows } from "./workflows/workflows.js";

// The core's modules on its database, wired together: People, Auth, System,
// Places, Devices with pairing and the lights of a place together, remotes'
// presses and devices' history, the entities apps bring, the app host with
// its permission gate and apps' settings, Workflows, the home's dashboards
// and pinned apps and the activity log with the manager's audit. What
// happens to devices, presses, places, the home's location, people and
// entities, the motion Motion keeps for each place from them, and the events
// apps emit, goes on the event bus, whose followers are set last
// (event-bus.ts). Clients follow devices, presses, places and
// entities from it, and pairing, settings, dashboards, pinned apps and the
// activity log directly, over Auth's live socket; running apps follow what
// it carries of the core's nouns through the app host.

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
        // What it found on the home's network (discovery/sightings.ts); tests
        // may leave it out.
        discovery?: SightingsManager["discovery"];
        // What it staged for this image; tests may leave it out.
        stagedApps?: ManagerClient["stagedApps"];
      };
    // The apps this core's image ships, once the core has read them.
    shippedApps?: () => readonly string[];
    // Installs and starts an app the household just added, from the package
    // the manager staged for it (core.ts).
    installAdded?: (pkg: ApartPackage) => Promise<void>;
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
    // The kit the core's image carries, which apps' pages import.
    kitDir?: string;
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
  // The app host and Workflows are built after the modules that call them,
  // as Devices and pairing reach driver apps through the host and the host
  // hands apps' jobs to Workflows: those calls run only once both are built.
  const eventBus = createEventBus({ log });
  const activity = createActivity(db, { now });
  const people = createPeople(db, {
    ...loginRule(db),
    record: activity.for("people"),
    onChange(change) {
      // Their clients went with them, so the live connections those had open
      // close first: whatever the removal sets off reaches none of them.
      if (!change.after) auth.connections.closePerson(change.id);
      eventBus.publish({ name: "person.changed", ...change });
    },
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
      appIds: () => apps.list().map((app) => app.id),
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
    onChange: (change) =>
      eventBus.publish({ name: "places.changed", ...change }),
    onLocationChange: (change) =>
      eventBus.publish({ name: "location.changed", ...change }),
    // A room's devices move to No room as it goes, which Devices tells once
    // the removal has committed.
    onRoomRemoving: (roomId) => devices.prepareRoomRemoval(roomId),
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
  const entities = createEntities(db, {
    onChange: (change) =>
      eventBus.publish({ name: "entity.changed", ...change }),
    now,
  });
  const devices = createDevices(db, {
    gate,
    places,
    activity,
    deliver: (driver, command, actor) => apps.deliver(driver, command, actor),
    driverRun: (driver) => apps.driverRun(driver),
    removeFromDriver: (driver, removal, actor, hold) =>
      apps.removeDevice(driver, removal, actor, hold),
    onReport: (id) => firmware.reported(id),
    beforeCommand: (device, capability) => holds.interrupt(device, capability),
    onChange: (change) =>
      eventBus.publish({ name: "device.changed", ...change }),
    confirmMs: options.confirmMs,
    now,
  });
  const history = createHistory(db, {
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
    move: (driver, move, actor) => apps.move(driver, move, actor),
    canMove: (driver) => apps.canMove(driver),
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
  // Each place's motion, kept as it changes.
  const motion = createMotion({
    db,
    devices,
    places,
    onChange: (change) =>
      eventBus.publish({ name: "motion.changed", ...change }),
    now,
  });
  // What drivers say is wrong with their devices, and Repair.
  const problems = createProblems({
    db,
    devices,
    drivers: {
      repair: (driver, repair, actor, hold) =>
        apps.repair(driver, repair, actor, hold),
    },
    record: activity.for("devices"),
  });
  // What drivers found and could add, and adding it, in its turn with
  // repairing and removing the device.
  const found = createFound({
    devices,
    drivers: {
      run: (driver) =>
        apps.isRunning(driver) ? apps.driverRun(driver) : undefined,
      add: (driver, add, actor, hold) => apps.add(driver, add, actor, hold),
    },
    record: activity.for("devices"),
    onChange: () => pairing.refresh(),
  });
  const firmware = createFirmware({
    db,
    devices,
    drivers: {
      firmware: (driver, hook, device, actor) =>
        apps.firmware(driver, hook, device, actor),
      probe: (driver, device, actor) => apps.probe(driver, device, actor),
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
    onPress: (press) => eventBus.publish({ name: "device.pressed", ...press }),
    onRelease: ({ device, capability }) => holds.released(device, capability),
    captureRefusal: (appId) => apps.captureRefusal(appId),
    now,
  });
  const pairing = createPairing({
    drivers: {
      list: () => apps.pairingDrivers(),
      open: (driver, seconds, actor) =>
        apps.openPairing(driver, seconds, actor),
      close: (driver, actor) => apps.closePairing(driver, actor),
    },
    deviceId: (driver, key) => devices.idFor(driver, key),
    found: () => found.list(),
    record: activity.for("devices"),
    onChange: live.pairing,
    log,
    now,
  });
  const appJobs: JobCalls = {
    schedule: (app, job) => workflows.jobs.schedule(app, job),
    cancel: (app, key) => workflows.jobs.cancel(app, key),
    list: (app) => workflows.jobs.list(app),
  };
  const keptWorkflows: KeptWorkflowCalls = {
    put: (app, workflow) => workflows.kept.put(app, workflow),
    remove: (app, key) => workflows.kept.remove(app, key),
    sweep: (app, claimed) => workflows.kept.sweep(app, claimed),
    list: (app) => workflows.kept.list(app),
  };
  const appVersions = createAppVersions(db, { now });
  const addedApps = createAddedApps(db, { now });
  const appSettingsStore = createAppSettings(db, { now });
  const appUpdates = createAppUpdates({
    db,
    dataDir: options.dataDir,
    versions: appVersions,
    settings: appSettingsStore,
    manager: options.manager,
    activity,
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
    onEvent: (event) => eventBus.publish({ name: "app.emitted", ...event }),
    jobs: appJobs,
    workflows: keptWorkflows,
    pairing: () => pairing,
    firmware: () => firmware,
    problems: () => problems,
    found: () => found,
    entities,
    settings: appSettingsStore,
    secrets: createAppSecrets(db, { dataDir: options.dataDir, log, now }),
    sightings: () => sightings?.list() ?? [],
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
    onApp(app) {
      live.app(app);
      // A driver that starts or stops lets devices join, or lists what it
      // found, or no longer does.
      pairing.refresh();
    },
    net: createNet(options.fetch ?? publicInternet()),
    log,
    timeoutMs: options.appTimeoutMs,
    appSockets: options.appSockets,
    supervision: options.supervision,
    now,
  });
  // What the manager finds on the home's network for the drivers that look
  // for it, which they hear of as it changes.
  const lookFor = options.manager.discovery;
  const sightings = lookFor
    ? createSightings({
        manager: {
          capabilities: () => options.manager.capabilities(),
          discovery: (after, services) => lookFor(after, services),
        },
        services: () => apps.discoveryServices(),
        onChange: () => apps.discoveryChanged(),
        log,
      })
    : undefined;
  // Apps' pages and the kit, for the frames the shell shows them in.
  const pages = createPages(db, {
    packagesDir: options.packagesDir ?? "/packages",
    kitDir: options.kitDir ?? "/app/kit",
    runningPackage: (appId) => apps.runningPackage(appId),
    now: now ?? (() => new Date()),
    log,
  });
  // What the image ships that the household hasn't added, asked of the
  // manager briefly, since a client waits for the answer.
  const availableApps = createAvailableApps({
    shipped: options.shippedApps ?? (() => []),
    added: addedApps,
    staged: async () => (await options.manager.stagedApps?.(5_000)) ?? {},
    loadPackage: (appId, folder) =>
      loadApartPackage(
        options.packagesDir ?? "/packages",
        appId,
        folder,
        "official",
      ),
    pagesNeedIn: (appId, folder) => pages.pagesNeedIn(appId, folder),
    host: () => options.manager.hostStatus(),
    log,
  });
  const appAdding = createAppAdding({
    gate,
    available: availableApps,
    added: addedApps,
    activity,
    hasInstalled: () => apps.hasInstalled(),
    install: async (pkg) => {
      if (!options.installAdded) throw new Error("this core installs no app");
      await options.installAdded(pkg);
    },
    info: (appId) => apps.info(appId),
    log,
  });
  const workflows = createWorkflows(db, {
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
    // An app that's gone by the name its entries kept.
    app: (id) =>
      apps.list().find((app) => app.id === id)?.name ?? activity.nameThen(id),
    action: (app, id) => apps.actionTitle(app, id),
    workflow: (id) => workflows.brief(id),
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
  // Set last, once every follower is built, in this order. Each handler
  // calls through, so a test that replaces a module's method still reaches
  // it.
  eventBus.setFollowers([
    ["holds", { "device.pressed": (press) => holds.pressed(press) }],
    [
      "live updates",
      {
        "device.changed": (change) => live.device(change),
        "device.pressed": (press) => live.press(press),
        "places.changed": ({ after }) => live.places(after),
        "entity.changed": (change) => live.entity(change),
      },
    ],
    ["events for apps", apps.eventsForApps],
    [
      "pairing",
      {
        "device.changed"({ id, before, after }) {
          if (after === null) pairing.removed(id);
          // A device added or removed leaves or rejoins what was found.
          if (before === null || after === null) pairing.refresh();
        },
      },
    ],
    // Devices named after their room follow it.
    ["device names", { "places.changed": () => devices.renameAll() }],
    // Before workflows, which follow what it makes of a place's sensors.
    ["motion", motion.follower],
    [
      "workflows",
      {
        "device.changed": (change) => workflows.deviceChanged(change),
        // Not one a capture holds.
        "device.pressed"(press) {
          if (!press.isCaptured) workflows.pressed(press);
        },
        "entity.changed": (change) => workflows.entityChanged(change),
        "app.emitted": (event) => workflows.appEvent(event),
        "motion.changed": (change) => workflows.motionChanged(change),
      },
    ],
    [
      "dashboards",
      { "device.changed": (change) => dashboards.deviceChanged(change) },
    ],
    [
      "history",
      { "device.changed": (change) => history.deviceChanged(change) },
    ],
  ]);

  // No workflow run starts once the core is stopping.
  const stopNewWork = [
    ["workflows", () => workflows.interrupt()],
  ] as const satisfies CoreSteps["stopNewWork"];
  // Nothing goes to a device again while the apps stop. Devices' and
  // firmware's deadlines are the last that change a device, so the bus closes
  // after them, and history then records that nothing is known from then on.
  const stoppingSteps = [
    ["stop discovery", () => sightings?.close()],
    ["stop the manager's audit", () => managerAudit?.close()],
    ["stop commands to devices", () => devices.closing()],
    ["stop workflows", () => workflows.close()],
    ["stop holds", () => holds.close()],
    ["stop the app host", () => apps.close()],
    ["stop devices", () => devices.close()],
    ["stop firmware", () => firmware.close()],
    ["close the bus", () => eventBus.close()],
    ["stop history", () => history.close()],
    ["stop pairing", () => pairing.stop()],
  ] as const satisfies CoreSteps["stopping"];
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
    problems,
    found,
    entities,
    apps,
    addedApps,
    availableApps,
    appAdding,
    pages,
    workflows,
    history,
    // What the manager finds on the home's network, which starts with the
    // core (core.ts); none under a manager that can't look.
    discovery: sightings,
    // At stopping's first moment, before anything is awaited (lifecycle.ts).
    stopNewWork,
    // The modules' steps of stopping, in order (lifecycle.ts).
    stoppingSteps,
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
