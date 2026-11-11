import type {
  RunStatus,
  StepStatus,
  WorkflowInfo,
  WorkflowNode,
  WorkflowRunInfo,
} from "@meetsanctum/app-sdk";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { CoreDatabase } from "../database.js";
import { workflowRunSteps, workflowRuns, type RunTrigger } from "./schema.js";

// A workflow's run history: each run, and each condition and step it
// reached, with what went in and came out. A workflow keeps its latest runs
// only, as v1 showed them.

export const keptRuns = 50;

// Newest first: by when each was recorded, then in the order it was, for
// runs recorded within the same millisecond.
const newestFirst = [desc(workflowRuns.queuedAt), desc(sql`rowid`)];

type RunRow = typeof workflowRuns.$inferSelect;
type LastRun = NonNullable<WorkflowInfo["lastRun"]>;
type StepRow = typeof workflowRunSteps.$inferSelect;

function stepInfo(row: StepRow): WorkflowRunInfo["steps"][number] {
  return {
    node: row.node,
    kind: row.kind,
    app: row.app,
    piece: row.piece,
    status: row.status,
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

function runInfo(row: RunRow, steps: StepRow[]): WorkflowRunInfo {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    status: row.status,
    trigger: row.trigger,
    startedBy: row.startedBy,
    startedOn: row.startedOn,
    reason: row.reason,
    error: row.error,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    steps: steps.map(stepInfo),
  };
}

export function createRuns(db: CoreDatabase, now: () => Date) {
  // Deletes a workflow's runs beyond the latest ones.
  function prune(workflowId: string) {
    const latest = db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId))
      .orderBy(...newestFirst)
      .limit(keptRuns)
      .all()
      .map(({ id }) => id);
    db.delete(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowId, workflowId),
          notInArray(workflowRuns.id, latest),
          notInArray(workflowRuns.status, ["running", "queued"]),
        ),
      )
      .run();
  }

  return {
    /** Records a run as it starts, waits or is skipped. */
    add(run: {
      workflowId: string;
      version: number;
      status: Extract<RunStatus, "running" | "queued" | "skipped">;
      trigger: RunTrigger;
      startedBy?: string;
      startedOn?: string;
      reason?: string;
      error?: string;
    }): string {
      const id = randomUUID();
      const at = now();
      db.insert(workflowRuns)
        .values({
          id,
          workflowId: run.workflowId,
          version: run.version,
          status: run.status,
          trigger: run.trigger,
          startedBy: run.startedBy ?? null,
          startedOn: run.startedOn ?? null,
          reason: run.reason ?? null,
          error: run.error ?? null,
          queuedAt: at,
          startedAt: run.status === "running" ? at : null,
          endedAt: run.status === "skipped" ? at : null,
        })
        .run();
      if (run.status === "skipped") {
        prune(run.workflowId);
      }
      return id;
    },

    /** A queued run starts. */
    start(id: string) {
      db.update(workflowRuns)
        .set({ status: "running", startedAt: now() })
        .where(eq(workflowRuns.id, id))
        .run();
    },

    /** A run ends, and the oldest runs beyond the kept ones go. */
    end(
      id: string,
      workflowId: string,
      result: { status: RunStatus; reason?: string; error?: string },
    ) {
      db.update(workflowRuns)
        .set({
          status: result.status,
          reason: result.reason ?? null,
          error: result.error ?? null,
          endedAt: now(),
        })
        .where(eq(workflowRuns.id, id))
        .run();
      prune(workflowId);
    },

    /** Records a condition or step as the run reaches it. */
    addStep(
      runId: string,
      position: number,
      node: WorkflowNode,
      input: unknown,
    ): string {
      const id = randomUUID();
      db.insert(workflowRunSteps)
        .values({
          id,
          runId,
          position,
          node: node.id,
          kind: node.kind === "condition" ? "condition" : "step",
          app: node.app ?? null,
          piece: node.piece,
          status: "running",
          input: input ?? null,
          startedAt: now(),
        })
        .run();
      return id;
    },

    endStep(
      id: string,
      result: { status: StepStatus; output?: unknown; error?: string },
    ) {
      db.update(workflowRunSteps)
        .set({
          status: result.status,
          output: result.output ?? null,
          error: result.error ?? null,
          endedAt: now(),
        })
        .where(eq(workflowRunSteps.id, id))
        .run();
    },

    /**
     * Ends the runs the core was running or holding when it stopped. Steps
     * are not all safe to repeat, so none runs again.
     */
    interrupted() {
      const at = now();
      const open = db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(inArray(workflowRuns.status, ["running", "queued"]))
        .all()
        .map(({ id }) => id);
      if (open.length === 0) {
        return 0;
      }
      db.transaction((tx) => {
        tx.update(workflowRuns)
          .set({ status: "failed", reason: "interrupted", endedAt: at })
          .where(inArray(workflowRuns.id, open))
          .run();
        tx.update(workflowRunSteps)
          .set({ status: "failed", error: "interrupted", endedAt: at })
          .where(
            and(
              inArray(workflowRunSteps.runId, open),
              eq(workflowRunSteps.status, "running"),
            ),
          )
          .run();
      });
      return open.length;
    },

    /**
     * Each workflow's newest run, by its workflow, as its list shows it:
     * when it ended, or else started or was queued. One query, however
     * many workflows there are.
     */
    latest(workflowId?: string): Map<string, LastRun> {
      const ranked = db
        .select({
          id: workflowRuns.id,
          workflowId: workflowRuns.workflowId,
          status: workflowRuns.status,
          queuedAt: workflowRuns.queuedAt,
          startedAt: workflowRuns.startedAt,
          endedAt: workflowRuns.endedAt,
          // Newest first within each workflow, as newestFirst orders them.
          rank: sql<number>`row_number() over (
            partition by ${workflowRuns.workflowId}
            order by ${workflowRuns.queuedAt} desc, rowid desc
          )`.as("rank"),
        })
        .from(workflowRuns)
        .where(
          workflowId === undefined
            ? undefined
            : eq(workflowRuns.workflowId, workflowId),
        )
        .as("ranked");
      return new Map(
        db
          .select()
          .from(ranked)
          .where(eq(ranked.rank, 1))
          .all()
          .map((row) => [
            row.workflowId,
            {
              id: row.id,
              status: row.status,
              at: (row.endedAt ?? row.startedAt ?? row.queuedAt).toISOString(),
            },
          ]),
      );
    },

    /** A workflow's latest runs, newest first, with their steps. */
    list(workflowId: string): WorkflowRunInfo[] {
      const rows = db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowId, workflowId))
        .orderBy(...newestFirst)
        .limit(keptRuns)
        .all();
      const steps = rows.length
        ? db
            .select()
            .from(workflowRunSteps)
            .where(
              inArray(
                workflowRunSteps.runId,
                rows.map((row) => row.id),
              ),
            )
            .orderBy(asc(workflowRunSteps.position))
            .all()
        : [];
      return rows.map((row) =>
        runInfo(
          row,
          steps.filter((step) => step.runId === row.id),
        ),
      );
    },

    get(id: string): WorkflowRunInfo | undefined {
      const row = db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, id))
        .get();
      if (!row) {
        return undefined;
      }
      const steps = db
        .select()
        .from(workflowRunSteps)
        .where(eq(workflowRunSteps.runId, id))
        .orderBy(asc(workflowRunSteps.position))
        .all();
      return runInfo(row, steps);
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
