import { join } from "node:path";

import { readJson, writeJson } from "../state.js";

// The journal is the one record of an update. Every step is written before it
// runs, so whichever process starts next (the manager after a crash, or the
// updater container after a reboot) can finish or undo it.

export type StepStatus =
  | "pending"
  | "skipped"
  | "stopping"
  | "backing-up"
  | "swapping"
  | "checking"
  | "committing"
  | "updated"
  | "rolling-back"
  | "restored"
  | "rolled-back";

export type UpdateStep = {
  status: StepStatus;
  // The image the update installs, and what it resolved to once pulled.
  image: string;
  imageId?: string;
  version?: string;
  fromImageId?: string;
  fromVersion?: string;
  // The container the update replaces, kept until it commits.
  previousContainerId?: string;
  // The core's data snapshot, taken with the core stopped.
  backup?: string;
  // How often the manager restarted a lost updater container.
  attempts?: number;
};

export type UpdateOutcome = "updated" | "unchanged" | "rolled-back" | "failed";

export type UpdateJournal = {
  id: string;
  version: string;
  startedAt: string;
  finishedAt?: string;
  phase: "pulling" | "core" | "manager" | "done";
  outcome?: UpdateOutcome;
  error?: string;
  core: UpdateStep;
  manager: UpdateStep;
  log: Array<{ at: string; message: string }>;
};

export function createJournalStore(dataDir: string) {
  const path = join(dataDir, "update.json");
  return {
    read: () => readJson<UpdateJournal>(path),
    save: (journal: UpdateJournal) => writeJson(path, journal),
  };
}

export type JournalStore = ReturnType<typeof createJournalStore>;

export function isFinished(journal: UpdateJournal | null) {
  return journal === null || journal.phase === "done";
}

// Records progress in the journal and the container log in one go.
export async function note(
  store: JournalStore,
  journal: UpdateJournal,
  message: string,
  log: (message: string) => void,
) {
  journal.log.push({ at: new Date().toISOString(), message });
  log(`update ${journal.id}: ${message}`);
  await store.save(journal);
}

export async function finish(
  store: JournalStore,
  journal: UpdateJournal,
  outcome: UpdateOutcome,
  message: string,
  log: (message: string) => void,
) {
  journal.phase = "done";
  journal.outcome = outcome;
  journal.finishedAt = new Date().toISOString();
  await note(store, journal, message, log);
}
