import type {
  Actor,
  EntityInfo,
  RunStatus,
  WorkflowGraph,
  WorkflowNode,
  WorkflowProblem,
} from "@meetsanctum/app-sdk";

import type { Activity } from "../activity/activity.js";
import type { AppHost } from "../app-host/host.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Devices } from "../devices/devices.js";
import type { Remote } from "../devices/holds.js";
import type { View } from "../devices/views.js";
import type { Lights } from "../devices/lights.js";
import type { Motion, MotionPlace } from "../devices/motion.js";
import type { Entities } from "../entities/entities.js";
import type {
  DeviceConditionConfig,
  DeviceStepConfig,
  EntityConditionConfig,
  LightLevelConditionConfig,
  LightsConditionConfig,
  MotionConditionConfig,
  NoMotionConditionConfig,
  LightsStepConfig,
  TimeConditionConfig,
} from "./core-pieces.js";
import { executionPlan, statePasses } from "./graph.js";
import { problemsReason, type Pieces } from "./pieces.js";
import type { Runs } from "./runs.js";
import type { RunTrigger, workflows } from "./schema.js";
import { withinTimes } from "./time.js";

// Runs workflows: run modes, dedupe and the run itself, which reaches the
// steps the fired triggers lead to through conditions that pass. Each
// condition and step calls its piece as the workflow, so the gate applies
// the tier of the action or device behind it. One an app keeps acts with the
// app's grants and sees devices as the app does (kept-grants.ts): it is
// skipped while suspended, and a node the grants no longer cover fails. A
// run that reaches a step goes to the activity log, with what started it
// and, as its cause, the press or app's action it ran within; what its steps
// do has the run as theirs.

export type WorkflowRow = typeof workflows.$inferSelect;

/**
 * What starts a run: the trigger nodes that fired, and what they saw, and
 * for a run by hand the person who pressed Run or, on a shared client, the
 * client's name.
 */
export type Firing = RunTrigger & {
  startedBy?: string;
  startedOn?: string;
  // The client a run by hand came from, for the activity log.
  startedFrom?: string;
  // The activity entry it fired within, such as a remote's press.
  causeId?: string;
};

// A workflow that starts more than this many runs within a minute has the
// rest skipped until the minute is over, which stops a workflow that
// triggers itself.
export const runsPerMinute = 30;
const dedupeKeys = 5000;

type Queued = { runId: string; workflow: WorkflowRow; firing: Firing };

// A run's activity entry, once it has one, and what it says of the run; what
// the run's steps do has it as their cause.
type RunEntry = { id?: string; detail?: Record<string, unknown> };

// Thrown inside a run that restart cancelled, before its next condition.
const stopped = new Error("cancelled");

// What a workflow an app keeps acts with: devices as the app sees them,
// why its grants refuse a node, and what they keep the whole from doing.
type Acting = {
  view: View;
  refusal: (node: WorkflowNode) => string | undefined;
  problems: () => WorkflowProblem[];
};

// The remote's press a firing saw, as the press trigger fires (firing.ts).
function pressOf({ key, data }: Firing): Remote | undefined {
  if (!key?.startsWith("press:")) return undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { device, capability, action } = data as Record<string, unknown>;
  return typeof device === "string" &&
    typeof capability === "string" &&
    typeof action === "string"
    ? { id: key.slice("press:".length), device, capability, action }
    : undefined;
}

