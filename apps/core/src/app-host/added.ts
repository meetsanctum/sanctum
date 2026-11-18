import { durably, type CoreDatabase } from "../database.js";
import { devices } from "../devices/schema.js";
import { entities } from "../entities/schema.js";
import { appsAdded, appsListed, appsOff, appVersions } from "./schema.js";

// The core installs the apps on the home's list. Its first start with the
// list records a new home's configured starter apps. An existing home keeps
// what the image ships, what the manager staged and the apps the database
// already knows. The app rows and the marker for a completed list commit
// together. A later start uses the same list, even when the household has
// removed every app. If neither the core nor the manager knows any apps yet,
// the next start can still record the list.

export function createAddedApps(
  db: CoreDatabase,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  return {
    /**
     * Records the home's first app list. A new home records its starter
     * apps. An existing home records the available apps and every app the
     * database knows. Returns whether the list was recorded.
     */
    recordFirst(appIds: Iterable<string>, newHomeApps: readonly string[]) {
      return durably(db, () => {
        if (db.select().from(appsListed).get() !== undefined) return false;
        const at = now();
        const known = [
          ...db.select({ appId: appVersions.appId }).from(appVersions).all(),
          ...db.select({ appId: appsOff.appId }).from(appsOff).all(),
          // A start can publish entities or register devices before it finishes.
          ...db.selectDistinct({ appId: entities.appId }).from(entities).all(),
          ...db.selectDistinct({ appId: devices.driver }).from(devices).all(),
        ].map((row) => row.appId);
        const offered = [...appIds];
        if (offered.length === 0 && known.length === 0) return false;
        const had = new Set(
          known.length === 0
            ? offered.filter((appId) => newHomeApps.includes(appId))
            : [...offered, ...known],
        );
        for (const appId of had) {
          db.insert(appsAdded)
            .values({ appId, addedAt: at })
            .onConflictDoNothing()
            .run();
        }
        db.insert(appsListed).values({ id: 1, since: at }).run();
        return true;
      });
    },

    /**
     * Records that someone added an app, from now on installed as the home's,
     * with the home's list and what `alongside` writes in the same transaction.
     * Whether it wasn't added already.
     */
    add(
      appId: string,
      who: { personId?: string; clientId?: string },
      alongside: () => void = () => undefined,
    ) {
      return durably(db, () => {
        const at = now();
        const inserted = db
          .insert(appsAdded)
          .values({
            appId,
            addedAt: at,
            personId: who.personId ?? null,
            clientId: who.clientId ?? null,
          })
          .onConflictDoNothing()
          .run();
        if (inserted.changes === 0) return false;
        // Someone chose an app, so the home keeps its list from now on, even
        // when its start knew of none: an app staged later isn't recorded as
        // one it had.
        db.insert(appsListed)
          .values({ id: 1, since: at })
          .onConflictDoNothing()
          .run();
        alongside();
        return true;
      });
    },

    /** The apps the household added. */
    ids(): Set<string> {
      return new Set(
        db
          .select({ appId: appsAdded.appId })
          .from(appsAdded)
          .all()
          .map((row) => row.appId),
      );
    },
  };
}

export type AddedApps = ReturnType<typeof createAddedApps>;
