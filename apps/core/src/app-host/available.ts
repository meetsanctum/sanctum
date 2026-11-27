import type { AvailableApp } from "@meetsanctum/app-sdk";
import { compare } from "@meetsanctum/app-sdk/words";

import type { AppCapacity } from "../manager-answers.js";
import type { AppNeed } from "../manager.js";
import type { AddedApps } from "./added.js";
import { needOf, shortfallsOf, type HostRoom } from "./fit.js";
import type { ApartPackage } from "./loader.js";
import { keptForMs, type RemovedApps } from "./removed.js";

// The apps a home can add: those its image ships that the household hasn't
// added, each at the version the manager staged for it, with what it asks
// for and what keeps it from being added now. One not staged yet, as just
// after an update, waits for its package to be listed.

export function createAvailableApps(options: {
  // The apps this core's image ships.
  shipped: () => readonly string[];
  added: Pick<AddedApps, "ids">;
  // Those the household removed, whose data is kept a while.
  removed?: Pick<RemovedApps, "get">;
  // What the manager staged, by app, and a staged version's package.
  staged: (options?: {
    requireAnswer?: boolean;
  }) => Promise<Record<string, { folder: string }>>;
  loadPackage: (appId: string, folder: string) => Promise<ApartPackage>;
  pagesNeedIn: (
    appId: string,
    folder: string,
  ) => Promise<"sanctum" | "pages" | null>;
  // What the host has; null when the manager can't say.
  host: () => Promise<HostRoom | null>;
  capacity?: (
    apps: (AppNeed & { app: string })[],
  ) => Promise<Record<string, AppCapacity> | null>;
  need?: (app: AvailableApp) => AppNeed;
  log: (message: string) => void;
}) {
  const { log } = options;
  // Keep the package with the offer, so adding it installs exactly what
  // was checked, even when the manager stages another build meanwhile.
  function removedOf(appId: string): Pick<AvailableApp, "removed"> {
    const row = options.removed?.get(appId);
    return row
      ? {
          removed: {
            at: row.removedAt.toISOString(),
            keptUntil: new Date(
              row.removedAt.getTime() + keptForMs,
            ).toISOString(),
          },
        }
      : {};
  }

  async function read(
    only?: string,
    stagedOptions?: { requireAnswer: boolean },
  ) {
    const staged = await options.staged(stagedOptions);
    // A development stack's image ships no apps: it brings what the
    // manager staged from the worktree.
    const shipped = options.shipped();
    const added = options.added.ids();
    const ids = (shipped.length > 0 ? shipped : Object.keys(staged)).filter(
      (id) => !added.has(id) && (only === undefined || id === only),
    );
    const apps: {
      app: AvailableApp;
      pkg: ApartPackage;
      pagesNeed: Awaited<ReturnType<typeof options.pagesNeedIn>>;
    }[] = [];
    let isComplete = true;
    for (const appId of ids) {
      const folder = staged[appId]?.folder;
      if (!folder) {
        isComplete = false;
        continue;
      }
      try {
        const pkg = await options.loadPackage(appId, folder);
        const { manifest } = pkg.apart;
        const pagesNeed = await options.pagesNeedIn(appId, folder);
        apps.push({
          pkg,
          pagesNeed,
          app: {
            id: appId,
            name: manifest.name,
            version: manifest.version,
            summary: manifest.summary,
            icon: manifest.icon,
            requests: manifest.permissions,
            memory: manifest.runtime.memory,
            data: manifest.runtime.data,
            adds: { devices: manifest.driver !== null },
            shortfalls: [],
            ...removedOf(appId),
          },
        });
      } catch (error) {
        isComplete = false;
        log(
          `apps: ${appId} can't be offered (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (apps.length > 0) {
      const need = options.need ?? needOf;
      const offers = apps.map((offer) => ({
        ...offer,
        need: { app: offer.app.id, ...need(offer.app) },
      }));
      const capacity = await options
        .capacity?.(offers.map(({ need }) => need))
        .catch(() => null);
      const host = apps.some(({ app }) => !capacity?.[app.id])
        ? await options.host().catch(() => null)
        : null;
      for (const { app, pkg, pagesNeed, need } of offers) {
        const room = capacity?.[app.id];
        app.shortfalls = shortfallsOf(pkg.apart.manifest, {
          pagesNeed,
          host,
          capacity: room,
        });
        if (need.services.length > 0) {
          app.servicesMemory = room?.servicesMemoryMb ?? null;
        }
      }
    }
    return {
      apps,
      isComplete,
      isEmpty: Object.keys(staged).length === 0 && shipped.length === 0,
      hasShipped: shipped.length > 0,
    };
  }

  return {
    async list(): Promise<AvailableApp[]> {
      return (await read()).apps
        .map(({ app }) => app)
        .sort((a, b) => compare("en")(a.name, b.name));
    },
    /**
     * Every app it could add, and whether that's all of them: an unstaged
     * or unreadable package may hold more, and nothing staged at all may be
     * a manager that is still staging.
     */
    async listing() {
      const { apps, isComplete, isEmpty, hasShipped } = await read(undefined, {
        requireAnswer: true,
      });
      return {
        apps: apps.map(({ app }) => app),
        isComplete: isComplete && !isEmpty,
        // A development stack can stage apps as the worktree builds them.
        isCacheable: isComplete && hasShipped,
      };
    },
    async find(appId: string) {
      const found = (await read(appId)).apps[0];
      return found && { app: found.app, pkg: found.pkg };
    },
    /**
     * Finds an app that asks for this permission. Null means none. Undefined
     * means it can't tell yet: an unstaged or unreadable package could hold
     * one, nothing is staged at all, as a development stack's manager may
     * answer while staging fails, or the one it found can't be added now,
     * as for want of memory, which can change.
     */
    async findWithPermission(permissionId: string) {
      const { apps, isComplete, isEmpty } = await read(undefined, {
        requireAnswer: true,
      });
      const matches = apps
        .filter(({ app }) => app.requests.some(({ id }) => id === permissionId))
        .sort((left, right) => compare("en")(left.app.name, right.app.name));
      const found = matches[0]?.app;
      if (found) return found.shortfalls.length > 0 ? undefined : found;
      return isComplete && !isEmpty ? null : undefined;
    },
  };
}

export type AvailableApps = ReturnType<typeof createAvailableApps>;
