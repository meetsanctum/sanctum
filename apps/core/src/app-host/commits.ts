import { randomUUID } from "node:crypto";

import { durably, type CoreDatabase } from "../database.js";
import type { Entities } from "../entities/entities.js";
import type { JobCalls, KeptWorkflowCalls } from "./host.js";
import type { InstalledApp } from "./installed.js";
import type { AppUpdates } from "./updates.js";
import type { AppVersions } from "./versions.js";

// An update's commit. After any change of version, an app that runs apart
// says again what it owns: each entity it publishes, job it schedules and
// workflow it keeps counts as a claim, even when nothing changes, right up
// to this. Listing claims nothing. Once its start has returned and its data
// is on the disk, one transaction writes the row that says it runs this
// version and removes what it didn't claim. That row is the only commit, so
// it's forced to disk. A start that fails sweeps nothing, and the next try
// claims afresh.

export type Claims = {
  entities: Set<string>;
  jobs: Set<string>;
  workflows: Set<string>;
};

/** A start on a new version, under way. */
export type AppUpdate = { id: string; claims: Claims };

export const newAppUpdate = (id: string = randomUUID()): AppUpdate => ({
  id,
  claims: { entities: new Set(), jobs: new Set(), workflows: new Set() },
});

export function createAppCommits(options: {
  db: CoreDatabase;
  versions: AppVersions;
  updates: Pick<AppUpdates, "committing" | "committed">;
  entities: Pick<Entities, "sweep">;
  jobs?: JobCalls;
  workflows?: KeptWorkflowCalls;
}) {
  const { db, versions, updates, entities, jobs, workflows } = options;
  return {
    /** Its start returned: this version is the one it runs from now on. */
    commit(entry: InstalledApp) {
      const { manifest, updating, digest, apartIn } = entry;
      const commit = { digest, folder: apartIn };
      if (!updating) {
        versions.started(manifest, commit);
        return;
      }
      const { id: appId } = manifest;
      const { claims } = updating;
      // What's held in memory or told to others waits until this has committed: if
      // it fails, the database goes back as it was, and they'd no longer match.
      const committed = durably(db, () => {
        const tellClients = entities.sweep(appId, claims.entities);
        for (const { key } of jobs?.list(appId) ?? []) {
          if (!claims.jobs.has(key)) jobs!.cancel(appId, key);
        }
        const endRuns = workflows?.sweep(appId, claims.workflows);
        versions.started(manifest, { ...commit, update: updating.id });
        const row = updates.committing(manifest);
        return () => {
          endRuns?.();
          tellClients();
          updates.committed(row, entry);
        };
      });
      entry.updating = undefined;
      committed();
    },
  };
}

export type AppCommits = ReturnType<typeof createAppCommits>;
