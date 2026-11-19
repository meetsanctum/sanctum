import type { AppWaitingUpdate } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { durably, type CoreDatabase } from "../database.js";
import type { AppGrants } from "./grants.js";
import type { ApartPackage } from "./loader.js";
import type { AppsOff } from "./off.js";
import type { updateRoom } from "./room-waits.js";
import { appUpdatesWaiting } from "./schema.js";
import { canRunPackage } from "./update-packages.js";
import type { AppVersions } from "./versions.js";

// An update that needs a permission the household hasn't granted waits for
// someone to allow it, rather than growing what an app may do unseen. As the
// core installs an app's package, a new version that needs one it hasn't
// granted is recorded here, and the version the app runs is installed in its
// place, so it carries on as it was. Allowing grants what it newly needs and
// starts the update, which then runs as any other (updates.ts). An update
// with nothing new, or only optional ones, goes ahead, those off (grants.ts).
//
// A newer version replaces the one that waits, with what that one needs. One
// that waits while the version the app runs can't run on this core, as after
// an update of Sanctum it no longer speaks, is installed after all, paused
// for want of what it needs, so the app stops until someone allows it
// instead of holding back Sanctum's update.
//
// An update that needs more memory than is left beside the other apps waits
// too, the manager holding its room once there is some (adding.ts holds an
// add's the same way): the app stays on its version, and the update starts by
// itself once there's room, as when someone turns off an app they don't use.
// One someone allows checks for room the same way before it starts.

export type WaitingRow = typeof appUpdatesWaiting.$inferSelect;

const ids = (needs: readonly { id: string }[]) =>
  needs.map((request) => request.id).join(", ");

