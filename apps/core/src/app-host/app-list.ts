import type { AvailableApp } from "@meetsanctum/app-sdk";

import type { Activity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { Devices } from "../devices/devices.js";
import type { Pairing } from "../devices/pairing.js";
import type { Sightings } from "../discovery/sightings.js";
import type { Entities } from "../entities/entities.js";
import type { createLiveUpdates } from "../live-updates.js";
import type { ModulesOptions } from "../modules.js";
import type { Pages } from "../pages/pages.js";
import type { Workflows } from "../workflows/workflows.js";
import { createAppAdding } from "./adding.js";
import type { AddedApps } from "./added.js";
import { createAvailableApps } from "./available.js";
import { createAppDeleting } from "./deleting.js";
import { createDeviceOffers } from "./device-offers.js";
import { needOf } from "./fit.js";
import type { Gate } from "./gate.js";
import type { AppGrants } from "./grants.js";
import { createHardwareOffers } from "./hardware-offers.js";
import type { AppHost } from "./host.js";
import { createListTurns } from "./list-turns.js";
import type { ApartPackage } from "./loader.js";
import type { RemovedApps } from "./removed.js";
import { createAppRemoving } from "./removing.js";
import type { AppUpdates } from "./updates.js";

// The home's list of apps: what the image ships that it could add, a Zigbee
// stick's offer and Add devices' offers of apps for what was found, and
// adding, removing and deleting an app's data, which take turns.

export function createAppList(deps: {
  db: CoreDatabase;
  gate: Gate;
  manager: ModulesOptions["manager"];
  shippedApps: ModulesOptions["shippedApps"];
  installAdded: ModulesOptions["installAdded"];
  apps: AppHost;
  added: AddedApps;
  removed: RemovedApps;
  grants: AppGrants;
  updates: AppUpdates;
  // A version staged in its folder.
  loadPackage: (appId: string, folder: string) => Promise<ApartPackage>;
  pages: Pages;
  live: ReturnType<typeof createLiveUpdates>;
  sightings: Sightings | undefined;
  pairing: Pairing;
  devices: Devices;
  // Built after the list, which reaches it only once both are.
  workflows: () => Workflows["forApps"];
  activity: Activity;
  entities: Entities;
  now: (() => Date) | undefined;
  log: (message: string) => void;
}) {
  const {
    db,
    gate,
    apps,
    added,
    removed,
    grants,
    updates,
    loadPackage,
    pages,
    live,
    sightings,
    pairing,
    devices,
    workflows,
    activity,
    entities,
    now,
    log,
  } = deps;
  // What the image ships that the household hasn't added, asked of the
  // manager briefly, since a client waits for the answer.
  const appNeed = (app: AvailableApp) => needOf(app, grants.answers(app.id));
  const availableApps = createAvailableApps({
    shipped: deps.shippedApps ?? (() => []),
    added,
    removed,
    staged: async (check) =>
      (await deps.manager.stagedApps?.(5_000, check)) ?? {},
    loadPackage,
    pagesNeedIn: (appId, folder) => pages.pagesNeedIn(appId, folder),
    host: () => deps.manager.hostStatus(),
    need: appNeed,
    capacity: async (apps) =>
      deps.manager.capabilities().reserves
        ? ((await deps.manager.appCapacity?.(apps)) ?? null)
        : null,
    log,
  });
  // A Zigbee stick plugged in brings up its app's add sheet.
  const hardwareOffers = createHardwareOffers({
    db,
    gate,
    added,
    available: availableApps,
    manager: deps.manager,
    hasInstalled: () => apps.hasInstalled(),
    onOffer: live.offer,
    now,
    log,
  });
  // An app the home could add for devices found on its network is offered
  // in Add devices.
  const deviceOffers = createDeviceOffers({
    available: availableApps,
    added,
    hasInstalled: () => apps.hasInstalled(),
    sightings: () => sightings?.list() ?? [],
    onChange: () => pairing.refresh(),
    log,
  });
  // Adding and removing apps take turns.
  const listTurns = createListTurns();
  const appAdding = createAppAdding({
    gate,
    turns: listTurns,
    removed,
    workflows,
    devices,
    finishRemoval: (appId) => appRemoving.finish(appId),
    onDevice: live.device,
    available: availableApps,
    added,
    offers: hardwareOffers,
    activity,
    hasInstalled: () => apps.hasInstalled(),
    need: appNeed,
    reserve: async (appId, need) => {
      if (!deps.manager.capabilities().reserves) return;
      const reservation = await deps.manager.reserveForApp?.(appId, need);
      const release = deps.manager.releaseAppReservation;
      if (reservation && release) {
        return () => release(appId, reservation.id);
      }
    },
    install: async (pkg) => {
      // The app has been recorded and its offer ends even if it can't start.
      pairing.refresh();
      void deviceOffers.check();
      if (!deps.installAdded) throw new Error("this core installs no app");
      await deps.installAdded(pkg);
    },
    info: (appId) => apps.info(appId),
    log,
  });
  // Deleting a removed app's data, by Delete now or after its 30 days.
  const appDeleting = createAppDeleting({
    db,
    gate,
    turns: listTurns,
    removed,
    added,
    activity,
    manager: deps.manager,
    entities,
    finishRemoval: (appId) => appRemoving.finish(appId),
    releaseLeftover: (appId) => appRemoving.releaseLeftover(appId),
    now,
    log,
  });
  const appRemoving = createAppRemoving({
    gate,
    turns: listTurns,
    host: apps,
    removed,
    updates,
    workflows,
    devices,
    activity,
    manager: deps.manager,
    onRemoved(appId) {
      live.appRemoved(appId);
      // Removed, it can be offered again.
      pairing.refresh();
      void deviceOffers.check();
    },
    onDevice: live.device,
    log,
  });
  return {
    availableApps,
    hardwareOffers,
    deviceOffers,
    listTurns,
    appAdding,
    appDeleting,
    appRemoving,
  };
}
