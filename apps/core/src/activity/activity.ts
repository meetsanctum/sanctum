import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { CoreDatabase } from "../database.js";
import { activityTimes as times, kindOf } from "./kinds.js";
import { activity, kinds, type Kind } from "./schema.js";

// Writes and reads the activity log. A write inside a transaction is part of
// it, so a change and its entry commit or roll back together; live clients
// hear of an entry once it has committed. What runs within a press, a
// workflow run or an app's action has that entry as its cause, so a light a
// press turned on says so.

export type ActivityEntry = typeof activity.$inferSelect;
// The person, none on a shared client, and the client behind a change made
// through a module's routes.
export type ChangedBy = { personId?: string; clientId: string };
export type NewActivityEntry = Omit<
  typeof activity.$inferInsert,
  "id" | "at" | "source" | "kind" | "count" | "firstAt"
> & {
  // Given when what it causes runs before it is written.
  id?: string;
  // Given when it happened elsewhere, as the manager's audit did.
  at?: Date;
};

// Entries written in the same millisecond keep the order they were written
// in.
const rowid = sql<number>`rowid`;

// When an entry joins the one before it about the same subject: by the
// same who, from the same cause, both ok, within `withinMs`, and when
// `matches` says the one before is like it. `detail` says what the joined
// entry keeps.
export type Joining = {
  withinMs: number;
  matches: (previous: ActivityEntry) => boolean;
  detail?: (
    previous: ActivityEntry["detail"],
    next: ActivityEntry["detail"],
  ) => ActivityEntry["detail"];
};

// The entry behind what runs now. A run learns its own once its first step
// runs, so it holds a box it fills then.
type Cause = { id?: string };
const causes = new AsyncLocalStorage<Cause>();

export type ActivityQuery = {
  subjectId?: string;
  kind?: Kind;
  // An entry's id: those older than it.
  before?: string;
  limit: number;
};

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null) === (b ?? null);