export function createWaitingUpdates(options: {
  db: CoreDatabase;
  versions: Pick<AppVersions, "last">;
  grants: Pick<AppGrants, "answers" | "grantAll">;
  // A version staged in its folder, as the core reads any app that runs apart.
  loadPackage: (appId: string, folder: string) => Promise<ApartPackage>;
  off: Pick<AppsOff, "isOff">;
  room: ReturnType<typeof updateRoom>;
  log: (message: string) => void;
  now?: () => Date;
  // How long before reading the version the app runs again, after a read
  // that failed.
  readPauseMs?: number;
}) {
  const { db, log } = options;
  const now = options.now ?? (() => new Date());
  const readPauseMs = options.readPauseMs ?? 250;

  const rowOf = (appId: string) =>
    db
      .select()
      .from(appUpdatesWaiting)
      .where(eq(appUpdatesWaiting.appId, appId))
      .get();

  // In the caller's transaction.
  function drop(appId: string) {
    db.delete(appUpdatesWaiting)
      .where(eq(appUpdatesWaiting.appId, appId))
      .run();
  }

  function forget(appId: string) {
    durably(db, () => drop(appId));
  }

  // What this version needs that the household hasn't granted.
  function newlyNeeded(pkg: ApartPackage) {
    const { id, permissions } = pkg.apart.manifest;
    const answers = options.grants.answers(id);
    return permissions.filter(
      (request) => request.needed && answers.get(request.id) !== true,
    );
  }

  // The version the app runs, if this core can still run it. A read that
  // fails is tried again, since one that can't be read isn't one that can't
  // run; only one that still can't be read stops the app as that would.
  async function runningNow(appId: string, folder: string) {
    for (let tries = 1; ; tries += 1) {
      try {
        const pkg = await options.loadPackage(appId, folder);
        return canRunPackage(pkg) ? pkg : undefined;
      } catch (error) {
        if (tries >= 3) {
          log(
            `apps: ${appId}'s version before can't be read (${String(error)})`,
          );
          return undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, readPauseMs));
      }
    }
  }

  // Records that this version waits for what it needs. The same build
  // needing the same keeps its id, so an answer given before a restart still
  // counts, and never grants what it didn't show.
  function record(
    pkg: ApartPackage,
    needs: WaitingRow["needs"],
    moreMemoryMb: number | null = null,
  ) {
    const { id: appId, version } = pkg.apart.manifest;
    const { folder } = pkg.apart;
    const before = rowOf(appId);
    const isSame =
      before?.folder === folder && ids(before.needs) === ids(needs);
    const row: WaitingRow = {
      appId,
      id: isSame ? before.id : randomUUID(),
      version,
      folder,
      needs,
      moreMemoryMb,
      since: before?.folder === folder ? before.since : now(),
    };
    durably(db, () => {
      db.insert(appUpdatesWaiting)
        .values(row)
        .onConflictDoUpdate({ target: appUpdatesWaiting.appId, set: row })
        .run();
    });
  }

  function of(appId: string): AppWaitingUpdate | undefined {
    const row = rowOf(appId);
    return (
      row && {
        id: row.id,
        version: row.version,
        build: row.folder,
        needs: row.needs,
        ...(row.moreMemoryMb === null
          ? {}
          : { moreMemoryMb: row.moreMemoryMb }),
      }
    );
  }

  return {
    /**
     * Which package to install of an app the image brings, by what its
     * version newly needs: that one, or the one the app runs while it waits.
     * For an app with no update under way, since one that began goes on as
     * it was.
     */
    async choose(pkg: ApartPackage): Promise<ApartPackage> {
      const { id: appId, version } = pkg.apart.manifest;
      const { folder } = pkg.apart;
      const last = options.versions.last(appId);
      // A version the home has run, from a staged folder or, before its
      // first move, from the core's own process.
      const isNew = last !== undefined && last.folder !== folder;
      const needs = isNew ? newlyNeeded(pkg) : [];
      if (needs.length === 0) {
        const isRunnableUpdate = isNew && canRunPackage(pkg);
        const isOff = pkg.origin !== "system" && options.off.isOff(appId);
        const room =
          isRunnableUpdate && !isOff ? await options.room(pkg) : undefined;
        try {
          const before = rowOf(appId);
          // Keep the last confirmed shortfall for this build while it's off
          // or the manager can't confirm a reservation.
          const moreMemoryMb =
            room?.kind === "short"
              ? room.moreMemoryMb
              : isRunnableUpdate && !room && before?.folder === folder
                ? before.moreMemoryMb
                : null;
          if (moreMemoryMb !== null && last?.folder) {
            const running = await runningNow(appId, last.folder);
            if (running) {
              record(pkg, [], moreMemoryMb);
              log(
                `apps: ${appId} ${version} waits for ${moreMemoryMb} MB more memory`,
              );
              return running;
            }
          }
          if (before) forget(appId);
        } catch (error) {
          if (room?.kind === "held") await room.release();
          throw error;
        }
        return pkg;
      }
      record(pkg, needs);
      // One the core ran in its own process can only run apart now.
      const running = last?.folder
        ? await runningNow(appId, last.folder)
        : undefined;
      if (!running) {
        log(
          `apps: ${appId} ${version} waits for ${ids(needs)}, and what it runs can't run here, so it stops until someone allows it`,
        );
        return pkg;
      }
      log(`apps: ${appId} ${version} waits for ${ids(needs)}`);
      return running;
    },

    /**
     * Whether a version tried again later, after it wasn't ready, now needs
     * what nobody has allowed, as when someone switched it off meanwhile: it
     * then waits, as clients see it, instead of taking the place of the one
     * that runs.
     */
    holds(pkg: ApartPackage): AppWaitingUpdate | undefined {
      const needs = newlyNeeded(pkg);
      if (needs.length === 0) return undefined;
      record(pkg, needs);
      log(
        `apps: ${pkg.apart.manifest.id} ${pkg.apart.manifest.version} waits for ${ids(needs)}`,
      );
      return of(pkg.apart.manifest.id);
    },

    /**
     * Tries again a version that waits for room. It starts with a reservation
     * or keeps waiting with the latest shortfall or required permissions.
     */
    async retry(
      appId: string,
      when: {
        canRetry: () => boolean;
        start: (pkg: ApartPackage) => void;
      },
    ): Promise<void> {
      const row = rowOf(appId);
      if (!row || row.moreMemoryMb === null) return;
      const isCurrent = () => when.canRetry() && rowOf(appId)?.id === row.id;
      const pkg = await options.loadPackage(appId, row.folder);
      if (!isCurrent()) return;
      if (!canRunPackage(pkg)) {
        throw new Error(`${row.version} can't run on this core`);
      }
      const needs = newlyNeeded(pkg);
      if (needs.length > 0) {
        record(pkg, needs);
        return;
      }
      const room = await options.room(pkg);
      if (!room) return;
      let isTakingRoom = false;
      try {
        if (!isCurrent()) return;
        if (room.kind === "short") {
          if (room.moreMemoryMb === row.moreMemoryMb) return;
          durably(db, () => {
            db.update(appUpdatesWaiting)
              .set({ moreMemoryMb: room.moreMemoryMb })
              .where(eq(appUpdatesWaiting.appId, appId))
              .run();
          });
          return;
        }
        forget(appId);
        isTakingRoom = true;
        log(`apps: ${appId} ${row.version} has room now`);
        when.start(pkg);
      } finally {
        if (!isTakingRoom && room.kind === "held") await room.release();
      }
    },

    /** What the version that waits needs, as clients see it. */
    of,

    get: rowOf,

    forget,

    /** Forgets it in the caller's transaction, as a Go back's own does. */
    drop,

    /**
     * Someone allows the version that waits, named by its id: what it newly
     * needs is granted and it's no longer waiting, with what `alongside`
     * writes, in one transaction, and this answers its package to install in
     * place of the one that runs. Nothing, and nothing changed, for another
     * id, or one that now needs more than it showed, which waits anew under
     * another id. A package that can't be read throws, changing nothing.
     *
     * Like any other version change, one that would replace the version the
     * app runs first asks the manager to hold its room, with the services
     * what it grants runs, for its container's start to take over. Short of
     * memory, what it needs is granted all the same, and it waits for room
     * instead, as `retry` then tries.
     */
    async allow(
      appId: string,
      id: string,
      when: {
        canAllow: () => boolean;
        alongside: () => void;
        // Whether it's the one installed, paused for want of what it needs,
        // whose start checks for room itself.
        isInPlace: (pkg: ApartPackage) => boolean;
      },
    ): Promise<ApartPackage | "waitsForRoom" | undefined> {
      const row = rowOf(appId);
      if (row?.id !== id || row.moreMemoryMb !== null) return undefined;
      const pkg = await options.loadPackage(appId, row.folder);
      // Allowing one this core can't run would grant it and run nothing.
      if (!canRunPackage(pkg)) {
        throw new Error(`${row.version} can't run on this core`);
      }
      const granting = row.needs.map((request) => request.id);
      const isOff = pkg.origin !== "system" && options.off.isOff(appId);
      const room =
        when.isInPlace(pkg) || isOff
          ? undefined
          : await options.room(pkg, granting);
      let isTakingRoom = false;
      try {
        if (rowOf(appId)?.id !== id || !when.canAllow()) return undefined;
        // A permission switched off since it showed would leave it paused.
        const needs = newlyNeeded(pkg);
        const shown = new Set(granting);
        if (needs.some((request) => !shown.has(request.id))) {
          durably(db, () => {
            db.update(appUpdatesWaiting)
              .set({ id: randomUUID(), needs })
              .where(eq(appUpdatesWaiting.appId, appId))
              .run();
          });
          return undefined;
        }
        if (room?.kind === "short") {
          durably(db, () => {
            options.grants.grantAll(appId, granting);
            db.update(appUpdatesWaiting)
              .set({
                id: randomUUID(),
                needs: [],
                moreMemoryMb: room.moreMemoryMb,
              })
              .where(eq(appUpdatesWaiting.appId, appId))
              .run();
            when.alongside();
          });
          log(
            `apps: ${appId} ${row.version} is allowed, and waits for ${room.moreMemoryMb} MB more memory`,
          );
          return "waitsForRoom";
        }
        durably(db, () => {
          options.grants.grantAll(appId, granting);
          db.delete(appUpdatesWaiting)
            .where(eq(appUpdatesWaiting.appId, appId))
            .run();
          when.alongside();
        });
        isTakingRoom = true;
        log(`apps: ${appId} ${row.version} is allowed`);
        return pkg;
      } finally {
        if (!isTakingRoom && room?.kind === "held") await room.release();
      }
    },
  };
}

export type WaitingUpdates = ReturnType<typeof createWaitingUpdates>;
