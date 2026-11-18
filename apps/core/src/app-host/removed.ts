import { eq } from "drizzle-orm";

import { durably, type CoreDatabase } from "../database.js";
import { appsAdded, appsRemoved } from "./schema.js";

// The apps the household removed (schema.ts), whose own data the home keeps
// for 30 days, and whether each removal is done. Removing takes the app off
// the home's list in the same transaction, so a core that stops part way
// never installs it again and finishes the removal at its next start.

/** How long a removed app's own data is kept. */
export const keptForMs = 30 * 24 * 60 * 60_000;

export type RemovedApp = typeof appsRemoved.$inferSelect;

export function createRemovedApps(
  db: CoreDatabase,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const all = () => db.select().from(appsRemoved).all();

  return {
    /**
     * Records that someone removed an app, taking it off the home's list,
     * with what `alongside` writes in the same transaction.
     */
    record(
      appId: string,
      who: { personId?: string; clientId?: string },
      app: { name: string; version: string },
      alongside: () => void = () => undefined,
    ) {
      durably(db, () => {
        db.delete(appsAdded).where(eq(appsAdded.appId, appId)).run();
        const row = {
          removedAt: now(),
          personId: who.personId ?? null,
          clientId: who.clientId ?? null,
          ...app,
          isDone: false,
          isDeleting: false,
        };
        db.insert(appsRemoved)
          .values({ appId, ...row })
          .onConflictDoUpdate({ target: appsRemoved.appId, set: row })
          .run();
        alongside();
      });
    },

    /** Every step of its removal is done. */
    done(appId: string) {
      db.update(appsRemoved)
        .set({ isDone: true })
        .where(eq(appsRemoved.appId, appId))
        .run();
    },

    /** Records deletion before the manager can erase any part of its data. */
    beginDeleting(appId: string) {
      durably(db, () => {
        db.update(appsRemoved)
          .set({ isDeleting: true })
          .where(eq(appsRemoved.appId, appId))
          .run();
      });
    },

    /** Forgets its removal, as when it's added back; in the caller's transaction. */
    forget(appId: string) {
      db.delete(appsRemoved).where(eq(appsRemoved.appId, appId)).run();
    },

    get(appId: string): RemovedApp | undefined {
      return db
        .select()
        .from(appsRemoved)
        .where(eq(appsRemoved.appId, appId))
        .get();
    },

    list: (): RemovedApp[] => all(),

    /** The apps removed, whose devices are hidden meanwhile. */
    ids(): Set<string> {
      return new Set(all().map((row) => row.appId));
    },
  };
}

export type RemovedApps = ReturnType<typeof createRemovedApps>;