function describe(error: unknown) {
  if (error instanceof ActionCallError) {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createEngine(options: {
  runs: Runs;
  activity?: Pick<Activity, "for" | "within" | "cause" | "update">;
  pieces: Pieces;
  // What a workflow an app keeps acts with; null for the household's.
  actingAs?: (workflow: WorkflowRow) => Acting | null;
  host: Pick<AppHost, "invoke">;
  devices: Pick<Devices, "get" | "command">;
  lights: Pick<Lights, "are" | "switch">;
  motion: Pick<Motion, "at" | "lightLevel" | "name">;
  entities: Pick<Entities, "get" | "list">;
  timeZone: () => string;
  now: () => Date;
  log: (message: string) => void;
}) {
  const { runs, pieces, host, devices, lights, motion, entities, now, log } =
    options;
  const record = options.activity?.for("workflows");
  const active = new Map<string, Set<string>>();
  const queues = new Map<string, Queued[]>();
  const cancelled = new Set<string>();
  const seen = new Set<string>();
  const started = new Map<string, number[]>();
  const working = new Set<Promise<void>>();

  const actorOf = (workflow: WorkflowRow): Actor => ({
    kind: "workflow",
    id: workflow.id,
  });

  // How one node of a workflow acts: the household's see every device and
  // entity, an app's see what the app may and fail what it may not.
  function actingOn(workflow: WorkflowRow, node: WorkflowNode): View {
    const acting = options.actingAs?.(workflow);
    const refused = acting?.refusal(node);
    if (refused) {
      throw new Error(refused);
    }
    return acting?.view ?? {};
  }

  // What keeps a workflow an app keeps from running now.
  const suspension = (workflow: WorkflowRow) =>
    options.actingAs?.(workflow)?.problems() ?? [];

  function track(work: Promise<void>) {
    working.add(work);
    void work.finally(() => working.delete(work));
  }

  function activeRuns(workflowId: string) {
    let set = active.get(workflowId);
    if (!set) {
      set = new Set();
      active.set(workflowId, set);
    }
    return set;
  }

  // Whether this firing has run the workflow before.
  function duplicate(workflowId: string, key: string | null) {
    if (!key) {
      return false;
    }
    const scoped = `${workflowId}:${key}`;
    if (seen.has(scoped)) {
      return true;
    }
    seen.add(scoped);
    if (seen.size > dedupeKeys) {
      seen.delete(seen.values().next().value!);
    }
    return false;
  }

  // Whether the workflow has started too many runs within the last minute;
  // counts this one otherwise.
  function tooOften(workflowId: string) {
    const at = now().getTime();
    const recent = (started.get(workflowId) ?? []).filter(
      (time) => at - time < 60_000,
    );
    if (recent.length >= runsPerMinute) {
      started.set(workflowId, recent);
      return true;
    }
    started.set(workflowId, [...recent, at]);
    return false;
  }

  const trigger = ({ nodes, key, data }: Firing): RunTrigger => ({
    nodes,
    key,
    data,
  });

  function skip(
    workflow: WorkflowRow,
    firing: Firing,
    reason: string,
    error?: string,
  ) {
    return runs.add({
      workflowId: workflow.id,
      version: workflow.version,
      status: "skipped",
      trigger: trigger(firing),
      startedBy: firing.startedBy,
      startedOn: firing.startedOn,
      reason,
      error,
    });
  }

  function begin(workflow: WorkflowRow, firing: Firing, runId: string) {
    activeRuns(workflow.id).add(runId);
    const entry: RunEntry = {};
    const run = () => execute(workflow, firing, runId, entry);
    track(options.activity ? options.activity.within(entry, run) : run());
  }

  // What started a run, for its entry: the first trigger that fired, with
  // what its words need.
  function triggerOf(workflow: WorkflowRow, firing: Firing) {
    const node = workflow.graph.nodes.find(
      (each) => each.id === firing.nodes[0],
    );
    const config = (node?.config ?? {}) as Record<string, unknown>;
    return {
      piece: node?.piece ?? "manual",
      app: node?.app ?? null,
      ...(node?.piece === "sun" && !node.app
        ? { event: config.event, offsetMinutes: config.offsetMinutes ?? 0 }
        : {}),
      ...(node?.piece === "time" && !node.app ? { time: config.time } : {}),
      // Motion's place by its name then, and how long it waited.
      ...((node?.piece === "motion" || node?.piece === "noMotion") && !node.app
        ? {
            place: motion.name(config.place as MotionPlace),
            ...(node.piece === "noMotion" && { forMinutes: config.forMinutes }),
          }
        : {}),
    };
  }

  // A run's entry, once its first step runs; a run whose conditions held
  // nothing back has one, a skipped run none (its run history keeps it).
  function logRun(
    workflow: WorkflowRow,
    firing: Firing,
    runId: string,
    entry: RunEntry,
  ) {
    if (!record || entry.id) return;
    entry.detail = {
      run: runId,
      trigger: triggerOf(workflow, firing),
    };
    entry.id = record({
      action: "workflow.run",
      outcome: "ok",
      personId: firing.startedBy,
      clientId: firing.startedFrom,
      clientName: firing.startedBy ? undefined : firing.startedOn,
      actor:
        firing.startedBy || firing.startedFrom
          ? undefined
          : `workflow:${workflow.id}`,
      app: workflow.app,
      subjectId: workflow.id,
      causeId: firing.causeId ?? null,
      detail: { ...entry.detail, status: "running" },
    });
  }

  function endRun(entry: RunEntry, status: RunStatus) {
    if (!entry.id || !options.activity) return;
    options.activity.update(entry.id, {
      outcome: status === "failed" || status === "partial" ? "failed" : "ok",
      detail: { ...entry.detail, status },
    });
  }

  // Ends a run, then starts the next one waiting in queued mode.
  function finish(
    workflow: WorkflowRow,
    runId: string,
    result: { status: RunStatus; reason?: string; error?: string },
    entry: RunEntry = {},
  ) {
    if (cancelled.delete(runId)) {
      // Restart already ended it as cancelled.
      endRun(entry, "cancelled");
    } else {
      runs.end(runId, workflow.id, result);
      endRun(entry, result.status);
    }
    const running = activeRuns(workflow.id);
    running.delete(runId);
    // A change from parallel to queued can leave several runs active.
    // Wait for all of them before handing the workflow to its queue.
    if (running.size > 0) {
      return;
    }
    const next = queues.get(workflow.id)?.shift();
    if (next) {
      runs.start(next.runId);
      begin(next.workflow, next.firing, next.runId);
    }
  }

  async function evaluate(
    workflow: WorkflowRow,
    node: WorkflowNode,
  ): Promise<boolean> {
    const view = actingOn(workflow, node);
    if (!node.app) {
      const config = pieces.coreConfig(node);
      if (node.piece === "time") {
        return withinTimes(
          now(),
          config as TimeConditionConfig,
          options.timeZone(),
        );
      }
      if (node.piece === "lights") {
        return lights.are(config as LightsConditionConfig, view);
      }
      if (node.piece === "motion") {
        return motion.at((config as MotionConditionConfig).place, view)
          .occupied;
      }
      if (node.piece === "noMotion") {
        const { place, forMinutes } = config as NoMotionConditionConfig;
        const { answering, occupied, quietSince } = motion.at(place, view);
        return (
          answering &&
          !occupied &&
          quietSince !== null &&
          now().getTime() - quietSince.getTime() >= forMinutes * 60_000
        );
      }
      if (node.piece === "lightLevel") {
        // The brightest sensor that answers decides; none answering fails.
        const { place, is, lux } = config as LightLevelConditionConfig;
        const level = motion.lightLevel(place, view);
        return level !== null && (is === "darker" ? level < lux : level > lux);
      }
      if (node.piece === "entity") {
        // One entity by its app and key, or any of a type that passes.
        const { type, app, key, ...predicate } =
          config as EntityConditionConfig;
        const candidates: (EntityInfo | null)[] =
          app !== undefined && key !== undefined
            ? [entities.get(app, key)]
            : entities.list({ type });
        return candidates.some(
          (entity) =>
            entity !== null &&
            (type === undefined || entity.type === type) &&
            statePasses(predicate, entity.state),
        );
      }
      const { device, capability, ...predicate } =
        config as DeviceConditionConfig;
      const found = devices.get(device, view);
      const state = (
        capability
          ? found?.capabilities.find((each) => each.id === capability)
          : found?.capabilities[0]
      )?.state;
      return state !== undefined && statePasses(predicate, state);
    }
    const output = await host.invoke({
      actor: actorOf(workflow),
      appId: node.app,
      actionId: node.piece,
      input: node.config,
    });
    return output === true;
  }

  async function act(
    workflow: WorkflowRow,
    node: WorkflowNode,
    firing: Firing,
  ) {
    const view = actingOn(workflow, node);
    if (!node.app) {
      const config = pieces.coreConfig(node);
      // The core's own steps: no app sent them, the workflow is behind them.
      // The lights step follows the remote's press that ran it, if any.
      if (node.piece === "lights") {
        return lights.switch(
          actorOf(workflow),
          config as LightsStepConfig,
          view,
          pressOf(firing),
        );
      }
      const { device, capability, command } = config as DeviceStepConfig;
      const done = await devices.command(
        actorOf(workflow),
        { device, capability, command },
        view,
        null,
      );
      return { device, capability, sync: done.sync };
    }
    return host.invoke({
      actor: actorOf(workflow),
      appId: node.app,
      actionId: node.piece,
      input: node.config,
    });
  }

  // One run: each step the fired triggers reach runs when a path of
  // conditions to it passes. A condition is checked once at most; steps run
  // one after another, and one that fails does not stop the others.
  async function execute(
    workflow: WorkflowRow,
    firing: Firing,
    runId: string,
    entry: RunEntry,
  ) {
    const graph: WorkflowGraph = workflow.graph;
    let position = 0;
    let ran = 0;
    let failed = 0;
    try {
      // A queued run may have lost a piece while it waited. Check the
      // whole graph before any of its conditions or steps can run.
      const { problems } = pieces.check(graph);
      if (problems.length > 0) {
        finish(
          workflow,
          runId,
          {
            status: "skipped",
            reason: "broken",
            error: problemsReason(problems),
          },
          entry,
        );
        return;
      }
      const suspended = suspension(workflow);
      if (suspended.length > 0) {
        finish(
          workflow,
          runId,
          {
            status: "skipped",
            reason: "suspended",
            error: problemsReason(suspended),
          },
          entry,
        );
        return;
      }
      const plan = executionPlan(graph, new Set(firing.nodes));
      if (plan.length === 0) {
        finish(
          workflow,
          runId,
          { status: "skipped", reason: "unreached" },
          entry,
        );
        return;
      }
      const checked = new Map<string, boolean>();
      const isCancelled = () => cancelled.has(runId);
      const check = async (node: WorkflowNode) => {
        const known = checked.get(node.id);
        if (known !== undefined) {
          return known;
        }
        if (isCancelled()) {
          throw stopped;
        }
        const step = runs.addStep(runId, position++, node, node.config);
        let result = false;
        try {
          result = await evaluate(workflow, node);
          runs.endStep(step, {
            status: result ? "succeeded" : "skipped",
            output: result,
          });
        } catch (error) {
          runs.endStep(step, { status: "failed", error: describe(error) });
        }
        checked.set(node.id, result);
        return result;
      };

      for (const { step, reached } of plan) {
        if (!(await reached(check))) {
          continue;
        }
        if (isCancelled()) {
          return finish(workflow, runId, { status: "cancelled" }, entry);
        }
        logRun(workflow, firing, runId, entry);
        const row = runs.addStep(runId, position++, step, step.config);
        ran++;
        try {
          const output = await act(workflow, step, firing);
          runs.endStep(row, { status: "succeeded", output });
        } catch (error) {
          failed++;
          runs.endStep(row, { status: "failed", error: describe(error) });
        }
      }
      finish(
        workflow,
        runId,
        ran === 0
          ? { status: "skipped", reason: "conditions" }
          : {
              status:
                failed === 0
                  ? "succeeded"
                  : failed === ran
                    ? "failed"
                    : "partial",
            },
        entry,
      );
    } catch (error) {
      if (error === stopped) {
        return finish(workflow, runId, { status: "cancelled" }, entry);
      }
      log(`workflows: a run of ${workflow.id} failed (${describe(error)})`);
      finish(
        workflow,
        runId,
        {
          status: "failed",
          reason: "error",
          error: describe(error),
        },
        entry,
      );
    }
  }

  return {
    /**
     * Starts, queues or skips a run of a workflow for a firing, by its run
     * mode. It records the run before it returns and runs it after; a
     * firing it has seen before does nothing.
     */
    fire(workflow: WorkflowRow, fired: Firing): string | undefined {
      if (duplicate(workflow.id, fired.key)) {
        return undefined;
      }
      const firing = {
        ...fired,
        causeId: fired.causeId ?? options.activity?.cause(),
      };
      const { problems } = pieces.check(workflow.graph);
      if (problems.length > 0) {
        return skip(workflow, firing, "broken", problemsReason(problems));
      }
      const suspended = suspension(workflow);
      if (suspended.length > 0) {
        return skip(workflow, firing, "suspended", problemsReason(suspended));
      }
      const running = activeRuns(workflow.id);
      if (workflow.runMode === "single" && running.size > 0) {
        return skip(workflow, firing, "busy");
      }
      // A press comes from someone at a remote, never from a step, so it
      // cannot loop: tapping a dimmer down step by step is not too often.
      if (!pressOf(firing) && tooOften(workflow.id)) {
        return skip(workflow, firing, "too_often");
      }
      if (workflow.runMode === "queued" && running.size > 0) {
        const runId = runs.add({
          workflowId: workflow.id,
          version: workflow.version,
          status: "queued",
          trigger: trigger(firing),
          startedBy: firing.startedBy,
          startedOn: firing.startedOn,
        });
        queues.set(workflow.id, [
          ...(queues.get(workflow.id) ?? []),
          { runId, workflow, firing },
        ]);
        return runId;
      }
      if (workflow.runMode === "restart") {
        // The running runs end now; each stops before its next condition
        // or step, and lets a call it is making finish.
        for (const runId of running) {
          cancelled.add(runId);
          runs.end(runId, workflow.id, {
            status: "cancelled",
            reason: "restarted",
          });
        }
        running.clear();
      }
      const runId = runs.add({
        workflowId: workflow.id,
        version: workflow.version,
        status: "running",
        trigger: trigger(firing),
        startedBy: firing.startedBy,
        startedOn: firing.startedOn,
      });
      begin(workflow, firing, runId);
      return runId;
    },

    /** Records a run skipped for a reason the caller found, such as a missed time. */
    skip,

    /**
     * Ends the runs of a workflow that's going. Each stops before its next condition
     * or step, and lets a call it is making finish, rather than carry on against
     * records that are gone.
     */
    cancelRuns(workflowId: string) {
      for (const runId of activeRuns(workflowId)) cancelled.add(runId);
    },

    /** Drops what waits for a workflow that changed or went. */
    forget(workflowId: string) {
      for (const queued of queues.get(workflowId) ?? []) {
        runs.end(queued.runId, workflowId, {
          status: "cancelled",
          reason: "changed",
        });
      }
      queues.delete(workflowId);
    },

    /** Resolves once every run started so far, and those they started, has ended. */
    async settled() {
      while (working.size > 0) {
        await Promise.allSettled([...working]);
      }
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
