import type { WorkflowGraph, WorkflowNode } from "@meetsanctum/app-sdk";
import { and, eq, isNotNull, lte, min } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import type { Motion, PlaceMotion } from "../devices/motion.js";
import type {
  NoMotionTriggerConfig,
  SunTriggerConfig,
  TimeTriggerConfig,
} from "./core-pieces.js";
import type { Engine, Firing, WorkflowRow } from "./engine.js";
import { sameValue } from "./graph.js";
import { nextSun, refreshSunTimer, type SunDays, type Timer } from "./jobs.js";
import type { Pieces } from "./pieces.js";
import { workflowTimers, workflows } from "./schema.js";
import { nextDaily } from "./time.js";

// Workflows' timers: when each time and sun trigger of a workflow is next
// due, and when a no-motion trigger's place will have been quiet long
// enough. Saving a workflow sets them from now, and each moves on before the
// run it starts, so a restart never runs it twice. A no-motion timer is set
// as its place goes quiet, cleared as it has motion again, and fires once
// per quiet spell, if the place is still quiet when it is due.

// A missed time runs when the core is back if it is at most this late, as
// after an update; an older one is skipped. Apps' jobs keep the same.
export const lateness = 15 * 60_000;

const timed = (node: WorkflowNode) =>
  node.kind === "trigger" &&
  !node.app &&
  (node.piece === "time" || node.piece === "sun" || node.piece === "noMotion");

/**
 * When a place that has been quiet since then will have been quiet for so
 * many minutes, if that is still to come after `after`: nothing past is
 * caught up, and a place with motion, or with no sensor answering, waits.
 */
export function quietDue(
  motion: PlaceMotion,
  minutes: number,
  after: Date,
): Date | null {
  if (!motion.answering || motion.occupied || !motion.quietSince) return null;
  const due = new Date(motion.quietSince.getTime() + minutes * 60_000);
  return due > after ? due : null;
}

