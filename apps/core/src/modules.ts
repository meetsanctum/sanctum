import {
  announcePermission,
  answersTo,
  modelsUsePermission,
  shownQuestions,
  sunTimesSchema,
  sunType,
} from "@meetsanctum/app-sdk";

import { createActivity } from "./activity/activity.js";
import {
  createManagerAuditCopy,
  type ManagerAudit,
} from "./activity/manager-audit.js";
import { createActivityViews } from "./activity/views.js";
import { assembleAgentTools, createAgentAccess } from "./agents/assembly.js";
import type { AgentCommandLimits } from "./agents/limits.js";
import type { AgentTools } from "./agents/tools.js";
import { createBlobs } from "./blobs/blobs.js";
import { createRemovedApps } from "./app-host/removed.js";
import { createAddedApps } from "./app-host/added.js";
import { createAppList } from "./app-host/app-list.js";
import { ActionCallError } from "./app-host/errors.js";
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
import { createRoomWaits, updateRoom } from "./app-host/room-waits.js";
import { createWaitingUpdates } from "./app-host/waiting.js";
import { createAppUpdates, type AppUpdateManager } from "./app-host/updates.js";
import { createAppVersions } from "./app-host/versions.js";
import { createAppSecrets, createSealer } from "./app-host/secrets.js";
import { createAppSettings } from "./app-host/settings.js";
import { createAuth, loginRule } from "./auth/auth.js";
import { assembleSpeech } from "./speech/assembly.js";
import { createListening } from "./speech/listening.js";
import type { Limits } from "./auth/limits.js";
import { setCoreFollowers } from "./core-followers.js";
import { createDashboards } from "./dashboards/dashboards.js";
import type { CoreDatabase } from "./database.js";
import { createDevices } from "./devices/devices.js";
import { createFirmware } from "./devices/firmware.js";
import { createAsking } from "./devices/asking.js";
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
import { createModels } from "./models/models.js";
import { createTurns } from "./models/turns.js";
import type { ModelFetchers } from "./models/endpoints.js";
import { createLiveUpdates } from "./live-updates.js";
import type { ManagerClient } from "./manager.js";
import { createPages } from "./pages/pages.js";
import { createPeople } from "./people/people.js";
import { createPins } from "./pins/pins.js";
import { createPlaces } from "./places/places.js";
import { assembleSystem, type SystemManager } from "./system/assembly.js";
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
      SystemManager &
      Pick<ManagerClient, "hostResources" | "serviceUrl"> & {
        // The manager's audit after an entry (activity/manager-audit.ts);
        // tests may leave it out.
        audit?: (after: number) => Promise<ManagerAudit>;
        // What it found on the home's network (discovery/sightings.ts); tests
        // may leave it out.
        discovery?: SightingsManager["discovery"];
        // Deleting a removed app's data, and a service's (deleting.ts); tests
        // may leave them out.
        deleteAppData?: ManagerClient["deleteAppData"];
        eraseServiceData?: ManagerClient["eraseServiceData"];
        // The Zigbee sticks plugged in (hardware-offers.ts); tests may leave
        // it out.
        zigbeeSticks?: ManagerClient["zigbeeSticks"];
        // What it staged for this image; tests may leave it out.
        stagedApps?: ManagerClient["stagedApps"];
        // What's left for another app, and holding what an add needs
        // (adding.ts); tests may leave them out.
        appCapacity?: ManagerClient["appCapacity"];
        reserveForApp?: ManagerClient["reserveForApp"];
        releaseAppReservation?: ManagerClient["releaseAppReservation"];
        // Running the speech service for the core itself (speech/speech.ts);
        // tests may leave them out.
        wantServiceForCore?: ManagerClient["wantServiceForCore"];
        releaseServiceForCore?: ManagerClient["releaseServiceForCore"];
      };
    // Where smart speakers fetch announcements; none, and nothing is said
    // out loud, in a core that doesn't listen.
    speaker?: { host: string; port: number; publishedPort: number };
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
    // For tests: how many device commands AI agents may send a minute.
    agentCommandLimits?: AgentCommandLimits;
    // For tests: the home's time zone and sun times, which otherwise come
    // from Places and from the app that provides the sun.
    timeZone?: () => string | null;
    sun?: () => SunDays | null;
    // For tests: how the core reaches AI models in the home and on the
    // internet.
    modelFetchers?: ModelFetchers;
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
  const system = assembleSystem(db, {
    manager: options.manager,
    dataDir: options.dataDir,
    version: options.version,
    record: activity.for("system"),
    signOutEveryone: auth.signOutEveryone,
    appIds: () => apps.list().map((app) => app.id),
    announce: (going) => live.system(going),
    log,
    now,
  });
  const agentAccess = createAgentAccess(db, {
    activity,
    auth,
    apps: () => apps,
    tools: () => agentTools,
    commandLimits: options.agentCommandLimits,
    onAreaChanged: () => speech?.areaChanged(),
    now,
  });
  const { canUse: agentsCanUse, checkAgentCommand } = agentAccess;
  const gate = createGate(people, agentAccess.isActive, agentsCanUse.areaOn);
  const live = createLiveUpdates(auth.connections, gate);
  const places = createPlaces(db, {
    record: activity.for("places"),
    timeZone: options.timeZone,
    onChange: (change) =>
      eventBus.publish({ name: "places.changed", ...change }),
    onLocationChange: (change) =>
      eventBus.publish({ name: "location.changed", ...change }),
    onTimeZoneChange: (at, previousZone) =>
      workflows.followTimeZone(at, previousZone),
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
  // The apps the household removed, whose devices are hidden meanwhile.
  const removedApps = createRemovedApps(db, { now });
  const devices = createDevices(db, {
    gate,
    places,
    activity,
    hiddenDrivers: () => removedApps.ids(),
    deliver: (driver, command, actor) => apps.deliver(driver, command, actor),
    driverRun: (driver) => apps.driverRun(driver),
    removeFromDriver: (driver, removal, actor, hold) =>
      apps.removeDevice(driver, removal, actor, hold),
    endAsking: (device, actor, hold) =>
      asking.endWithin(device, "removed", actor, hold),
    onReport: (id) => firmware.reported(id),
    beforeCommand(device, capability, actor, shouldLeaveMoving) {
      if (holds.isMoving(device, capability)) {
        // Restoring must leave a remote's ongoing changes alone, as must a
        // command already over the agent's limit.
        if (shouldLeaveMoving) throw new ActionCallError("conflict");
        if (actor.kind === "assistant-run") checkAgentCommand(actor.id, false);
      }
      return holds.interrupt(device, capability);
    },
    agentCommand: checkAgentCommand,
    onChange: (change) =>
      eventBus.publish({ name: "device.changed", ...change }),
    confirmMs: options.confirmMs,
    now,
  });
  // Adding and repairing that ask once started: the attempts open while the
  // person reads a code off the device.
  const asking = createAsking({ turns: devices.turns, answersTo, now });
  // Repair can be requested while the installed driver is coming back.
  const laterOf = (driver: string, problem?: string) => {
    const declared =
      problem === undefined
        ? apps.drivingNow(driver)?.driver
        : apps.manifest(driver)?.driver;
    const later =
      problem === undefined
        ? declared?.addLater
        : Object.hasOwn(declared?.problems ?? {}, problem)
          ? declared!.problems![problem]!.repair?.later
          : undefined;
    return shownQuestions(declared, later ?? []);
  };
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
    checkAgentCommand,
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
      run: (driver) =>
        apps.isRunning(driver) ? apps.driverRun(driver) : undefined,
      repair: (driver, repair, actor, hold, withinMs, run) =>
        apps.repair(driver, repair, actor, hold, withinMs, run),
      cancelRepair: (driver, cancel, actor, hold, run) =>
        apps.cancelRepair(driver, cancel, actor, hold, run),
      laterOf: (driver, problem) => laterOf(driver, problem),
    },
    asking,
    record: activity.for("devices"),
  });
  // What drivers found and could add, and adding it, in its turn with
  // repairing and removing the device.
  const found = createFound({
    devices,
    drivers: {
      run: (driver) =>
        apps.isRunning(driver) ? apps.driverRun(driver) : undefined,
      add: (driver, add, actor, hold, withinMs, run) =>
        apps.add(driver, add, actor, hold, withinMs, run),
      cancelAdd: (driver, cancel, actor, hold, run) =>
        apps.cancelAdd(driver, cancel, actor, hold, run),
      laterOf: (driver) => laterOf(driver),
    },
    asking,
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
      identify: (driver, device, actor) => apps.identify(driver, device, actor),
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
      finders: () => apps.findingDrivers(),
      open: (driver, seconds, actor) =>
        apps.openPairing(driver, seconds, actor),
      close: (driver, actor) => apps.closePairing(driver, actor),
    },
    deviceId: (driver, key) => devices.idFor(driver, key),
    found: () => found.list(),
    offers: () => deviceOffers.list(),
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
  // A version staged in its folder, as the core reads any app that runs apart.
  const loadStagedPackage = (appId: string, folder: string) =>
    loadApartPackage(options.packagesDir ?? "/packages", appId, folder);
  const loadPackage = options.appUpdates?.loadPackage ?? loadStagedPackage;
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
    loadPackage,
    holds: (pkg) => waitingUpdates.holds(pkg),
  });
  const grantsStore = createAppGrants(db, { now });
  const appsOff = createAppsOff(db, { now });
  // An update that needs what nobody has allowed waits for someone to.
  const waitingUpdates = createWaitingUpdates({
    db,
    versions: appVersions,
    grants: grantsStore,
    loadPackage,
    off: appsOff,
    room: updateRoom({ manager: options.manager, grants: grantsStore, log }),
    log,
    now,
  });
  // Pictures drivers hand over, in memory only (blobs/blobs.ts).
  const blobs = createBlobs({ now, log });
  // Smart speakers' runs, which their drivers open as they hear their wake
  // word (speech/listening.ts).
  const listening = createListening({
    idFor: (driver, key) => devices.idFor(driver, key),
    listens: (id) =>
      devices
        .get(id)
        ?.capabilities.some(
          (part) => part.kind === "audio" && part.features.listens,
        ) ?? false,
    hearer: () => null,
    log,
  });
  // The home's AI models, which the household adds in Settings, and the
  // turns in which apps ask the one in use.
  const models = createModels(db, {
    sealer: createSealer(options.dataDir),
    fetchers: options.modelFetchers ?? {
      home: fetch,
      internet: publicInternet(),
    },
    record: activity.for("models"),
    dayOf: (date) => places.clock().date(date),
    appsUsing: () =>
      apps
        .list()
        .filter((app) => app.permissions.includes(modelsUsePermission)),
    // Ollama on Sanctum, at the address the manager gives while it runs.
    sanctumUrl: () => options.manager.serviceUrl("ollama"),
    log,
    now,
  });
  const turns = createTurns({
    models,
    record: activity.for("models"),
    log,
  });
  const apps = createAppHost({
    gate,
    activity,
    turns,
    assistant: agentAccess.assistant,
    agents: agentsCanUse,
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
    blobs,
    listening,
    sightings: () => sightings?.list() ?? [],
    updates: appUpdates,
    versions: appVersions,
    waiting: waitingUpdates,
    grants: grantsStore,
    commits: createAppCommits({
      db,
      versions: appVersions,
      updates: appUpdates,
      entities,
      jobs: appJobs,
      workflows: keptWorkflows,
    }),
    off: appsOff,
    onSettings: live.settings,
    onApp(app) {
      live.app(app);
      // Its first successful start also restores workflows after a restart
      // interrupted adding it back.
      if (app.state === "running") workflows.forApps.added(app.id);
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
        // And those of the apps Add devices could offer.
        services: () => [
          ...new Set([...apps.discoveryServices(), ...deviceOffers.services()]),
        ],
        onChange: () => {
          apps.discoveryChanged();
          pairing.refresh();
        },
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
  // An update that waits for room is tried again until there's some.
  const roomWaits = createRoomWaits({
    retry: (signal) => apps.retryRoomWaits(signal),
    log,
  });
  // The home's list of apps: what it could add, and adding, removing and
  // deleting them.
  const {
    availableApps,
    hardwareOffers,
    deviceOffers,
    listTurns,
    appAdding,
    appDeleting,
    appRemoving,
  } = createAppList({
    db,
    gate,
    manager: options.manager,
    shippedApps: options.shippedApps,
    installAdded: options.installAdded,
    apps,
    added: addedApps,
    removed: removedApps,
    grants: grantsStore,
    updates: appUpdates,
    loadPackage: loadStagedPackage,
    pages,
    live,
    sightings,
    pairing,
    devices,
    onDeviceVisibility(change) {
      blobs.deviceChanged(change);
      live.device(change);
    },
    workflows: () => workflows.forApps,
    activity,
    entities,
    now,
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
    timeZone: () => places.clock().timeZone,
    sun: options.sun ?? (() => sunDays(entities)),
  });
  const activityViews = createActivityViews(activity, {
    person: (id) => people.get(id) ?? null,
    client: auth.clients.name,
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
  const { speech, startSpeech, stopSpeech } = assembleSpeech({
    speaker: options.speaker,
    manager: options.manager,
    devices,
    areaOn: () => agentsCanUse.areaOn(announcePermission),
    log,
  });
  const agentTools: AgentTools = assembleAgentTools(agentAccess, {
    apps,
    places,
    devices,
    lights,
    entities,
    activity,
    activityViews,
    history,
    speech,
    now,
  });
  // Live clients hear of a committed entry and the entries it adds to.
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
  // Register the followers once every module they call has been built.
  setCoreFollowers(eventBus, {
    apps,
    blobs,
    dashboards,
    devices,
    history,
    holds,
    listening,
    live,
    motion,
    pairing,
    speech,
    workflows,
  });

  // Stop new workflow runs and offer checks before waiting on shutdown.
  const stopNewWork = [
    ["workflows", () => workflows.interrupt()],
    ["look for sticks", () => hardwareOffers.interrupt()],
    ["check Add devices' offers", () => deviceOffers.interrupt()],
    ["try updates that wait for room", () => roomWaits.interrupt()],
    ["stop Assistant requests", () => apps.stopRequests()],
    ["stop smart speakers' runs", () => listening.stop()],
    ["take no more turns with the AI model", () => turns.close()],
  ] as const satisfies CoreSteps["stopNewWork"];
  // Nothing goes to a device again while the apps stop. Devices' and
  // firmware's deadlines are the last that change a device, so the bus closes
  // after them, and history then records that nothing is known from then on.
  const stoppingSteps = [
    ["stop announcements", stopSpeech],
    ["stop discovery", () => sightings?.close()],
    ["stop the manager's audit", () => managerAudit?.close()],
    ["stop removed apps' deadlines", () => appDeleting.close()],
    ["finish looking for sticks", () => hardwareOffers.close()],
    ["stop Add devices' offers", () => deviceOffers.close()],
    ["stop trying updates that wait for room", () => roomWaits.close()],
    ["stop commands to devices", () => devices.closing()],
    ["stop workflows", () => workflows.close()],
    ["stop holds", () => holds.close()],
    ["finish changes to apps", () => listTurns.settled()],
    ["stop adding and repairing that ask", () => asking.close()],
    ["stop the app host", () => apps.close()],
    ["stop watching the AI model", () => models.stop()],
    ["stop devices", () => devices.close()],
    ["stop firmware", () => firmware.close()],
    ["close the bus", () => eventBus.close()],
    ["let drivers' pictures go", () => blobs.close()],
    ["stop history", () => history.close()],
    ["stop pairing", () => pairing.stop()],
  ] as const satisfies CoreSteps["stopping"];
  const audit = options.manager.audit;
  const managerAudit = audit
    ? createManagerAuditCopy({ db, activity, audit, log })
    : undefined;

  return {
    activity,
    blobs,
    activityViews,
    agentsCanUse,
    agentTools,
    logAgentLimited: agentAccess.logLimited,
    models,
    turns,
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
    waitingUpdates,
    addedApps,
    availableApps,
    appAdding,
    appRemoving,
    appDeleting,
    hardwareOffers,
    deviceOffers,
    roomWaits,
    removedApps,
    pages,
    workflows,
    history,
    // What the manager finds on the home's network, which starts with the
    // core (core.ts); none under a manager that can't look.
    discovery: sightings,
    startSpeech,
    // At stopping's first moment, before anything is awaited (lifecycle.ts).
    stopNewWork,
    // The modules' steps of stopping, in order (lifecycle.ts).
    stoppingSteps,
  };
}

export type Modules = Awaited<ReturnType<typeof createModules>>;
export type ModulesOptions = Parameters<typeof createModules>[1];

// The days of the home's sun, from the first app that provides it; none
// while no app does.
function sunDays(entities: Pick<Entities, "list">): SunDays | null {
  const [sun] = entities.list({ type: sunType.id });
  const state = sunTimesSchema.safeParse(sun?.state);
  return state.success ? state.data.days : null;
}
