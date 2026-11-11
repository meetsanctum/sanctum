import type {
  AppGoBack,
  AppRunUpdate,
  StartInfo,
  StaticManifest,
} from "@meetsanctum/app-sdk";
import { appDatabaseName } from "@meetsanctum/app-sdk/protocol";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { durably, type CoreDatabase } from "../database.js";
import { ManagerRefusal, type ManagerClient } from "../manager.js";
import { appStateOf } from "./app-info.js";
import { manifestFor } from "./contract.js";
import type { ApartPackage, AppPackage } from "./host.js";
import type { InstalledApp } from "./installed.js";
import { appUpdates } from "./schema.js";
import type { AppSettingsStore } from "./settings.js";
import type { AppVersions } from "./versions.js";

// An app's update. The core starts them, one at a time as the manager's slot
// allows, and this row says how far each got, forced to disk at each step,
// so any step can be interrupted and run again:
//
//   waiting   the version it's going to is installed, and waits for its turn. The
//             manager stops the app and copies its database.
//   starting  that copy is whole. The new version migrates and starts. Its commit
//             removes this row, in the transaction that writes the only commit.
//   undoing   it failed, or the power went before that commit. The old version is
//             installed, held back until the manager has put the copy back.
//   restored  the copy is back. The old version starts, told rolledBack, claiming
//             what it owns as any new version does.
//   undone    its start returned. It stays on the old version until another version
//             than the one that failed arrives. One that only said it wasn't ready
//             hasn't failed, so it's tried again later.
//
// Someone going back is an update in the other direction, through the same steps: the
// manager copies the version it's leaving and puts the kept copy in place, and the old
// version starts, told rolledBack. If that fails, the same undo returns to the newer
// version. Its commit leaves the row at undone, the other way round, as it then stays
// on the old version just as if the newer one had failed.
//
// An app's first move is an update from the core's process, which has no folder. The
// manager takes in its file from the core's data, read-only, so the original stays as
// it was, and its commit is what says it has moved: from there it never goes back to
// the core's process. Before that, if the version apart fails or the power goes, the
// app simply carries on in the core's process with that file, with nothing to undo,
// until another version arrives. The original goes once its next update commits.
//
// An app's own database is the truth for what it owns in the core, so undoing puts
// that back and lets the old version rebuild from it, through the same calls any app
// uses. The new version's writes go through while it starts, so nothing is held back,
// and nothing but this row and the manager's journal knows it's an update.

export type AppUpdateRow = typeof appUpdates.$inferSelect;

export type AppUpdateManager = Pick<
  ManagerClient,
  | "beginAppUpdate"
  | "commitAppUpdate"
  | "undoAppUpdate"
  | "appUpdates"
  | "keptAppCopy"
>;

const defaultTurnPauseMs = 5_000;
const defaultRetryAfterMs = 30 * 60_000;
// How long someone going back waits for its turn before returning to where it was.
const goingBackGivesUpAfterMs = 10 * 60_000;
// The row's from folder on an app's first move.
const inTheCore = "";
const isMove = (row: AppUpdateRow) => row.fromFolder === inTheCore;