export function createTimers(
  db: CoreDatabase,
  options: {
    pieces: Pick<Pieces, "find" | "parse" | "coreConfig">;
    engine: Pick<Engine, "fire" | "skip">;
    clock: {
      now: () => Date;
      timeZone: () => string;
      sun: () => SunDays | null;
    };
    // Whether a workflow's triggers may start it now: one an app keeps
    // waits while not.
    mayRun: (workflow: typeof workflows.$inferSelect) => boolean;
    // Motion in a place, which no-motion triggers wait on.
    motion: Pick<Motion, "at">;
  },
) {
  const { pieces, engine, clock, motion } = options;

  const one = (timer: { workflowId: string; node: string }) =>
    and(
      eq(workflowTimers.workflowId, timer.workflowId),
      eq(workflowTimers.node, timer.node),
    );

  // When a time or sun trigger is next due after `after`, null while it
  // waits for sun times; a sun trigger's past `ranFor` once it has run for
  // that day.
  function nextFor(
    node: WorkflowNode,
    after: Date,
    ranFor: string | null = null,
  ): Timer {
    if (node.piece === "noMotion") {
      const { place, forMinutes } = pieces.coreConfig(
        node,
      ) as NoMotionTriggerConfig;
      return {
        nextAt: quietDue(motion.at(place), forMinutes, after),
        sunDay: null,
      };
    }
    if (node.piece === "time") {
      const { time, days } = pieces.coreConfig(node) as TimeTriggerConfig;
      return {
        nextAt: nextDaily(after, time, clock.timeZone(), days),
        sunDay: null,
      };
    }
    const { event, offsetMinutes } = pieces.coreConfig(
      node,
    ) as SunTriggerConfig;
    return nextSun(after, event, offsetMinutes, clock.sun(), ranFor);
  }

  // Whether a no-motion trigger's place has been quiet as long as it asks.
  function quietLongEnough(node: WorkflowNode, at: Date) {
    const { place, forMinutes } = pieces.coreConfig(
      node,
    ) as NoMotionTriggerConfig;
    const now = motion.at(place);
    return (
      now.answering &&
      !now.occupied &&
      now.quietSince !== null &&
      at.getTime() - now.quietSince.getTime() >= forMinutes * 60_000
    );
  }

  return {
    /**
     * A workflow's timers, set from now: nothing past is caught up. A sun
     * trigger left as it was in the graph `before` keeps its timer, and
     * with it the day it waits for, so saving never runs one sunset twice.
     */
    set(workflow: WorkflowRow, before?: WorkflowGraph) {
      const kept = new Map(
        db
          .select()
          .from(workflowTimers)
          .where(eq(workflowTimers.workflowId, workflow.id))
          .all()
          .map((timer) => [timer.node, timer]),
      );
      db.delete(workflowTimers)
        .where(eq(workflowTimers.workflowId, workflow.id))
        .run();
      for (const node of workflow.graph.nodes.filter(timed)) {
        const timer = kept.get(node.id);
        const previous = before?.nodes.find(
          (each) => each.id === node.id && timed(each) && each.piece === "sun",
        );
        // Compared as parsed, an omitted offset and an explicit zero
        // describe the same timer.
        const config = pieces.parse<SunTriggerConfig>(node);
        const hasSameSunTrigger =
          node.piece === "sun" &&
          timer !== undefined &&
          previous !== undefined &&
          config !== undefined &&
          sameValue(pieces.parse(previous), config);
        db.insert(workflowTimers)
          .values({
            workflowId: workflow.id,
            node: node.id,
            ...(hasSameSunTrigger
              ? { nextAt: timer.nextAt, sunDay: timer.sunDay }
              : nextFor(node, clock.now())),
          })
          .run();
      }
    },

    /**
     * A no-motion trigger's place changed: its timer is set for when the
     * place will have been quiet long enough, or cleared while it has
     * motion. A workflow without the timer, as one saved before, gets it.
     */
    quiet(
      workflow: WorkflowRow,
      node: WorkflowNode,
      place: PlaceMotion,
      minutes: number,
    ) {
      const timer = {
        workflowId: workflow.id,
        node: node.id,
        nextAt: quietDue(place, minutes, clock.now()),
        sunDay: null,
      };
      db.insert(workflowTimers)
        .values(timer)
        .onConflictDoUpdate({
          target: [workflowTimers.workflowId, workflowTimers.node],
          set: { nextAt: timer.nextAt },
        })
        .run();
    },

    /**
     * When each workflow's time and sun triggers next start it: the
     * earliest of its timers, by its workflow, in one query.
     */
    next(workflowId?: string): Map<string, Date | null> {
      return new Map(
        db
          .select({
            workflowId: workflowTimers.workflowId,
            nextAt: min(workflowTimers.nextAt),
          })
          .from(workflowTimers)
          .where(
            and(
              isNotNull(workflowTimers.nextAt),
              workflowId === undefined
                ? undefined
                : eq(workflowTimers.workflowId, workflowId),
            ),
          )
          .groupBy(workflowTimers.workflowId)
          .all()
          .map((row) => [row.workflowId, row.nextAt]),
      );
    },

    /**
     * Fires due time and sun triggers: each moves on before its run
     * starts, so a restart never runs it twice. One missed by more than
     * `lateness` is skipped.
     */
    fire(at: Date) {
      // Sun timers follow their source to the time of the day they wait
      // for (refreshSunTimer).
      for (const timer of db.select().from(workflowTimers).all()) {
        const node = db
          .select()
          .from(workflows)
          .where(eq(workflows.id, timer.workflowId))
          .get()
          ?.graph.nodes.find((each) => each.id === timer.node);
        if (!node || node.app || node.piece !== "sun") continue;
        const config = pieces.parse<SunTriggerConfig>(node);
        if (!config) continue;
        const next = refreshSunTimer(
          timer,
          at,
          config.event,
          config.offsetMinutes,
          clock.sun(),
        );
        if (
          next.nextAt?.getTime() !== timer.nextAt?.getTime() ||
          next.sunDay !== timer.sunDay
        ) {
          db.update(workflowTimers).set(next).where(one(timer)).run();
        }
      }
      const due = db
        .select()
        .from(workflowTimers)
        .where(
          and(isNotNull(workflowTimers.nextAt), lte(workflowTimers.nextAt, at)),
        )
        .all();
      for (const timer of due) {
        const workflow = db
          .select()
          .from(workflows)
          .where(eq(workflows.id, timer.workflowId))
          .get();
        const node = workflow?.graph.nodes.find(
          (each) => each.id === timer.node,
        );
        if (!workflow || !node || !pieces.find(node)) {
          db.delete(workflowTimers).where(one(timer)).run();
          continue;
        }
        // One an app keeps waits for it, as its jobs do, rather than be used up
        // while it restarts.
        if (workflow.enabled && !options.mayRun(workflow)) {
          continue;
        }
        const dueAt = timer.nextAt!;
        const next = nextFor(node, at, timer.sunDay);
        db.update(workflowTimers).set(next).where(one(timer)).run();
        // A place that had motion again, or whose sensors stopped
        // answering, is not quiet: its timer waits for the next quiet
        // spell, or is due later now.
        if (node.piece === "noMotion" && !quietLongEnough(node, at)) {
          continue;
        }
        if (!workflow.enabled) {
          continue;
        }
        const firing: Firing = {
          nodes: [node.id],
          key: `${node.piece}:${node.id}:${dueAt.toISOString()}`,
          data: { due: dueAt.toISOString() },
        };
        if (at.getTime() - dueAt.getTime() > lateness) {
          engine.skip(workflow, firing, "missed");
        } else {
          engine.fire(workflow, firing);
        }
      }
    },
  };
}

export type Timers = ReturnType<typeof createTimers>;
