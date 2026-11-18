import { appApiVersion, appSectionOrderFrom } from "@meetsanctum/app-sdk";
import { coreSocketName } from "@meetsanctum/app-sdk/protocol";
import { join } from "node:path";

import type { Entities } from "../entities/entities.js";
import { apartApp, apartStorage } from "./apart.js";
import type { AppContexts } from "./contexts.js";
import { checkManifest, contractOf } from "./contract.js";
import { servesAppApi } from "./fit.js";
import type { AppGrants } from "./grants.js";
import type { InstalledApp } from "./installed.js";
import { createAppLink } from "./link.js";
import type { ApartPackage } from "./loader.js";
import { createRequestsUnderWay } from "./net.js";
import type { AppsOff } from "./off.js";
import {
  declaredServices,
  mayRunServices,
  servicePermission,
  type createAppServices,
} from "./services.js";
import { newSupervision, type Supervisor } from "./supervisor.js";
import type { AppUpdates } from "./updates.js";
import type { AppVersions } from "./versions.js";
import type { WaitingUpdates } from "./waiting.js";

// Installing one app's package: its manifest checked against what the core
// lets an app of its origin declare, what it brought before checked against the
// types it declares now, its link to the app's socket, its storage and its
// services, and its entry among the installed apps. Starting it is the app
// host's (host.ts).

// Where the core listens for apps apart, a folder for each app, shared with
// their containers by the manager.
const defaultAppSockets = "/run/sanctum-apps";

export function createAppInstaller(options: {
  installed: Map<string, InstalledApp>;
  entities: Pick<Entities, "reconcileTypes">;
  updates: Pick<AppUpdates, "holdsBack">;
  grants: Pick<AppGrants, "adopt" | "of">;
  versions: Pick<AppVersions, "last">;
  waiting: Pick<WaitingUpdates, "get" | "of">;
  off: Pick<AppsOff, "isOff">;
  appServices: Pick<
    ReturnType<typeof createAppServices>,
    "releaseOff" | "releaseUndeclared" | "request"
  >;
  supervisor: () => Pick<Supervisor, "ready" | "lost">;
  contexts: Pick<AppContexts, "coreOf" | "timeLeft">;
  // Where the core listens for apps apart.
  appSockets?: string;
  timeoutMs: number;
  log: (message: string) => void;
  now: () => Date;
}) {
  const { installed, appServices, contexts, log } = options;

  // `checked` collects the apps whose entities were checked against their
  // types, which keep them even when the rest of the install fails. One
  // someone is adding answers its permissions as its add sheet said.
  return function install(
    pkg: ApartPackage,
    checked: Set<string>,
    { isAdding = false }: { isAdding?: boolean } = {},
  ) {
    const { origin } = pkg;
    const appId = pkg.apart.manifest.id;
    if (installed.has(appId)) {
      throw new Error("another package has the same id");
    }
    const manifest = checkManifest(pkg.apart.manifest);
    // One built for an app API this core doesn't serve doesn't run, as when
    // a core's update leaves behind an app its image no longer ships. What
    // it brought stays, for a version that runs.
    if (!servesAppApi(manifest)) {
      checked.add(appId);
      throw new Error(
        `it targets app API ${manifest.core}, and this core serves ${appApiVersion}`,
      );
    }
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
        if (entry) options.supervisor().ready(entry);
      },
      onGone(_reason, hung) {
        const entry = installed.get(appId);
        if (entry) options.supervisor().lost(entry, hung);
      },
    });
    const storage = apartStorage(appId);
    const code = apartApp(
      manifest,
      link,
      contexts.coreOf,
      (ctx) => contexts.timeLeft(ctx) ?? options.timeoutMs,
      () => installed.get(appId)?.updating?.id,
    );
    // A new version of an app the home has run answers as an update, and
    // what it needs that waits for someone stays unanswered.
    const waiting = options.waiting.get(appId);
    const isUpdate = !isAdding && options.versions.last(appId) !== undefined;
    options.grants.adopt(
      manifest,
      isUpdate
        ? {
            waits:
              waiting?.folder === pkg.apart.folder
                ? waiting.needs.map((request) => request.id)
                : [],
          }
        : undefined,
    );
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
      off: origin !== "system" && options.off.isOff(appId),
      link,
      apartIn: pkg.apart.folder,
      digest: pkg.apart.digest,
      waiting: options.waiting.of(appId),
      supervision: newSupervision(options.now()),
    });
  };
}
