import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { readJson, writeJson } from "./state.js";
import type { UpdateJournal } from "./update/journal.js";

// The manager's audit: what it did on its own or while the core was stopped,
// which the household sees in the activity log. The manager keeps it in its
// data volume, numbered, its last 1,000 entries; only the core reads it, over
// the socket, and copies what is new (GET /api/audit?after=<n>). It records
// how each update ended, a service starting, stopping, starting again or
// unable to start, and the Zigbee adapter chosen. Docker's steps stay in the
// manager's console log: they mean nothing to a household and say nothing the
// outcome does not.

export type AuditEntry = {
  n: number;
  at: string;
  action: string;
  outcome: "ok" | "failed";
  reason?: string;
  detail?: Record<string, unknown>;
};

type AuditFile = {
  // A new audit, as on a new host, starts from 1 again; the core copies it
  // afresh by its id.
  id: string;
  next: number;
  // The update whose end it last recorded.
  update?: string;
  entries: AuditEntry[];
};

const keep = 1_000;

export async function createAudit(
  dataDir: string,
  options: { now?: () => Date; log?: (message: string) => void } = {},
) {
  const now = options.now ?? (() => new Date());
  const path = join(dataDir, "audit.json");
  const file: AuditFile = (await readJson<AuditFile>(path)) ?? {
    id: randomUUID(),
    next: 1,
    entries: [],
  };
  // One write at a time, and one waiting at most: what records meanwhile
  // goes with the next.
  let saving: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | undefined;

  function save() {
    waiting ??= saving = saving.then(async () => {
      waiting = undefined;
      try {
        await writeJson(path, file);
      } catch (error) {
        options.log?.(
          `audit: not saved (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    });
    return waiting;
  }

  // An entry, when it happened if that was earlier than now.
  function record(entry: Omit<AuditEntry, "n" | "at">, at = now()) {
    file.entries.push({ n: file.next++, at: at.toISOString(), ...entry });
    if (file.entries.length > keep) {
      file.entries.splice(0, file.entries.length - keep);
    }
    return save();
  }

  return {
    record,

    /** Its id and the entries after `n`, oldest first. */
    after(n: number) {
      return {
        audit: file.id,
        entries: file.entries.filter((entry) => entry.n > n),
      };
    },

    /** Records how the last update ended, once, when it ended. */
    async updateEnded(journal: UpdateJournal | null) {
      if (!journal?.outcome || journal.phase !== "done") return;
      if (file.update === journal.id) return;
      file.update = journal.id;
      await record(
        {
          action: "update.end",
          outcome:
            journal.outcome === "updated" || journal.outcome === "unchanged"
              ? "ok"
              : "failed",
          ...(journal.error ? { reason: journal.error } : {}),
          detail: {
            id: journal.id,
            version: journal.version,
            from: journal.core.fromVersion ?? null,
            outcome: journal.outcome,
            startedAt: journal.startedAt,
            finishedAt: journal.finishedAt ?? null,
          },
        },
        journal.finishedAt ? new Date(journal.finishedAt) : now(),
      );
    },

    /** Resolves once what was recorded has been saved. */
    saved: () => saving,
  };
}

export type Audit = Awaited<ReturnType<typeof createAudit>>;

type ServiceState = {
  state: "off" | "starting" | "running" | "waiting" | "failed";
  problem?: string;
  restarts?: number;
};

/**
 * What a service's change says in the audit, if anything: one seen for the
 * first time is news only when it is not running.
 */
export function serviceChange(
  name: string,
  before: ServiceState | undefined,
  after: ServiceState,
): Omit<AuditEntry, "n" | "at"> | null {
  const detail = (extra: Record<string, unknown> = {}) => ({
    service: name,
    ...extra,
  });
  if (after.state === "running") {
    if (!before) return null;
    if (before.state === "running") {
      return (after.restarts ?? 0) > (before.restarts ?? 0)
        ? {
            action: "service.restart",
            outcome: "ok",
            detail: detail({ restarts: after.restarts }),
          }
        : null;
    }
    return {
      action: before.state === "failed" ? "service.restart" : "service.start",
      outcome: "ok",
      detail: detail(),
    };
  }
  if (after.state === "off") {
    return before && before.state !== "off"
      ? { action: "service.stop", outcome: "ok", detail: detail() }
      : null;
  }
  if (after.state === "waiting" || after.state === "failed") {
    if (before?.state === after.state && before.problem === after.problem) {
      return null;
    }
    return {
      action: after.state === "waiting" ? "service.wait" : "service.fail",
      outcome: "failed",
      ...(after.problem ? { reason: after.problem } : {}),
      detail: detail({ problem: after.problem ?? null }),
    };
  }
  return null;
}
