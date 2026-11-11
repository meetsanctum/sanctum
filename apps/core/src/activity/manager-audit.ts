import { and, desc, eq, like } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import type { Activity } from "./activity.js";
import { activity as entries, type Outcome } from "./schema.js";

// The manager's audit in the activity log. The manager does things while the
// core is stopped or by itself, such as finishing an update or starting a
// service again, and keeps them in its own numbered audit. Only the core
// talks to the manager, so the core asks it for what is new when it starts,
// a minute later, once the manager that an update replaces has handed over,
// and every 5 minutes, and copies each entry once, as
// manager:<audit>:<number>. A new audit, as on a new host, is copied from
// its start.

export type ManagerAuditEntry = {
  n: number;
  at: string;
  action: string;
  outcome: Outcome;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
};

/** What the manager answers: its audit's id and the entries after a number. */
export type ManagerAudit = { audit: string; entries: ManagerAuditEntry[] };

const copyMs = 5 * 60_000;
// After an update the core starts before the manager has handed over.
const againMs = 60_000;

export function createManagerAuditCopy(options: {
  db: CoreDatabase;
  activity: Activity;
  audit: (after: number) => Promise<ManagerAudit>;
  log: (message: string) => void;
}) {
  const { db, activity, log } = options;
  const record = activity.for("manager");
  let timers: NodeJS.Timeout[] = [];
  let copying: Promise<void> | undefined;
  let failing = false;

  // The newest entry copied: its audit and number.
  function last() {
    const row = db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.source, "manager"), like(entries.id, "manager:%")))
      .orderBy(desc(entries.at), desc(entries.id))
      .limit(1)
      .get();
    const [, audit, n] = row?.id.split(":") ?? [];
    return audit && n ? { audit, n: Number(n) } : null;
  }

  async function copyOnce() {
    const was = last();
    let answer = await options.audit(was?.n ?? 0);
    if (was && answer.audit !== was.audit) {
      answer = await options.audit(0);
    }
    for (const entry of answer.entries) {
      const id = `manager:${answer.audit}:${entry.n}`;
      if (activity.get(id)) continue;
      record({
        id,
        at: new Date(entry.at),
        action: entry.action,
        outcome: entry.outcome,
        reason: entry.reason ?? null,
        actor: "sanctum",
        detail: entry.detail ?? null,
      });
    }
  }

  // One copy at a time; one that fails says so once until one succeeds.
  function copy() {
    copying ??= copyOnce()
      .then(() => {
        failing = false;
      })
      .catch((error: unknown) => {
        if (!failing) {
          log(
            `activity: the manager's audit was not copied (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        failing = true;
      })
      .finally(() => {
        copying = undefined;
      });
    return copying;
  }

  return {
    copy,
    start() {
      void copy();
      timers = [
        setTimeout(() => void copy(), againMs),
        setInterval(() => void copy(), copyMs),
      ];
      for (const timer of timers) timer.unref();
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    },
  };
}
