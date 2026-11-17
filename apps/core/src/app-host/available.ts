import type { AvailableApp, StaticManifest } from "@meetsanctum/app-sdk";

import type { AddedApps } from "./added.js";
import { shortfallsOf, type HostRoom } from "./fit.js";
import type { ApartPackage } from "./loader.js";

// The apps a home can add: those its image ships that the household hasn't
// added, each at the version the manager staged for it, with what it asks
// for and what keeps it from being added now. One not staged yet, as just
// after an update, waits for its package to be listed.

// What it brings to the home, as its add sheet counts it.
function addsOf({ driver, provides }: StaticManifest): AvailableApp["adds"] {
  return {
    devices: driver !== null,
    widgets: provides.widgets.length,
    roomSections: provides.roomSections.length,
    devicePages: provides.devicePages.length,
    pieces:
      provides.triggers.length +
      provides.conditions.length +
      provides.steps.length,
  };
}

export function createAvailableApps(options: {
  // The apps this core's image ships.
  shipped: () => readonly string[];
  added: Pick<AddedApps, "ids">;
  // What the manager staged, by app, and a staged version's package.
  staged: () => Promise<Record<string, { folder: string }>>;
  loadPackage: (appId: string, folder: string) => Promise<ApartPackage>;
  pagesNeedIn: (
    appId: string,
    folder: string,
  ) => Promise<"sanctum" | "pages" | null>;
  // What the host has; null when the manager can't say.
  host: () => Promise<HostRoom | null>;
  log: (message: string) => void;
}) {
  const { log } = options;
  // Keep the package with the offer, so adding it installs exactly what
  // was checked, even when the manager stages another build meanwhile.
  async function read(only?: string) {
    const [staged, host] = await Promise.all([
      options.staged(),
      options.host().catch(() => null),
    ]);
    // A development stack's image ships no apps: it brings what the
    // manager staged from the worktree.
    const shipped = options.shipped();
    const added = options.added.ids();
    const ids = (shipped.length > 0 ? shipped : Object.keys(staged)).filter(
      (id) => !added.has(id) && (only === undefined || id === only),
    );
    const apps: { app: AvailableApp; pkg: ApartPackage }[] = [];
    for (const appId of ids) {
      const folder = staged[appId]?.folder;
      if (!folder) continue;
      try {
        const pkg = await options.loadPackage(appId, folder);
        const { manifest } = pkg.apart;
        const pagesNeed = await options.pagesNeedIn(appId, folder);
        apps.push({
          pkg,
          app: {
            id: appId,
            name: manifest.name,
            version: manifest.version,
            summary: manifest.summary,
            icon: manifest.icon,
            requests: manifest.permissions,
            memory: manifest.runtime.memory,
            data: manifest.runtime.data,
            adds: addsOf(manifest),
            shortfalls: shortfallsOf(manifest, { pagesNeed, host }),
          },
        });
      } catch (error) {
        log(
          `apps: ${appId} can't be offered (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    return apps;
  }

  return {
    async list(): Promise<AvailableApp[]> {
      return (await read())
        .map(({ app }) => app)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async find(appId: string) {
      return (await read(appId))[0];
    },
  };
}

export type AvailableApps = ReturnType<typeof createAvailableApps>;