export function createAppUpdates(options: {
  db: CoreDatabase;
  // Where the core keeps the files of the apps in its process.
  dataDir: string;
  versions: AppVersions;
  settings: Pick<AppSettingsStore, "chosen" | "restore" | "settleAfterUndo">;
  manager: AppUpdateManager;
  log: (message: string) => void;
  now: () => Date;
  turnPauseMs?: number;
  catchUpPauseMs?: number;
  // How long a version that wasn't ready waits to be tried again.
  retryAfterMs?: number;
  // A version staged in its folder, as the core reads any app that runs apart.
  loadPackage: (appId: string, folder: string) => Promise<ApartPackage>;
}) {
  const { db, versions, settings, manager, log, now } = options;
  const turnPauseMs = options.turnPauseMs ?? defaultTurnPauseMs;
  const catchUpPauseMs = options.catchUpPauseMs ?? 30_000;
  const retryAfterMs = options.retryAfterMs ?? defaultRetryAfterMs;
  // Set by the host, which is built from what this needs.
  let host: {
    launch: (entry: InstalledApp) => void;
    waits: (entry: InstalledApp, why: string, again?: () => void) => void;
    replace: (
      entry: InstalledApp,
      pkg: ApartPackage | AppPackage,
    ) => Promise<void>;
    isCurrent: (entry: InstalledApp) => boolean;
    // The package an app has in the core's process, if it has one.
    inProcess: (appId: string) => AppPackage | undefined;
  };
  let isClosed = false;
  let catchingUp: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let recovered: Promise<void> | undefined;
  const retrying = new Map<string, NodeJS.Timeout>();

  const rowOf = (appId: string) =>
    db.select().from(appUpdates).where(eq(appUpdates.appId, appId)).get();

  function mark(appId: string, change: Partial<AppUpdateRow>) {
    durably(db, () => {
      db.update(appUpdates)
        .set(change)
        .where(eq(appUpdates.appId, appId))
        .run();
    });
  }

  function forget(appId: string) {
    durably(db, () => {
      db.delete(appUpdates).where(eq(appUpdates.appId, appId)).run();
    });
  }

  // A missing record may need its data put back. Finish that before any app can
  // reconnect or write, sharing one pass between apps that arrive together.
  function catchUp() {
    if (isClosed) return Promise.resolve();
    if (inFlight) return inFlight;
    const work = (async () => {
      const held = await manager.appUpdates();
      for (const [appId, { id }] of Object.entries(held)) {
        if (isClosed) return;
        const row = rowOf(appId);
        if (versions.last(appId)?.updateId === id) {
          await manager.commitAppUpdate(appId, id);
        } else if (row?.id !== id) {
          log(`apps: ${appId} has no record of update ${id}, so it's undone`);
          await manager.undoAppUpdate(appId, id);
        } else if (row.status === "undone") {
          // A first move that didn't work has only this left to do.
          await manager.undoAppUpdate(appId, id);
        }
      }
    })();
    inFlight = work;
    const settled = () => {
      inFlight = undefined;
    };
    void work.then(settled, settled);
    return work;
  }

  // A missed commit must free the manager's slot without a core restart. This
  // also retries startup recovery while the manager is unavailable.
  function retryCatchUp() {
    if (isClosed) return;
    clearTimeout(catchingUp);
    catchingUp = undefined;
    void catchUp().catch(() => {
      if (isClosed) return;
      clearTimeout(catchingUp);
      catchingUp = setTimeout(retryCatchUp, catchUpPauseMs);
      catchingUp.unref();
    });
  }

  // Installs that version in its place, asking again until it can, since nothing
  // else will: the supervisor left it to this.
  function swapTo(entry: InstalledApp, folder: string) {
    if (isClosed) return;
    const appId = entry.manifest.id;
    options
      .loadPackage(appId, folder)
      .then((pkg) => host.replace(entry, pkg))
      .catch((error: unknown) => {
        log(`apps: ${appId} couldn't go back yet (${String(error)})`);
        if (isClosed) return;
        setTimeout(() => swapTo(entry, folder), turnPauseMs).unref();
      });
  }

  // The old version comes back, its data as it was.
  function goBack(entry: InstalledApp, row: AppUpdateRow) {
    swapTo(entry, row.fromFolder);
  }

  // Whether a first move has somewhere to carry on if it doesn't work.
  const canFallBack = (row: AppUpdateRow) =>
    isMove(row) && host.inProcess(row.appId) !== undefined;

  // Back in the core's process, asking again until it can, as for going back.
  function backInTheCore(entry: InstalledApp) {
    if (isClosed) return;
    const appId = entry.manifest.id;
    const pkg = host.inProcess(appId);
    if (!pkg) return;
    host.replace(entry, pkg).catch((error: unknown) => {
      log(`apps: ${appId} couldn't go back yet (${String(error)})`);
      if (isClosed) return;
      setTimeout(() => backInTheCore(entry), turnPauseMs).unref();
    });
  }

  // One that won't read is what installing it says, not a reason to stay half-way.
  function settingsSchemaOf(pkg: AppPackage) {
    try {
      return manifestFor(pkg.app, pkg.manifest, log).settings;
    } catch {
      return null;
    }
  }

  // Its original is as it was, so nothing needs putting back. The manager's slot frees
  // once it hears, which goes on being asked until it does.
  function moveUndone(
    row: AppUpdateRow,
    pkg: AppPackage | undefined,
    change: Partial<AppUpdateRow> = {},
  ) {
    const schema = pkg && settingsSchemaOf(pkg);
    durably(db, () => {
      if (schema) settings.settleAfterUndo(row.appId, schema, row.settings);
      db.update(appUpdates)
        .set({ status: "undone", ...change })
        .where(eq(appUpdates.appId, row.appId))
        .run();
    });
  }

  function moveFailed(
    entry: InstalledApp,
    row: AppUpdateRow,
    change: Partial<AppUpdateRow>,
  ) {
    const appId = entry.manifest.id;
    moveUndone(row, host.inProcess(appId), change);
    log(`apps: ${appId} stays in the core's process, its file as it was`);
    backInTheCore(entry);
    retryCatchUp();
  }

  function undoFailed(entry: InstalledApp, row: AppUpdateRow, failure: string) {
    if (isMove(row)) return moveFailed(entry, row, { failure });
    mark(entry.manifest.id, { status: "undoing", failure });
    goBack(entry, row);
  }

  // On the old version for now: at the time it says, it tries the new one again.
  function tryAgainLater(
    entry: InstalledApp,
    row: AppUpdateRow,
    pauseMs = Math.max(0, row.retryAt!.getTime() - now().getTime()),
  ) {
    const appId = entry.manifest.id;
    const isWaiting = () => {
      if (isClosed) return false;
      const current = rowOf(appId);
      return current?.id === row.id && current.status === "undone";
    };
    const later = (work: () => void, wait: number) => {
      clearTimeout(retrying.get(appId));
      retrying.set(
        appId,
        setTimeout(() => {
          retrying.delete(appId);
          work();
        }, wait).unref(),
      );
    };
    later(() => {
      if (!isWaiting() || !host.isCurrent(entry) || entry.off) return;
      options
        .loadPackage(appId, row.toFolder)
        .then((pkg) => {
          if (!isWaiting() || !host.isCurrent(entry) || entry.off) return;
          // Keep the row until the new entry arrives: a failed or cancelled swap
          // must leave enough on disk to try again, including after a restart.
          const replace = () => {
            if (!isWaiting()) return;
            host.replace(entry, pkg).catch((error: unknown) => {
              log(`apps: ${appId} can't try again (${String(error)})`);
              if (isWaiting()) later(replace, turnPauseMs);
            });
          };
          replace();
        })
        .catch((error: unknown) => {
          log(`apps: ${appId} can't try again (${String(error)})`);
          if (isWaiting() && host.isCurrent(entry)) {
            tryAgainLater(entry, row, turnPauseMs);
          }
        });
    }, pauseMs);
  }

  // Waiting for a turn is fine for a while, but someone is waiting for this.
  const givesUp = (row: AppUpdateRow, error: unknown) =>
    (error instanceof ManagerRefusal && error.status !== 409) ||
    now().getTime() - row.startedAt.getTime() >= goingBackGivesUpAfterMs;

  // The manager's copy is what's needed; the core has what it asked for.
  async function begin(entry: InstalledApp, row: AppUpdateRow) {
    const appId = entry.manifest.id;
    if (!host.isCurrent(entry)) return;
    const why = row.restores
      ? "Waiting for its turn to go back"
      : "Waiting for its turn to update";
    host.waits(entry, why);
    try {
      await manager.beginAppUpdate(appId, {
        id: row.id,
        from: {
          version: row.fromVersion,
          ...(isMove(row) ? {} : { folder: row.fromFolder }),
        },
        to: { version: row.toVersion, folder: row.toFolder },
        file: appDatabaseName,
        ...(row.restores ? { restores: row.restores } : {}),
        ...(isMove(row)
          ? { moves: `${appId}.db`, dataMb: entry.manifest.runtime.data }
          : {}),
      });
    } catch (error) {
      if (!host.isCurrent(entry)) return;
      if ((row.restores || canFallBack(row)) && givesUp(row, error)) {
        log(`apps: ${appId} can't go on (${String(error)})`);
        undoFailed(entry, row, "failed_start");
        return;
      }
      log(`apps: ${appId} waits for its update (${String(error)})`);
      host.waits(entry, why, () => {
        void begin(entry, row);
      });
      return;
    }
    if (!host.isCurrent(entry)) return;
    durably(db, () => {
      // Those it chose stay where this version accepts them, and otherwise they
      // return to what they were before that update.
      if (row.restores) {
        settings.settleAfterUndo(
          appId,
          entry.manifest.settings,
          versions.last(appId)?.settingsBefore ?? {},
        );
      }
      db.update(appUpdates)
        .set({ status: "starting" })
        .where(eq(appUpdates.appId, appId))
        .run();
    });
    log(`apps: ${appId} starts on ${row.toVersion}, from ${row.fromVersion}`);
    host.launch(entry);
  }

  // The manager puts the copy back, then the old version starts. Asked again, it
  // does nothing, so the copy never goes back over what the old version wrote.
  async function restore(entry: InstalledApp, row: AppUpdateRow) {
    const appId = entry.manifest.id;
    if (!host.isCurrent(entry)) return;
    host.waits(entry, "Waiting for its data to come back");
    try {
      await manager.undoAppUpdate(appId, row.id);
    } catch (error) {
      if (!host.isCurrent(entry)) return;
      log(`apps: ${appId} waits for its data (${String(error)})`);
      host.waits(entry, "Waiting for its data to come back", () => {
        void restore(entry, row);
      });
      return;
    }
    if (!host.isCurrent(entry)) return;
    durably(db, () => {
      if (row.restores) settings.restore(appId, row.settings);
      else
        settings.settleAfterUndo(appId, entry.manifest.settings, row.settings);
      db.update(appUpdates)
        .set({ status: "restored" })
        .where(eq(appUpdates.appId, appId))
        .run();
    });
    log(`apps: ${appId} goes back to ${row.fromVersion}`);
    host.launch(entry);
  }

  // What a first move left, once an update has committed and made a copy of its own.
  function removeOriginal(appId: string) {
    for (const suffix of ["", "-wal", "-shm"]) {
      void rm(join(options.dataDir, "apps", `${appId}.db${suffix}`), {
        force: true,
      }).catch((error: unknown) => {
        log(`apps: ${appId}'s old file wasn't removed (${String(error)})`);
      });
    }
  }

  // Not while it's off, or while an update of it is under way.
  function canGoBack(entry: InstalledApp) {
    if (entry.off || !entry.apartIn || !host.isCurrent(entry)) return false;
    const state = appStateOf(entry);
    if (state === "paused" || state === "starting") return false;
    const status = rowOf(entry.manifest.id)?.status;
    return status === undefined || status === "undone";
  }

  return {
    /** What the host gives this to act with. */
    use(given: typeof host) {
      host = given;
    },

    /** Startup recovery, before opening an app's socket. */
    recover() {
      recovered ??= catchUp().catch((error: unknown) => {
        recovered = undefined;
        throw error;
      });
      return recovered;
    },

    /**
     * Which version to install as the core starts: the one its image brings, unless
     * an update of it failed or never reached its commit, which brings the old one
     * back. This writes only to the core's own data, so a core on trial may run it.
     */
    async packageFor(
      pkg: AppPackage | ApartPackage,
      inProcess?: AppPackage,
    ): Promise<AppPackage | ApartPackage> {
      if (!("apart" in pkg)) {
        // Once it has moved its data is apart, and its old file is out of date.
        const moved = versions.last(pkg.app.id)?.folder;
        if (!moved) {
          const row = rowOf(pkg.app.id);
          if (row && isMove(row) && row.status !== "undone") {
            moveUndone(row, pkg);
          }
          return pkg;
        }
        pkg = await options.loadPackage(pkg.app.id, moved);
      }
      const appId = pkg.apart.manifest.id;
      const row = rowOf(appId);
      if (!row) return pkg;
      const folder = pkg.apart.folder;
      if (isMove(row)) {
        const isTheSame = row.toFolder === folder;
        // It hadn't started, so it carries on.
        if (row.status === "waiting" && isTheSame) return pkg;
        // Another version, or its time to try again: a move from the start.
        const isTimeToRetry = row.retryAt !== null && row.retryAt <= now();
        if (
          !isTheSame ||
          isTimeToRetry ||
          (!inProcess && row.status === "undone")
        ) {
          forget(appId);
          return pkg;
        }
        // With nowhere else to carry on, it goes on from the copy it took in.
        if (!inProcess) return pkg;
        // The power went after it started and before its commit.
        if (row.status !== "undone") moveUndone(row, inProcess);
        return inProcess;
      }
      if (row.status === "waiting") {
        // Someone asked to go back, and the core still brings what they left.
        if (row.restores && row.fromFolder === folder) {
          return options.loadPackage(appId, row.toFolder);
        }
        // Another version arrived while it waited. What it stopped is still there.
        if (row.toFolder !== folder) forget(appId);
        return pkg;
      }
      if (
        row.status === "undone" &&
        (row.toFolder !== folder || (row.retryAt && row.retryAt <= now()))
      ) {
        forget(appId);
        return pkg;
      }
      // Its data is back, so another version needn't wait for the old one's start,
      // which may never finish, and which would hold back the version that fixes it.
      // The old package itself must still finish rebuilding what it owns.
      if (
        row.status === "restored" &&
        row.toFolder !== folder &&
        row.fromFolder !== folder
      ) {
        forget(appId);
        return pkg;
      }
      // The power went after it started and before its commit.
      if (row.status === "starting") mark(appId, { status: "undoing" });
      return options.loadPackage(appId, row.fromFolder);
    },

    /** How its update stands now, for what clients say. */
    shownFor(appId: string): AppRunUpdate | undefined {
      const row = rowOf(appId);
      switch (row?.status) {
        case "waiting":
        case "starting":
          return {
            stage: row.restores ? "goingBack" : "updating",
            to: row.toVersion,
          };
        case "undoing":
        case "restored":
          return { stage: "goingBack", to: row.fromVersion };
        case "undone":
          return {
            stage: "wentBack",
            from: row.toVersion,
            triesAgain: row.retryAt !== null,
            ...(row.chosen ? { chosen: true as const } : {}),
          };
        default:
          return undefined;
      }
    },

    /** What going back would return to, if anything. Nothing while it can't. */
    async goBackOption(entry: InstalledApp): Promise<AppGoBack | null> {
      if (!canGoBack(entry)) return null;
      const kept = await manager.keptAppCopy(entry.manifest.id);
      return (
        kept && { id: kept.id, version: kept.from.version, since: kept.at }
      );
    },

    /**
     * Someone asked to go back from its last update. Whether it can: if so, it's on
     * its way once this returns.
     */
    async startGoingBack(entry: InstalledApp, copyId: string) {
      const appId = entry.manifest.id;
      const kept = canGoBack(entry) ? await manager.keptAppCopy(appId) : null;
      if (!kept || kept.id !== copyId) return false;
      // Refused here, before anything stops, if it can't be read.
      await options.loadPackage(appId, kept.from.folder);
      const last = versions.last(appId);
      if (!canGoBack(entry) || !last?.folder) return false;
      const row: AppUpdateRow = {
        appId,
        id: randomUUID(),
        fromVersion: last.version,
        fromFolder: last.folder,
        toVersion: kept.from.version,
        toFolder: kept.from.folder,
        status: "waiting",
        settings: settings.chosen(appId),
        failure: null,
        retryAt: null,
        restores: kept.id,
        chosen: false,
        startedAt: now(),
      };
      durably(db, () => {
        db.insert(appUpdates)
          .values(row)
          .onConflictDoUpdate({ target: appUpdates.appId, set: row })
          .run();
      });
      log(`apps: ${appId} goes back to ${kept.from.version}, as someone asked`);
      swapTo(entry, row.toFolder);
      return true;
    },

    /** Its socket is listening: an update's next step, or it simply runs. */
    arrive(entry: InstalledApp) {
      const { id: appId, version } = entry.manifest;
      // Nothing happens to one that's off until someone turns it on.
      if (entry.off) return;
      let row = rowOf(appId);
      if (
        row?.status === "undone" &&
        row.retryAt &&
        entry.apartIn === row.toFolder
      ) {
        forget(appId);
        row = undefined;
      }
      if (row?.status === "undoing") return void restore(entry, row);
      if (row?.status === "waiting") return void begin(entry, row);
      if (row) {
        if (row.status === "undone" && row.retryAt) tryAgainLater(entry, row);
        return host.launch(entry);
      }
      const last = versions.last(appId);
      // It ran in the core's process, so its file comes with it, whether or not the
      // package it ran from is here now.
      const isFirstMove = last && !last.folder && entry.apartIn;
      if (
        !isFirstMove &&
        (!last?.folder || last.folder === entry.apartIn || !entry.apartIn)
      ) {
        return host.launch(entry);
      }
      const started: AppUpdateRow = {
        appId,
        id: randomUUID(),
        fromVersion: last!.version,
        fromFolder: last!.folder ?? inTheCore,
        toVersion: version,
        toFolder: entry.apartIn!,
        status: "waiting",
        settings: settings.chosen(appId),
        failure: null,
        retryAt: null,
        restores: null,
        chosen: false,
        startedAt: now(),
      };
      durably(db, () => {
        db.insert(appUpdates).values(started).run();
      });
      void begin(entry, started);
    },

    /** Why this version starts, and the update its start commits, if any. */
    startOf(entry: InstalledApp): { info: StartInfo; update?: string } {
      const row = rowOf(entry.manifest.id);
      if (row?.status === "starting") {
        return {
          info: {
            reason: row.restores ? "rolledBack" : "updated",
            from: row.fromVersion,
          },
          update: row.id,
        };
      }
      if (row?.status === "restored") {
        return {
          info: { reason: "rolledBack", from: row.toVersion },
          update: row.id,
        };
      }
      return { info: versions.startInfo(entry.manifest) };
    },

    /** In the commit's transaction: the update is over, either way. */
    committing({ id: appId }: StaticManifest) {
      const row = rowOf(appId);
      if (row?.status === "starting" && row.restores) {
        // On the old version now, staying there until another version arrives.
        db.update(appUpdates)
          .set({
            status: "undone",
            fromVersion: row.toVersion,
            fromFolder: row.toFolder,
            toVersion: row.fromVersion,
            toFolder: row.fromFolder,
            chosen: true,
          })
          .where(eq(appUpdates.appId, appId))
          .run();
      } else if (row?.status === "starting") {
        if (!isMove(row)) versions.settingsBefore(appId, row.settings);
        db.delete(appUpdates).where(eq(appUpdates.appId, appId)).run();
      } else if (row?.status === "restored") {
        db.update(appUpdates)
          .set({ status: "undone" })
          .where(eq(appUpdates.appId, appId))
          .run();
      }
      return row;
    },

    /** The commit is on the disk, so the manager can let go. A later pass catches up. */
    committed(row: AppUpdateRow | undefined, entry: InstalledApp) {
      if (row?.status === "restored" && row.retryAt) {
        tryAgainLater(entry, row);
      }
      if (row?.status !== "starting") return;
      log(`apps: ${row.appId} is on ${row.toVersion}`);
      if (!isMove(row)) removeOriginal(row.appId);
      manager.commitAppUpdate(row.appId, row.id).catch((error: unknown) => {
        log(
          `apps: the manager hasn't heard ${row.appId}'s commit (${String(error)})`,
        );
        retryCatchUp();
      });
    },

    /**
     * A new version failed before its commit, which undoes it. Whether this took it
     * on, since otherwise it's any app's failure.
     */
    failed(entry: InstalledApp, failure: string) {
      const appId = entry.manifest.id;
      const row = rowOf(appId);
      if (row?.status !== "starting") return false;
      // With nowhere to go back to, it's any app's failure: tried again as they are,
      // and stopped in the end with Restart. Its file stays as it was until a commit.
      if (isMove(row) && !canFallBack(row)) return false;
      log(
        `apps: ${appId} ${row.toVersion} failed (${failure}), so it goes back`,
      );
      undoFailed(entry, row, failure);
      return true;
    },

    /**
     * A new version's first start says it can't yet, as when what it needs isn't up.
     * It holds the slot for nobody: the old version comes back, and it's tried again
     * later, not counting against it.
     */
    notReady(entry: InstalledApp, waitingFor: string) {
      const appId = entry.manifest.id;
      const row = rowOf(appId);
      if (row?.status !== "starting") return false;
      // Someone going back wants it now, and trying later would start it on the data
      // of the version it left.
      if (row.restores) {
        log(`apps: ${appId} ${row.toVersion} isn't ready (${waitingFor})`);
        undoFailed(entry, row, "failed_start");
        return true;
      }
      if (isMove(row) && !canFallBack(row)) return false;
      if (isMove(row)) {
        log(`apps: ${appId} ${row.toVersion} isn't ready (${waitingFor})`);
        // Tried again when the core next starts after that.
        moveFailed(entry, row, {
          retryAt: new Date(now().getTime() + retryAfterMs),
        });
        return true;
      }
      log(
        `apps: ${appId} ${row.toVersion} isn't ready (${waitingFor}), so it goes back for now`,
      );
      mark(appId, {
        status: "undoing",
        retryAt: new Date(now().getTime() + retryAfterMs),
      });
      goBack(entry, row);
      return true;
    },

    retryCatchUp,

    close() {
      isClosed = true;
      clearTimeout(catchingUp);
      for (const timer of retrying.values()) clearTimeout(timer);
      retrying.clear();
    },

    turnPauseMs,
  };
}

export type AppUpdates = ReturnType<typeof createAppUpdates>;
