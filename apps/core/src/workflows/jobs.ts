import {
  householdTiers,
  jobRequest,
  jobWhen,
  type Job,
  type JobRequest,
} from "@meetsanctum/app-sdk";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AppHost } from "../app-host/host.js";
import type { CoreDatabase } from "../database.js";
import { sameValue } from "./graph.js";
import { jobs } from "./schema.js";
import { nextDaily, nextEvery } from "./time.js";

// Apps' jobs: one of an app's own actions, with its input, at times the app
// chooses, kept in the core's database so they survive restarts. Each runs
// as the app itself, through the gate like its start hook.

export type JobRow = typeof jobs.$inferSelect;
type When = z.output<typeof jobWhen>;

/**
 * The home's days by date, with their sunrises and sunsets as ISO instants,
 * from the app that knows the sun.
 */
export type SunDays = readonly {
  date: string;
  sunrise: string | null;
  sunset: string | null;
}[];

/**
 * When a timer is next due, and for a sun time the home's date of the
 * sunrise or sunset it waits for: every day before that one has had its
 * run, so a sun time that moves never runs one day twice.
 */
export type Timer = { nextAt: Date | null; sunDay: string | null };

// Each day's sunrise or sunset, moved by an offset in minutes, soonest first.
function sunTimesOf(
  event: "sunrise" | "sunset",
  offsetMinutes: number,
  sun: SunDays | null,
) {
  return (sun ?? [])
    .flatMap((day) => {
      const at = Date.parse(day[event] ?? "") + offsetMinutes * 60_000;
      return Number.isFinite(at) ? [{ day: day.date, at }] : [];
    })
    .sort((a, b) => a.at - b.at);
}

