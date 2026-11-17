import { durably, type CoreDatabase } from "../database.js";
import { appsAdded, appsListed, appsOff, appVersions } from "./schema.js";

// The home's own list of apps (schema.ts): those the household added, which
// the core installs, and no others. A home that didn't keep one ran every app
// its image shipped and the manager staged, so its first start with the list
// records them all, with every app the core's database knows ran or was
// turned off, whether or not it runs now. That's one transaction with the row
// that says the home keeps the list: a start cut short records them again,
// and a later start never does, even once the household has removed every
// app. A start that knows of no app at all, as when the manager didn't
// answer in a development stack, leaves it for the next. A core rolled back
// to before the list doesn't read it, and installs every app staged, as it
// did before.

export function createAddedApps(
  db: CoreDatabase,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const listed = () => db.select().from(appsListed).get() !== undefined;

  return {
    /** Whether the home keeps its list, so what it holds is all it has. */
    listed,

    /**
     * On a home that keeps no list yet, records these apps as added, with
     * those the database knows, and that it keeps the list from now on.
     * Whether it did.
     */
    recordFirst(appIds: Iterable<string>) {
      return durably(db, () => {
        if (listed()) return false;
        const at = now();
        const known = [
          ...db.select({ appId: appVersions.appId }).from(appVersions).all(),
          ...db.select({ appId: appsOff.appId }).from(appsOff).all(),
        ].map((row) => row.appId);
        const had = new Set([...appIds, ...known]);
        if (had.size === 0) return false;
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
