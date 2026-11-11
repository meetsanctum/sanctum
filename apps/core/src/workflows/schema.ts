import type {
  JobWhen,
  PieceKind,
  RunMode,
  RunStatus,
  StepStatus,
  WorkflowGraph,
} from "@meetsanctum/app-sdk";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Workflows: the household's rules, their timers and their runs, and the
// jobs apps schedule for themselves. Workflows outlive the people who made
// them and the apps whose pieces they use, so nothing here references People
// or an app.

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    runMode: text("run_mode").$type<RunMode>().notNull(),
    graph: text("graph", { mode: "json" }).$type<WorkflowGraph>().notNull(),
    // Raised whenever the graph changes; each run names the one it ran.
    version: integer("version").notNull(),
    // The person who made it, or the app that keeps it by its own key.
    createdBy: text("created_by"),
    app: text("app"),
    appKey: text("app_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("workflows_app_key").on(table.app, table.appKey)],
);

// When each time or sun trigger of a workflow is next due; null while it
// waits, as for sun times no app provides.
export const workflowTimers = sqliteTable(
  "workflow_timers",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    node: text("node").notNull(),
    nextAt: integer("next_at", { mode: "timestamp_ms" }),
    // For a sun trigger, the home's date of the sunrise or sunset it waits
    // for: the days before it have had their run, however their times move.
    sunDay: text("sun_day"),
  },
  (table) => [
    primaryKey({ columns: [table.workflowId, table.node] }),
    index("workflow_timers_next_at").on(table.nextAt),
  ],
);

export type RunTrigger = { nodes: string[]; key: string | null; data: unknown };

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    trigger: text("trigger", { mode: "json" }).$type<RunTrigger>().notNull(),
    // The person who pressed Run.
    startedBy: text("started_by"),
    // Or, when it was pressed on a shared client, that client's name as it
    // was then.
    startedOn: text("started_on"),
    // Why it was skipped, cancelled or failed, as a code such as busy, and
    // what went wrong in words.
    reason: text("reason"),
    error: text("error"),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("workflow_runs_workflow").on(table.workflowId, table.queuedAt),
  ],
);

export const workflowRunSteps = sqliteTable(
  "workflow_run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    node: text("node").notNull(),
    kind: text("kind").$type<Exclude<PieceKind, "trigger">>().notNull(),
    app: text("app"),
    piece: text("piece").notNull(),
    status: text("status").$type<StepStatus>().notNull(),
    input: text("input", { mode: "json" }).$type<unknown>(),
    output: text("output", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("workflow_run_steps_run").on(table.runId, table.position)],
);

// Apps' jobs: one of the app's own actions, with its input, at the times
// `when` names.
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    app: text("app").notNull(),
    key: text("key").notNull(),
    action: text("action").notNull(),
    // An envelope preserves the difference between JSON null and omitted
    // input: JSON drops an undefined value but keeps an explicit null.
    input: text("input", { mode: "json" }).$type<{ value?: unknown }>(),
    when: text("when", { mode: "json" }).$type<JobWhen>().notNull(),
    // Null while it waits, as for sun times no app provides.
    nextAt: integer("next_at", { mode: "timestamp_ms" }),
    // A sun job's day, as a sun trigger's.
    sunDay: text("sun_day"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("jobs_app_key").on(table.app, table.key),
    index("jobs_next_at").on(table.nextAt),
  ],
);
