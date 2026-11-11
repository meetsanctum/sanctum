import type { StartInfo, StaticManifest } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { appVersions } from "./schema.js";

// The version each app last started on, which tells its start why it's
// starting: for the first time, on a new version, or neither.

export function createAppVersions(
  db: BetterSQLite3Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  return {
    /** The one row that says what it runs. */
    last(appId: string) {
      return db
        .select()
        .from(appVersions)
        .where(eq(appVersions.appId, appId))
        .get();
    },

    /** Why this version is starting. */
    startInfo({ id, version }: StaticManifest): StartInfo {
      const last = db
        .select({ version: appVersions.version })
        .from(appVersions)
        .where(eq(appVersions.appId, id))
        .get();
      if (!last) return { reason: "added" };
      return last.version === version
        ? { reason: "started" }
        : { reason: "updated", from: last.version };
    },

    /** It started on this version, and this row is what says so. */
    started(
      { id, version }: StaticManifest,
      commit: { digest?: string; folder?: string; update?: string } = {},
    ) {
      const previous = db
        .select()
        .from(appVersions)
        .where(eq(appVersions.appId, id))
        .get();
      const values = {
        version,
        startedAt: now(),
        digest: commit.digest ?? null,
        folder: commit.folder ?? null,
        // An ordinary restart does not undo this package's commit. The manager
        // may still need to hear it, even after several restarts.
        updateId:
          commit.update ??
          (previous?.version === version &&
          previous.folder === (commit.folder ?? null) &&
          previous.digest === (commit.digest ?? null)
            ? previous.updateId
            : null),
        settingsBefore:
          previous?.version === version &&
          previous.folder === (commit.folder ?? null) &&
          previous.digest === (commit.digest ?? null)
            ? previous.settingsBefore
            : null,
      };
      db.insert(appVersions)
        .values({ appId: id, ...values })
        .onConflictDoUpdate({ target: appVersions.appId, set: values })
        .run();
    },

    /** What its settings were before the update that row commits. */
    settingsBefore(appId: string, settings: Record<string, unknown>) {
      db.update(appVersions)
        .set({ settingsBefore: settings })
        .where(eq(appVersions.appId, appId))
        .run();
    },
  };
}

export type AppVersions = ReturnType<typeof createAppVersions>;
