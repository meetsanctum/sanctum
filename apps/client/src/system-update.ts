import { productName } from "./brand";
import { CoreError, coreJson } from "./core-fetch";

// The core's System routes (apps/core/src/system/routes.ts), for every
// client: the update the manager carries out, the versions it can update
// to, and the last restore from a backup.

export type Channel = "stable" | "edge" | "dev";

export const channelNames: Record<Channel, string> = {
  stable: "Stable channel",
  edge: "Edge channel",
  dev: "Dev channel",
};

// Where an update is: downloading the new version, stopping the core to back
// up its data, starting the new core, checking it, finishing (the manager
// updates itself), or putting the previous version back.
export type UpdateStep =
  "download" | "backup" | "restart" | "check" | "finish" | "rollback" | "done";

export type UpdateInfo = {
  id: string;
  version: string;
  from: string | null;
  startedAt: string;
  finishedAt: string | null;
  step: UpdateStep;
  outcome: "updated" | "unchanged" | "rolled-back" | "failed" | null;
  error: string | null;
  log: Array<{ at: string; message: string }>;
};

export type UpdateStatus = {
  // The core's version.
  version: string;
  channel: Channel;
  // The last or current update; none before the first.
  update: UpdateInfo | null;
};

export type AvailableVersion = { version: string; builtAt?: string };

export type RestoreInfo = { restoredAt: string; backupAt: string | null };

export const systemUpdate = {
  status: () => coreJson<UpdateStatus>("/api/system/update"),
  versions: () =>
    coreJson<{ channel: Channel; versions: AvailableVersion[] }>(
      "/api/system/update/versions",
    ),
  start: (version: string) =>
    coreJson<{ update: UpdateInfo }>("/api/system/update/start", {
      method: "POST",
      json: { version },
    }),
  restore: () =>
    coreJson<{ restore: RestoreInfo | null }>("/api/system/restore"),
  dismissRestore: () =>
    coreJson<void>("/api/system/restore/dismiss", { method: "POST" }),
};

// What went wrong, in words for the person who asked.
export function problemText(error: unknown) {
  const code = error instanceof CoreError ? error.code : undefined;
  switch (code) {
    case "busy":
      return "Another update is already running.";
    case "invalid_version":
      return `${productName} cannot update to this version.`;
    default:
      return `${productName} did not answer. Try again in a moment.`;
  }
}

// An update the core or the manager cannot report on right now, because it
// is restarting as part of it: ask again soon rather than give up.
export function isAway(error: unknown) {
  return (
    !(error instanceof CoreError) ||
    error.code === "update_pending" ||
    error.code === "manager_unavailable" ||
    error.status >= 500
  );
}
