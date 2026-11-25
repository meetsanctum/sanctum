import type { WorkflowGraph, WorkflowNode } from "@meetsanctum/app-sdk";
import { localParts } from "@meetsanctum/app-sdk/clock";
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
import { workflowClock, workflowTimers, workflows } from "./schema.js";
import { calendarDay, nextDailyOccurrence } from "./time.js";

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
  if (!motion.answering || motion.motion || !motion.quietSince) return null;
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
  const clockRow = eq(workflowClock.id, 1);
  const readZone = db.select().from(workflowClock).where(clockRow).prepare();

  const one = (timer: { workflowId: string; node: string }) =>
    and(
      eq(workflowTimers.workflowId, timer.workflowId),
      eq(workflowTimers.node, timer.node),
    );

  function advanceTime(
    node: WorkflowNode,
    at: Date,
    timer: typeof workflowTimers.$inferSelect,
    dueAt: Date,
  ) {
    const lastDailyDay =
      timer.nextDailyDay ?? calendarDay(localParts(dueAt, clock.timeZone()));
    return { ...nextFor(node, at, null, lastDailyDay), lastDailyDay };
  }

  // When a time or sun trigger is next due after `after`, null while it
  // waits for sun times; a sun trigger's past `ranFor` once it has run for
  // that day.
  function nextFor(
    node: WorkflowNode,
    after: Date,
    ranFor: string | null = null,
    lastDailyDay: number | null = null,
  ): Timer & { nextDailyDay?: number } {
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
        ...nextDailyOccurrence(
          after,
          time,
          clock.timeZone(),
          days,
          lastDailyDay,
        ),
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
      !now.motion &&
      now.quietSince !== null &&
      at.getTime() - now.quietSince.getTime() >= forMinutes * 60_000
    );
  }

  function refresh(
    piece: "noMotion" | "time",
    at: Date,
    previousZone?: string,
  ) {
    for (const timer of db.select().from(workflowTimers).all()) {
      const due = timer.nextAt && timer.nextAt <= at ? timer.nextAt : null;
      if (due && (piece !== "time" || timer.nextDailyDay !== null)) continue;
      const node = db
        .select()
        .from(workflows)
        .where(eq(workflows.id, timer.workflowId))
        .get()
        ?.graph.nodes.find((each) => each.id === timer.node);
      if (node?.piece !== piece || node.app || !pieces.find(node)) continue;
      if (due) {
        // A timer saved without its calendar date still belongs to its old zone.
        const nextDailyDay = calendarDay(
          localParts(due, previousZone ?? clock.timeZone()),
        );
        db.update(workflowTimers).set({ nextDailyDay }).where(one(timer)).run();
        continue;
      }
      const next = nextFor(node, at, null, timer.lastDailyDay);
      if (
        next.nextAt?.getTime() !== timer.nextAt?.getTime() ||
        (piece === "time" && next.nextDailyDay !== timer.nextDailyDay)
      ) {
        db.update(workflowTimers).set(next).where(one(timer)).run();
      }
    }
  }

  return {
    /**
     * A workflow's timers, set from now: nothing past is caught up. A sun
     * trigger left as it was in the graph `before` keeps its timer, and
     * with it the day it waits for. An unchanged time trigger keeps the last
     * date it handled.
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
          (each) =>
            each.id === node.id && timed(each) && each.piece === node.piece,
        );
        // Compared as parsed, an omitted offset and an explicit zero
        // describe the same timer.
        const config = pieces.parse(node);
        const sameTrigger =
          previous !== undefined &&
          config !== undefined &&
          sameValue(pieces.parse(previous), config);
        const lastDailyDay = sameTrigger ? (timer?.lastDailyDay ?? null) : null;
        const next =
          node.piece === "sun" && sameTrigger && timer
            ? { nextAt: timer.nextAt, sunDay: timer.sunDay }
            : nextFor(node, clock.now(), null, lastDailyDay);
        db.insert(workflowTimers)
          .values({
            workflowId: workflow.id,
            node: node.id,
            lastDailyDay,
            ...next,
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
     * Every no-motion trigger's timer as its place is now, as workflows
     * start: while they were held, they heard none of a place's changes.
     * One that's due stays, for the tick to run or skip.
     */
    followQuiet() {
      refresh("noMotion", clock.now());
    },

    /**
     * Every time trigger's timer as the home's clock now reads, as the
     * home's time zone changes: 07:30 is the new zone's 07:30. One that's
     * due at the change stays, for the tick to run or skip. The saved zone
     * moves with the timers so a failure leaves the change eligible for retry.
     */
    followZone(at: Date, previousZone?: string) {
      const zone = clock.timeZone();
      const saved = readZone.get()?.timeZone;
      if (saved === zone && previousZone === undefined) return;
      db.transaction(() => {
        const scheduledZone = saved ?? previousZone;
        if (scheduledZone !== zone) {
          refresh("time", at, scheduledZone);
        }
        db.insert(workflowClock)
          .values({ id: 1, timeZone: zone })
          .onConflictDoUpdate({
            target: workflowClock.id,
            set: { timeZone: zone },
          })
          .run();
      });
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
        const next =
          node.piece === "time"
            ? advanceTime(node, at, timer, dueAt)
            : nextFor(node, at, timer.sunDay);
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
