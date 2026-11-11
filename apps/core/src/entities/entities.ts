import type { EntityInfo } from "@meetsanctum/app-sdk";
import { and, eq, notInArray, type SQL } from "drizzle-orm";

import type { DeclaredEntityType } from "../app-host/contract.js";
import type { CoreDatabase } from "../database.js";
import { entities } from "./schema.js";

// The Entities module: the latest state of everything installed apps bring
// to the home, by app and key. The app host checks each publication against
// the app's declared types before it gets here; every client and app reads
// them, by app or type.

type Row = typeof entities.$inferSelect;

// One entity changed: published, changed or gone.
export type EntityChange = {
  app: string;
  key: string;
  before: EntityInfo | null;
  after: EntityInfo | null;
};

const kept = (row: Row): EntityInfo => ({
  app: row.appId,
  key: row.key,
  type: row.type,
  name: row.name,
  state: row.state,
  updatedAt: row.updatedAt.toISOString(),
});

export function createEntities(
  db: CoreDatabase,
  options: {
    // Called after a change has committed, so live clients can follow.
    onChange?: (change: EntityChange) => void;
    now?: () => Date;
  } = {},
) {
  const now = options.now ?? (() => new Date());

  function get(appId: string, key: string) {
    const row = db
      .select()
      .from(entities)
      .where(and(eq(entities.appId, appId), eq(entities.key, key)))
      .get();
    return row ? kept(row) : null;
  }

  // Removes the rows that match, telling live clients of each.
  function removeWhere(where: SQL | undefined) {
    const gone = db.delete(entities).where(where).returning().all();
    for (const row of gone) {
      options.onChange?.({
        app: row.appId,
        key: row.key,
        before: kept(row),
        after: null,
      });
    }
  }

  // Keeps the latest state of one of an app's entities. An unchanged
  // publication changes nothing, so apps may publish as often as they
  // check.
  function publish(
    appId: string,
    entity: { type: string; key: string; name: string; state: unknown },
  ) {
    const before = get(appId, entity.key);
    if (
      before &&
      before.type === entity.type &&
      before.name === entity.name &&
      JSON.stringify(before.state) === JSON.stringify(entity.state)
    ) {
      return;
    }
    const values = {
      type: entity.type,
      name: entity.name,
      state: entity.state,
      updatedAt: now(),
    };
    db.insert(entities)
      .values({ appId, key: entity.key, ...values })
      .onConflictDoUpdate({
        target: [entities.appId, entities.key],
        set: values,
      })
      .run();
    options.onChange?.({
      app: appId,
      key: entity.key,
      before,
      after: get(appId, entity.key),
    });
  }

  function remove(appId: string, key: string) {
    removeWhere(and(eq(entities.appId, appId), eq(entities.key, key)));
  }

  // By app or type, in a stable order.
  function list(filter: { app?: string; type?: string } = {}) {
    return db
      .select()
      .from(entities)
      .where(
        and(
          filter.app === undefined ? undefined : eq(entities.appId, filter.app),
          filter.type === undefined
            ? undefined
            : eq(entities.type, filter.type),
        ),
      )
      .all()
      .map(kept)
      .sort(
        (a, b) =>
          a.app.localeCompare(b.app) ||
          a.name.localeCompare(b.name) ||
          a.key.localeCompare(b.key),
      );
  }

  return {
    get,
    publish,
    remove,
    list,

    // An installed app's kept entities, checked again against the types of
    // the version installed now, before anyone reads them: an entity of a
    // type it no longer declares, or that no longer fits its type, goes.
    // The app may not publish again soon, as while its service is offline. A
    // broken schema says nothing of an entity, so that one stays.
    reconcileTypes(appId: string, types: Iterable<DeclaredEntityType>) {
      const declared = new Map([...types].map((type) => [type.id, type]));
      for (const entity of list({ app: appId })) {
        const type = declared.get(entity.type);
        const state = type?.state(entity.state);
        if (!type || (state && !state.success && !state.broken)) {
          remove(appId, entity.key);
        } else if (state?.success) {
          publish(appId, { ...entity, state: state.data });
        }
      }
    },

    /**
     * Removes an app's entities but those it claimed, for an update's commit.
     * This runs inside its transaction, so what it answers tells live clients, once
     * that has committed.
     */
    sweep(appId: string, claimed: ReadonlySet<string>) {
      const gone = db
        .delete(entities)
        .where(
          and(
            eq(entities.appId, appId),
            claimed.size ? notInArray(entities.key, [...claimed]) : undefined,
          ),
        )
        .returning()
        .all();
      return () => {
        for (const row of gone) {
          options.onChange?.({
            app: row.appId,
            key: row.key,
            before: kept(row),
            after: null,
          });
        }
      };
    },

    // Entities go with their app.
    removeApp(appId: string) {
      removeWhere(eq(entities.appId, appId));
    },

    // The core starts with these apps: the entities of any other go.
    keepApps(appIds: readonly string[]) {
      removeWhere(
        appIds.length ? notInArray(entities.appId, [...appIds]) : undefined,
      );
    },
  };
}

export type Entities = ReturnType<typeof createEntities>;
