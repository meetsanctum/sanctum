import type {
  RunStatus,
  WorkflowInfo,
  WorkflowRunInfo,
} from "@meetsanctum/app-sdk";

import { productName } from "../brand";

// The words Automations uses for when things run: one word and one icon for
// each state, the same in the list and the history. Ran, Skipped, Failed,
// Next, Off, Can't run.

export type StatusKind =
  "ran" | "skipped" | "failed" | "next" | "off" | "problem";

const day = 24 * 3600_000;
const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const midnight = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** A day as people say it: today, yesterday, tomorrow, Monday, 28 Oct. */
export function dayWords(at: Date, now: Date) {
  const days = Math.round((midnight(at) - midnight(now)) / day);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (Math.abs(days) < 7) {
    return `${days < 0 ? "last " : ""}${weekdayNames[at.getDay()]}`;
  }
  if (days === 7) return `next ${weekdayNames[at.getDay()]}`;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** 07:30, in this device's time. */
export function timeWords(at: Date) {
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** A run's moment: Today at 07:30, Wednesday at 07:30. */
export function momentWords(at: Date, now: Date) {
  const words = dayWords(at, now);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} at ${timeWords(at)}`;
}

const runStatuses: Record<RunStatus, { kind: StatusKind; text: string }> = {
  succeeded: { kind: "ran", text: "Ran" },
  failed: { kind: "failed", text: "Failed" },
  partial: { kind: "failed", text: "Failed" },
  skipped: { kind: "skipped", text: "Skipped" },
  cancelled: { kind: "skipped", text: "Stopped" },
  running: { kind: "next", text: "Running" },
  queued: { kind: "next", text: "Waiting to run" },
};

/**
 * What the list says about a workflow on the right of its row: why it can't
 * run, that it's off, the home's next run, how its latest run went today,
 * when it runs next, or when it last ran.
 */
export function listStatus(
  workflow: Pick<
    WorkflowInfo,
    "problems" | "enabled" | "lastRun" | "nextRun" | "id"
  >,
  options: { now: Date; nextId?: string },
): { kind: StatusKind | null; text: string; ink?: boolean } | null {
  const { now } = options;
  if (workflow.problems.length > 0) return null;
  if (!workflow.enabled) return { kind: "off", text: "Off" };
  if (workflow.nextRun && options.nextId === workflow.id) {
    return {
      kind: "next",
      text: `Next at ${timeWords(new Date(workflow.nextRun))}`,
      ink: true,
    };
  }
  const last = workflow.lastRun;
  const lastDay = last && dayWords(new Date(last.at), now);
  const outcome = last && runStatuses[last.status];
  if (outcome?.kind === "next") return outcome;
  if (outcome && lastDay === "today")
    return { ...outcome, text: `${outcome.text} today` };
  if (workflow.nextRun) {
    const next = dayWords(new Date(workflow.nextRun), now);
    return {
      kind: null,
      text: next === "today" ? "Later today" : capitalise(next),
    };
  }
  if (outcome && lastDay)
    return {
      kind: outcome.kind === "ran" ? null : outcome.kind,
      text: `${outcome.text} ${lastDay}`,
    };
  return null;
}

/** The workflow the home runs next, for the list's one Next. */
export function nextOf(workflows: readonly WorkflowInfo[]) {
  return workflows
    .filter(
      (each) => each.enabled && each.problems.length === 0 && each.nextRun,
    )
    .sort((a, b) => a.nextRun!.localeCompare(b.nextRun!))[0];
}

const reasons: Record<string, string> = {
  conditions: "Skipped: a condition wasn't met",
  busy: "Skipped: it was still running",
  missed: `Skipped: ${productName} wasn't running then`,
  broken: "Skipped: it couldn't run",
  unreached: "Skipped: no step was reached",
  restarted: "Stopped: it started again",
  changed: "Stopped: it was changed",
};

/** A run's headline in the history and the kind of its icon. */
export function runWords(
  run: Pick<
    WorkflowRunInfo,
    "status" | "reason" | "steps" | "startedBy" | "startedOn"
  >,
  personName: (id: string) => string | undefined,
): { kind: StatusKind; text: string; by?: string } {
  const by = run.startedBy
    ? personName(run.startedBy)
    : (run.startedOn ?? undefined);
  switch (run.status) {
    case "skipped":
      return {
        kind: "skipped",
        text: reasons[run.reason ?? ""] ?? "Skipped",
      };
    case "cancelled":
      return { kind: "skipped", text: reasons[run.reason ?? ""] ?? "Stopped" };
    case "partial": {
      const steps = run.steps.filter((step) => step.kind === "step");
      const failed = steps.filter((step) => step.status === "failed").length;
      return {
        kind: "failed",
        text: `${failed} of ${steps.length} steps failed`,
      };
    }
    case "failed":
      return { kind: "failed", text: "It failed" };
    case "queued":
      return { kind: "next", text: "Waiting to run" };
    case "running":
      return { kind: "next", text: "Running" };
    default:
      return run.startedBy
        ? by
          ? { kind: "ran", text: "Run by", by }
          : { kind: "ran", text: "Run by hand" }
        : run.startedOn
          ? { kind: "ran", text: `Run on ${run.startedOn}` }
          : { kind: "ran", text: "Ran" };
  }
}

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