// The date after one, both as YYYY-MM-DD.
function dayAfter(date: string) {
  return new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The first sunrise or sunset after `after`, moved by an offset in minutes,
 * on a day after `ranFor` once it has run for one.
 */
export function nextSun(
  after: Date,
  event: "sunrise" | "sunset",
  offsetMinutes: number,
  sun: SunDays | null,
  ranFor: string | null = null,
): Timer {
  const next = sunTimesOf(event, offsetMinutes, sun).find(
    (time) =>
      time.at > after.getTime() && (ranFor === null || time.day > ranFor),
  );
  if (next) {
    return { nextAt: new Date(next.at), sunDay: next.day };
  }
  // It waits for times the source does not have yet.
  return { nextAt: null, sunDay: ranFor === null ? null : dayAfter(ranFor) };
}

/**
 * Follows the sun to the time of the day a timer waits for, wherever that
 * moved: one that moved to before `at` is due, and runs or is missed by the
 * usual lateness. A due time whose day the source no longer has stays for
 * catch-up, while a source that has gone pauses the timer.
 */
export function refreshSunTimer(
  timer: Timer,
  at: Date,
  event: "sunrise" | "sunset",
  offsetMinutes: number,
  sun: SunDays | null,
): Timer {
  const times = sunTimesOf(event, offsetMinutes, sun);
  if (times.length === 0) {
    return { nextAt: null, sunDay: timer.sunDay };
  }
  const dueAt = timer.nextAt?.getTime() ?? null;
  const due = dueAt !== null && dueAt <= at.getTime();
  // Not yet tied to a day, as while no app knew the sun or for a timer from
  // before timers kept one: from now, except that a due time is for the day
  // of the nearest sun time, so that it runs once for that day.
  const waitsFor =
    timer.sunDay ??
    (due
      ? times.reduce((a, b) =>
          Math.abs(b.at - dueAt) < Math.abs(a.at - dueAt) ? b : a,
        ).day
      : null);
  if (waitsFor === null) {
    return nextSun(at, event, offsetMinutes, sun);
  }
  const next = times.find((time) => time.day >= waitsFor);
  if (next && (next.day === waitsFor || !due)) {
    return { nextAt: new Date(next.at), sunDay: next.day };
  }
  return { nextAt: due ? timer.nextAt : null, sunDay: waitsFor };
}

export type Clock = {
  now: () => Date;
  timeZone: () => string;
  sun: () => SunDays | null;
};

/**
 * When a job with `when` runs next after `after`, null while it waits; a sun
 * job's past `ranFor` once it has run for that day.
 */
export function nextRun(
  when: When,
  after: Date,
  clock: Clock,
  ranFor: string | null = null,
): Timer {
  if ("sun" in when) {
    return nextSun(after, when.sun, when.offsetMinutes, clock.sun(), ranFor);
  }
  const nextAt =
    "at" in when
      ? new Date(when.at)
      : "every" in when
        ? nextEvery(after, when.every, when.offset)
        : nextDaily(after, when.daily, clock.timeZone(), when.days);
  return { nextAt, sunDay: null };
}

function jobOf(row: JobRow): Job {
  return {
    key: row.key,
    action: row.action,
    input: row.input?.value,
    when: jobWhen.parse(row.when),
    nextAt: row.nextAt?.toISOString() ?? null,
  };
}

export function createJobs(
  db: CoreDatabase,
  options: { host: Pick<AppHost, "action">; clock: Clock },
) {
  const { host, clock } = options;

  function find(app: string, key: string) {
    return db
      .select()
      .from(jobs)
      .where(and(eq(jobs.app, app), eq(jobs.key, key)))
      .get();
  }

  return {
    /**
     * Schedules one of the app's own actions, replacing a job with the same
     * key. A request that cannot run is the app's mistake and fails it.
     */
    schedule(app: string, request: JobRequest): Job {
      const parsed = jobRequest.safeParse(request);
      if (!parsed.success) {
        throw new Error(
          `A job ${app} asked for: ${z.prettifyError(parsed.error)}`,
        );
      }
      const { key, action: actionId, input, when } = parsed.data;
      const action = host.action(app, actionId);
      if (!action) {
        throw new Error(`${app} has no action ${actionId} to schedule`);
      }
      // It runs as the app on its own, which the gate lets do the everyday
      // things only.
      if (!householdTiers.includes(action.tier)) {
        throw new Error(
          `${actionId} is ${action.tier}, so it cannot run as a job`,
        );
      }
      if (!action.input(input).success) {
        throw new Error(`The input of job ${key} does not fit ${actionId}`);
      }
      const at = clock.now();
      // Scheduled again as it was, it keeps its next run, which it may be due, and a
      // sun job the day it waits for. An app whose every start schedules its jobs
      // would otherwise push one that's due on to its next time.
      const before = find(app, key);
      const same = !parsed.data.fresh && before && sameValue(before.when, when);
      let timer: Timer;
      if (!same) {
        timer = nextRun(when, at, clock);
      } else if ("sun" in when) {
        timer = refreshSunTimer(
          before,
          at,
          when.sun,
          when.offsetMinutes,
          clock.sun(),
        );
      } else {
        timer = { nextAt: before.nextAt, sunDay: before.sunDay };
      }
      const values = {
        action: actionId,
        input: { value: input },
        when,
        ...timer,
        updatedAt: at,
      };
      db.insert(jobs)
        .values({ id: randomUUID(), app, key, createdAt: at, ...values })
        .onConflictDoUpdate({ target: [jobs.app, jobs.key], set: values })
        .run();
      return jobOf(find(app, key)!);
    },

    cancel(app: string, key: string) {
      db.delete(jobs)
        .where(and(eq(jobs.app, app), eq(jobs.key, key)))
        .run();
    },

    list(app: string): Job[] {
      return db
        .select()
        .from(jobs)
        .where(eq(jobs.app, app))
        .orderBy(asc(jobs.key))
        .all()
        .map(jobOf);
    },

    /** The jobs due by `at`, soonest first. */
    due(at: Date): JobRow[] {
      return db
        .select()
        .from(jobs)
        .where(and(isNotNull(jobs.nextAt), lte(jobs.nextAt, at)))
        .orderBy(asc(jobs.nextAt))
        .all();
    },

    /** Refreshes sun jobs when the source changes or becomes unavailable. */
    refreshSunTimers(at: Date) {
      for (const row of db.select().from(jobs).all()) {
        const when = jobWhen.parse(row.when);
        if (!("sun" in when)) continue;
        const timer = refreshSunTimer(
          row,
          at,
          when.sun,
          when.offsetMinutes,
          clock.sun(),
        );
        if (
          timer.nextAt?.getTime() !== row.nextAt?.getTime() ||
          timer.sunDay !== row.sunDay
        ) {
          db.update(jobs).set(timer).where(eq(jobs.id, row.id)).run();
        }
      }
    },

    /**
     * Moves a due job on to its next time, or removes a one-off job, before
     * it runs, so a restart never runs it twice.
     */
    advance(row: JobRow) {
      const when = jobWhen.parse(row.when);
      if ("at" in when) {
        db.delete(jobs).where(eq(jobs.id, row.id)).run();
        return;
      }
      db.update(jobs)
        .set(nextRun(when, clock.now(), clock, row.sunDay))
        .where(eq(jobs.id, row.id))
        .run();
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
