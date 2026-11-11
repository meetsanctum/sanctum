import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { appsOff } from "./schema.js";

// The apps someone has turned off, which stay off across restarts and new
// versions until someone turns them on.

export function createAppsOff(
  db: BetterSQLite3Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  return {
    isOff(appId: string) {
      return (
        db
          .select({ appId: appsOff.appId })
          .from(appsOff)
          .where(eq(appsOff.appId, appId))
          .get() !== undefined
      );
    },

    set(appId: string, off: boolean) {
      if (off) {
        db.insert(appsOff)
          .values({ appId, turnedOffAt: now() })
          .onConflictDoNothing()
          .run();
      } else {
        db.delete(appsOff).where(eq(appsOff.appId, appId)).run();
      }
    },
  };
}

export type AppsOff = ReturnType<typeof createAppsOff>;