export function createActivity(
  db: CoreDatabase,
  options: {
    now?: () => Date;
    // For tests: how many entries the log keeps at most, and how many it
    // writes between prunes.
    atMost?: number;
    pruneEvery?: number;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const atMost = options.atMost ?? times.atMost;
  const pruneEvery = options.pruneEvery ?? times.pruneEvery;
  let written = 0;
  let clientName: ((id: string) => string | undefined) | undefined;
  let listener: ((entry: ActivityEntry) => void) | undefined;
  let pending: Set<string> | undefined;
  let timer: NodeJS.Timeout | undefined;

  // Entries from before kinds get theirs.
  db.transaction(() => {
    for (const row of db
      .select({
        id: activity.id,
        source: activity.source,
        action: activity.action,
        actor: activity.actor,
      })
      .from(activity)
      .where(isNull(activity.kind))
      .all()) {
      db.update(activity)
        .set({ kind: kindOf(row) })
        .where(eq(activity.id, row.id))
        .run();
    }
    // A run the core stopped during never ended: it did not finish.
    db.update(activity)
      .set({
        outcome: "failed",
        reason: "interrupted",
        detail: sql`json_set(${activity.detail}, '$.status', 'failed')`,
      })
      .where(
        and(
          eq(activity.action, "workflow.run"),
          sql`json_extract(${activity.detail}, '$.status') = 'running'`,
        ),
      )
      .run();
  });

  function get(id: string): ActivityEntry | null {
    return db.select().from(activity).where(eq(activity.id, id)).get() ?? null;
  }

  // Tells the listener once whatever transaction wrote it is over, and only
  // if it committed.
  function publish(id: string) {
    if (!listener) return;
    if (pending) {
      pending.add(id);
      return;
    }
    pending = new Set([id]);
    setImmediate(() => {
      const ids = pending!;
      pending = undefined;
      // A core that stopped meanwhile has no one to tell.
      if (!db.$client.open) return;
      for (const each of ids) {
        const entry = get(each);
        if (entry) listener?.(entry);
      }
    });
  }

  function latestAbout(subjectId: string) {
    return db
      .select()
      .from(activity)
      .where(eq(activity.subjectId, subjectId))
      .orderBy(desc(activity.at), desc(rowid))
      .limit(1)
      .get();
  }

  function latestOf(action: string) {
    return db
      .select()
      .from(activity)
      .where(eq(activity.action, action))
      .orderBy(desc(activity.at), desc(rowid))
      .limit(1)
      .get();
  }

  // Takes out what is past keeping, then the oldest past the most kept,
  // devices' first.
  function prune() {
    const at = now().getTime();
    db.transaction(() => {
      for (const kind of kinds) {
        db.delete(activity)
          .where(
            and(
              eq(activity.kind, kind),
              lt(activity.at, new Date(at - times.keptMs[kind])),
            ),
          )
          .run();
      }
      for (const kind of ["devices", undefined] as const) {
        const total = db.select({ n: count() }).from(activity).get()!.n;
        const excess = total - atMost;
        if (excess <= 0) return;
        db.delete(activity)
          .where(
            inArray(
              activity.id,
              db
                .select({ id: activity.id })
                .from(activity)
                .where(kind ? eq(activity.kind, kind) : undefined)
                .orderBy(asc(activity.at), asc(rowid))
                .limit(excess),
            ),
          )
          .run();
      }
    });
  }

  function write(source: string, entry: NewActivityEntry, joining?: Joining) {
    const at = entry.at ?? now();
    const causeId = entry.causeId ?? causes.getStore()?.id ?? null;
    const named =
      entry.clientName ??
      (entry.clientId && !entry.personId
        ? clientName?.(entry.clientId)
        : undefined) ??
      null;
    if (joining && entry.outcome === "ok") {
      const previous = entry.subjectId
        ? latestAbout(entry.subjectId)
        : latestOf(entry.action);
      if (
        previous &&
        previous.source === source &&
        previous.action === entry.action &&
        previous.outcome === "ok" &&
        same(previous.subjectId, entry.subjectId) &&
        same(previous.personId, entry.personId) &&
        same(previous.clientId, entry.clientId) &&
        same(previous.actor, entry.actor) &&
        same(previous.app, entry.app) &&
        same(previous.causeId, causeId) &&
        at.getTime() - previous.at.getTime() <= joining.withinMs &&
        joining.matches(previous)
      ) {
        db.update(activity)
          .set({
            at,
            count: previous.count + 1,
            firstAt: previous.firstAt ?? previous.at,
            detail: joining.detail
              ? joining.detail(previous.detail, entry.detail ?? null)
              : (entry.detail ?? null),
          })
          .where(eq(activity.id, previous.id))
          .run();
        publish(previous.id);
        return previous.id;
      }
    }
    const id = entry.id ?? randomUUID();
    db.insert(activity)
      .values({
        ...entry,
        id,
        at,
        source,
        kind: kindOf({ source, ...entry }),
        causeId,
        clientName: named,
      })
      .run();
    publish(id);
    // A log written to without end is pruned between the daily prunes too.
    if (++written % pruneEvery === 0) prune();
    return id;
  }

  return {
    // A writer for one module or app; it answers the entry's id, or the
    // id of the entry it joined.
    for(source: string) {
      return (entry: NewActivityEntry, joining?: Joining) =>
        write(source, entry, joining);
    },

    // Changes an entry, as when a run ends or a device did not answer.
    update(
      id: string,
      changes: Partial<Pick<ActivityEntry, "outcome" | "reason" | "detail">>,
    ) {
      db.update(activity).set(changes).where(eq(activity.id, id)).run();
      publish(id);
    },

    /** Runs `work` with `cause` behind what it writes; a box filled later counts from then. */
    within<T>(cause: string | Cause, work: () => T): T {
      return causes.run(
        typeof cause === "string" ? { id: cause } : cause,
        work,
      );
    },

    /** The entry behind what runs now, if any. */
    cause(): string | undefined {
      return causes.getStore()?.id;
    },

    get,

    /** Newest first, `limit` at most, and whether there are more. */
    page(query: ActivityQuery): { entries: ActivityEntry[]; more: boolean } {
      const conditions: (SQL | undefined)[] = [
        ne(activity.action, "sanctum.stop"),
      ];
      if (query.subjectId)
        conditions.push(eq(activity.subjectId, query.subjectId));
      if (query.kind) conditions.push(eq(activity.kind, query.kind));
      const anchor = query.before
        ? db
            .select({ at: activity.at, rowid })
            .from(activity)
            .where(eq(activity.id, query.before))
            .get()
        : undefined;
      if (anchor) {
        conditions.push(
          or(
            lt(activity.at, anchor.at),
            and(eq(activity.at, anchor.at), lt(rowid, anchor.rowid)),
          ),
        );
      }
      const rows = db
        .select()
        .from(activity)
        .where(and(...conditions))
        .orderBy(desc(activity.at), desc(rowid))
        .limit(query.limit + 1)
        .all();
      return {
        entries: rows.slice(0, query.limit),
        more: rows.length > query.limit,
      };
    },

    /** What something was called, from the newest entry about it that says, as its removal does. */
    nameThen(subjectId: string): string | null {
      const row = db
        .select({
          name: sql<string>`json_extract(${activity.detail}, '$.name')`,
        })
        .from(activity)
        .where(
          and(
            eq(activity.subjectId, subjectId),
            sql`json_extract(${activity.detail}, '$.name') is not null`,
          ),
        )
        .orderBy(desc(activity.at))
        .limit(1)
        .get();
      return row ? String(row.name) : null;
    },

    /** The entries these caused, directly. */
    causedBy(ids: readonly string[]): ActivityEntry[] {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(activity)
        .where(inArray(activity.causeId, [...ids]))
        .all();
    },

    recent(limit = 100): ActivityEntry[] {
      return db
        .select()
        .from(activity)
        .orderBy(desc(activity.at), desc(rowid))
        .limit(limit)
        .all();
    },

    prune,

    /**
     * Records that Sanctum started, and when it stopped if it said so, then
     * prunes now and once a day; tests prune by hand.
     */
    start(version: string, startOptions: { ticking?: boolean } = {}) {
      const started = latestOf("sanctum.start");
      const stopped = latestOf("sanctum.stop");
      const stoppedAt =
        stopped && (!started || stopped.at > started.at) ? stopped.at : null;
      write("sanctum", {
        action: "sanctum.start",
        outcome: "ok",
        actor: "sanctum",
        detail: {
          version,
          stoppedAt: stoppedAt?.toISOString() ?? null,
          // It started before and never said it stopped: a power cut or a
          // crash.
          unexpected: started !== undefined && stoppedAt === null,
        },
      });
      if (startOptions.ticking === false) return;
      prune();
      timer = setInterval(prune, times.pruneMs);
      timer.unref();
    },

    /** Records that Sanctum is stopping, which only the next start shows. */
    stop() {
      clearInterval(timer);
      write("sanctum", {
        action: "sanctum.stop",
        outcome: "ok",
        actor: "sanctum",
      });
    },

    /** Names a shared client's entries after it, as it is named then. */
    nameClients(names: (id: string) => string | undefined) {
      clientName = names;
    },

    /** Hears each entry once it has committed, and again when it changes. */
    follow(listen: (entry: ActivityEntry) => void) {
      listener = listen;
    },
  };
}

export type Activity = ReturnType<typeof createActivity>;
export type RecordActivity = ReturnType<Activity["for"]>;
