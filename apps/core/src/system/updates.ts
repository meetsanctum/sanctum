import type { ChangedBy, RecordActivity } from "../activity/activity.js";
import type { Channel, UpdateJournal, VersionList } from "../manager.js";
import { relay, SystemError } from "./errors.js";

// Updates from Settings → System. The manager carries them out (pull, back
// up, swap, check, roll back); the core passes someone's request on over
// its socket and reports the manager's progress back. Clients never reach
// the manager themselves.

export type UpdateManager = {
  updateStatus(): Promise<{ channel: Channel; update: UpdateJournal | null }>;
  updateVersions(): Promise<VersionList>;
  startUpdate(version?: string): Promise<UpdateJournal>;
};

// Where an update is, as Settings shows it: downloading the new version,
// stopping the core to back up its data, starting the new core, checking it,
// finishing (the manager updates itself), or putting the previous version
// back.
export type UpdateStep =
  "download" | "backup" | "restart" | "check" | "finish" | "rollback" | "done";

export type UpdateInfo = {
  id: string;
  version: string;
  // The core's version before, once the update has replaced it.
  from: string | null;
  startedAt: string;
  finishedAt: string | null;
  step: UpdateStep;
  outcome: "updated" | "unchanged" | "rolled-back" | "failed" | null;
  // Why it rolled back or failed.
  error: string | null;
  log: Array<{ at: string; message: string }>;
};

function stepOf(journal: UpdateJournal): UpdateStep {
  switch (journal.phase) {
    case "done":
      return "done";
    case "pulling":
      return "download";
    case "manager":
      return "finish";
  }
  switch (journal.core.status) {
    case "pending":
    case "stopping":
    case "backing-up":
      return "backup";
    case "swapping":
      return "restart";
    case "checking":
    case "committing":
      return "check";
    case "rolling-back":
    case "restored":
    case "rolled-back":
      return "rollback";
    default:
      return "finish";
  }
}

export function updateInfo(journal: UpdateJournal): UpdateInfo {
  return {
    id: journal.id,
    version: journal.version,
    from: journal.core.fromVersion ?? null,
    startedAt: journal.startedAt,
    finishedAt: journal.finishedAt ?? null,
    step: stepOf(journal),
    outcome: journal.outcome ?? null,
    error: journal.error ?? null,
    log: journal.log,
  };
}

export function createUpdates(options: {
  manager: UpdateManager;
  // The core's own version, which an update replaces.
  version: string;
  record: RecordActivity;
}) {
  const { manager, record } = options;

  return {
    async status() {
      const { channel, update } = await relay(() => manager.updateStatus());
      return {
        version: options.version,
        channel,
        update: update ? updateInfo(update) : null,
      };
    },

    versions: () => relay(() => manager.updateVersions()),

    // Every start goes in the activity log, with the version asked for and
    // how the manager answered.
    async start(by: ChangedBy, version?: string) {
      try {
        const update = await relay(() => manager.startUpdate(version));
        record({
          action: "update.start",
          outcome: "ok",
          ...by,
          subjectId: update.version,
        });
        return updateInfo(update);
      } catch (error) {
        if (error instanceof SystemError) {
          record({
            action: "update.start",
            outcome: "refused",
            reason: error.code,
            ...by,
            subjectId: version,
          });
        }
        throw error;
      }
    },
  };
}

export type Updates = ReturnType<typeof createUpdates>;
