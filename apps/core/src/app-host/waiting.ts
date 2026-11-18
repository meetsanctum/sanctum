import type { AppWaitingUpdate } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { durably, type CoreDatabase } from "../database.js";
import { servesAppApi } from "./fit.js";
import type { AppGrants } from "./grants.js";
import { speaksThisCore, type ApartPackage } from "./loader.js";
import { appUpdatesWaiting } from "./schema.js";
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

export type WaitingRow = typeof appUpdatesWaiting.$inferSelect;

const ids = (needs: readonly { id: string }[]) =>
  needs.map((request) => request.id).join(", ");

export function createWaitingUpdates(options: {
  db: CoreDatabase;
  versions: Pick<AppVersions, "last">;
  grants: Pick<AppGrants, "answers" | "grantAll">;
  // A version staged in its folder, as the core reads any app that runs apart.
  loadPackage: (appId: string, folder: string) => Promise<ApartPackage>;
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

  function forget(appId: string) {
    durably(db, () => {
      db.delete(appUpdatesWaiting)
        .where(eq(appUpdatesWaiting.appId, appId))
        .run();
    });
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
        return speaksThisCore(pkg) && servesAppApi(pkg.apart.manifest)
          ? pkg
          : undefined;
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
      const needs =
        last?.folder && last.folder !== folder ? newlyNeeded(pkg) : [];
      if (needs.length === 0) {
        if (rowOf(appId)) forget(appId);
        return pkg;
      }
      const before = rowOf(appId);
      const row: WaitingRow = {
        appId,
        // The same build needing the same keeps its id, so an answer given
        // before a restart still counts, and never grants what it didn't
        // show.
        id:
          before?.folder === folder && ids(before.needs) === ids(needs)
            ? before.id
            : randomUUID(),
        version,
        folder,
        needs,
        since: before?.folder === folder ? before.since : now(),
      };
      durably(db, () => {
        db.insert(appUpdatesWaiting)
          .values(row)
          .onConflictDoUpdate({ target: appUpdatesWaiting.appId, set: row })
          .run();
      });
      const running = await runningNow(appId, last!.folder!);
      if (!running) {
        log(
          `apps: ${appId} ${version} waits for ${ids(needs)}, and what it runs can't run here, so it stops until someone allows it`,
        );
        return pkg;
      }
      log(`apps: ${appId} ${version} waits for ${ids(needs)}`);
      return running;
    },

    /** What the version that waits needs, as clients see it. */
    of(appId: string): AppWaitingUpdate | undefined {
      const row = rowOf(appId);
      return (
        row && {
          id: row.id,
          version: row.version,
          build: row.folder,
          needs: row.needs,
        }
      );
    },

    get: rowOf,

    forget,

    /**
     * Someone allows the version that waits, named by its id: what it newly
     * needs is granted and it's no longer waiting, with what `alongside`
     * writes, in one transaction, and this answers its package to install in
     * place of the one that runs. Nothing, and nothing changed, for another
     * id, or one that now needs more than it showed, which waits anew under
     * another id. A package that can't be read throws, changing nothing.
     */
    async allow(
      appId: string,
      id: string,
      when: { canAllow: () => boolean; alongside: () => void },
    ): Promise<ApartPackage | undefined> {
      const row = rowOf(appId);
      if (row?.id !== id) return undefined;
      const pkg = await options.loadPackage(appId, row.folder);
      if (rowOf(appId)?.id !== id || !when.canAllow()) return undefined;
      // A permission switched off since it showed would leave it paused.
      const needs = newlyNeeded(pkg);
      const shown = new Set(row.needs.map((request) => request.id));
      if (needs.some((request) => !shown.has(request.id))) {
        durably(db, () => {
          db.update(appUpdatesWaiting)
            .set({ id: randomUUID(), needs })
            .where(eq(appUpdatesWaiting.appId, appId))
            .run();
        });
        return undefined;
      }
      durably(db, () => {
        options.grants.grantAll(
          appId,
          row.needs.map((request) => request.id),
        );
        db.delete(appUpdatesWaiting)
          .where(eq(appUpdatesWaiting.appId, appId))
          .run();
        when.alongside();
      });
      log(`apps: ${appId} ${row.version} is allowed`);
      return pkg;
    },
  };
}

export type WaitingUpdates = ReturnType<typeof createWaitingUpdates>;
