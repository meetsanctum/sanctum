import {
  pausedBy,
  type AppInfo,
  type AppRun,
  type AppRunUpdate,
  type AppState,
  type SettingsSchema,
  type StaticManifest,
} from "@meetsanctum/app-sdk";

import type { Supervision } from "./supervisor.js";

// An installed app as clients see it (GET /api/apps): what it is, what it
// asks for and holds now, whether it runs, and what it brings to the home.
// The rest of its manifest, such as its previews and its pieces' words, is
// for its settings page, which reads it on its own
// (GET /api/apps/:appId/manifest).
export function appInfoOf(
  manifest: StaticManifest,
  now: {
    granted: readonly string[];
    state: AppState;
    settings: SettingsSchema | null;
  },
): AppInfo {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.oldestPage ? { oldestPage: manifest.oldestPage } : {}),
    icon: manifest.icon,
    pages: [...manifest.pages],
    permissions: [...now.granted],
    requests: manifest.permissions,
    state: now.state,
    settings: now.settings,
    provides: {
      entities: manifest.provides.entities.map(({ id, title }) => ({
        id,
        title,
      })),
      widgets: manifest.provides.widgets.map(
        ({ preview: _, ...widget }) => widget,
      ),
      roomSections: manifest.provides.roomSections.map(
        ({ preview: _, ...section }) => section,
      ),
      devicePages: manifest.provides.devicePages,
    },
  };
}

/** What the core knows of an installed app that says whether it runs. */
type Installed = {
  manifest: StaticManifest;
  origin?: string;
  granted: readonly string[];
  settings: SettingsSchema | null;
  running?: unknown;
  off?: boolean;
  supervision: Pick<
    Supervision,
    | "phase"
    | "since"
    | "isFirstStart"
    | "waitingFor"
    | "failures"
    | "lastFailure"
    | "quiet"
    | "attention"
  >;
};

/**
 * Whether an installed app runs: off once someone turned it off; paused while
 * a permission it needs is off; otherwise as its supervisor has it
 * (supervisor.ts).
 */
export function appStateOf(entry: Installed): AppState {
  if (entry.off) {
    return "off";
  }
  if (pausedBy(entry.manifest.permissions, entry.granted).length > 0) {
    return "paused";
  }
  return entry.supervision.phase;
}

// More of its state, as its supervisor has it.
function runOf({ supervision }: Installed, update?: AppRunUpdate): AppRun {
  return {
    ...(update ? { update } : {}),
    since: supervision.since.toISOString(),
    ...(supervision.isFirstStart ? { isFirstStart: true as const } : {}),
    ...(supervision.waitingFor ? { waitingFor: supervision.waitingFor } : {}),
    ...(supervision.failures.length > 0
      ? { failures: supervision.failures.length }
      : {}),
    ...(supervision.lastFailure
      ? { lastFailure: supervision.lastFailure }
      : {}),
    ...(supervision.quiet ? { quiet: true as const } : {}),
    ...(supervision.attention ? { attention: true as const } : {}),
  };
}

/** An installed app as clients see it now. */
export function installedInfoOf(
  entry: Installed,
  update?: AppRunUpdate,
): AppInfo {
  return {
    ...appInfoOf(entry.manifest, {
      granted: entry.granted,
      state: appStateOf(entry),
      settings: entry.settings,
    }),
    run: runOf(entry, update),
    ...(entry.origin === "system" ? { alwaysOn: true as const } : {}),
  };
}

/**
 * Tells clients an installed app changed, through `onApp`: a listener that
 * fails is logged, so it never undoes or fails the change it announces.
 */
export function announcerOf(
  onApp: ((app: AppInfo) => void | Promise<void>) | undefined,
  log: (message: string) => void,
  // How its update stands, which isn't the entry's to know.
  updateOf: (entry: Installed) => AppRunUpdate | undefined = () => undefined,
) {
  return (entry: Installed) => {
    const failed = (error: unknown) =>
      log(
        `apps: ${entry.manifest.id}'s change was not announced (${error instanceof Error ? error.message : String(error)})`,
      );
    try {
      const pending = onApp?.(installedInfoOf(entry, updateOf(entry)));
      if (pending instanceof Promise) pending.catch(failed);
    } catch (error) {
      failed(error);
    }
  };
}
