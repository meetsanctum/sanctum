import { and, eq } from "drizzle-orm";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { WorkflowRow } from "./engine.js";
import type { Pieces } from "./pieces.js";
import { jobs, workflows, workflowsOffForApps } from "./schema.js";

// What removing an app, and adding it back, does to workflows. The workflows
// and jobs the app keeps go with it: an app publishes all it keeps as it
// starts, so adding it back brings them back. The household's workflows that
// use its pieces, or name the devices it brings, turn off, and each is
// recorded with when it was last changed; adding the app back turns on
// those nobody changed since and that have nothing missing.

export function createWorkflowsForApps(options: {
  db: CoreDatabase;
  rows: () => WorkflowRow[];
  named: Pieces["named"];
  // What a workflow is missing or gets wrong now (pieces.ts).
  problems: (row: WorkflowRow) => readonly unknown[];
  record: RecordActivity;
  // Ends a workflow's runs under way and queued (engine.ts).
  endRuns: (workflowId: string) => void;
  now: () => Date;
}) {
  const { db, record } = options;

  // The household's workflows that use the app: a node of its own, or a
  // device it brings named by one of its pieces' schemas.
  function using(app: string, deviceIds: readonly string[]) {
    return options.rows().filter((row) => {
      if (row.app !== null) return false;
      if (row.graph.nodes.some((node) => node.app === app)) return true;
      return options
        .named(row.graph)
        .some((each) => each.kind === "device" && deviceIds.includes(each.id));
    });
  }

  return {
    /** The household's workflows that use the app, by name, for its Remove dialog. */
    using(app: string, deviceIds: readonly string[]) {
      return using(app, deviceIds)
        .map(({ id, name, enabled }) => ({ id, name, enabled }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    /**
     * For an app's removal, in the caller's transaction: removes the
     * workflows and jobs it keeps, and turns off the household's that use
     * it. Answers what ends their runs once that has committed.
     */
    removing(app: string, deviceIds: readonly string[]) {
      const kept = options.rows().filter((row) => row.app === app);
      for (const workflow of kept) {
        db.delete(workflows).where(eq(workflows.id, workflow.id)).run();
        record({
          action: "workflow.remove",
          outcome: "ok",
          actor: `app:${app}`,
          subjectId: workflow.id,
          detail: { name: workflow.name },
        });
      }
      db.delete(jobs).where(eq(jobs.app, app)).run();
      const turnedOff = using(app, deviceIds).filter((row) => row.enabled);
      const at = options.now();
      for (const workflow of turnedOff) {
        db.update(workflows)
          .set({ enabled: false, updatedAt: at })
          .where(eq(workflows.id, workflow.id))
          .run();
        db.insert(workflowsOffForApps)
          .values({ workflowId: workflow.id, app, updatedAt: at })
          .onConflictDoUpdate({
            target: [workflowsOffForApps.workflowId, workflowsOffForApps.app],
            set: { updatedAt: at },
          })
          .run();
      }
      return () => {
        for (const { id } of [...kept, ...turnedOff]) options.endRuns(id);
      };
    },

    /**
     * For an app added back, once it's installed: turns on the workflows its
     * removal turned off that nobody changed since and that miss nothing
     * now, and forgets the rest. Answers the names of those turned on.
     */
    added(app: string): string[] {
      const records = db
        .select()
        .from(workflowsOffForApps)
        .where(eq(workflowsOffForApps.app, app))
        .all();
      const byId = new Map(options.rows().map((row) => [row.id, row]));
      const on: string[] = [];
      db.transaction(() => {
        for (const off of records) {
          const workflow = byId.get(off.workflowId);
          if (
            workflow &&
            !workflow.enabled &&
            workflow.updatedAt.getTime() === off.updatedAt.getTime() &&
            options.problems(workflow).length === 0
          ) {
            db.update(workflows)
              .set({ enabled: true, updatedAt: options.now() })
              .where(eq(workflows.id, workflow.id))
              .run();
            on.push(workflow.name);
          }
          db.delete(workflowsOffForApps)
            .where(
              and(
                eq(workflowsOffForApps.workflowId, off.workflowId),
                eq(workflowsOffForApps.app, app),
              ),
            )
            .run();
        }
      });
      return on.sort((a, b) => a.localeCompare(b));
    },
  };
}

export type WorkflowsForApps = ReturnType<typeof createWorkflowsForApps>;
