import type {
  Availability,
  HistoryField,
  HistoryPeriod,
} from "@meetsanctum/app-sdk";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import {
  historyCompiled,
  historySeries,
  historyStates,
  historyStatistics,
} from "./schema.js";
import {
  combine,
  rollUps,
  samplesOf,
  type Recorded,
  type Rollup,
} from "./statistics.js";
import { floorTime, historyTimes as times } from "./time.js";

// History's roll-ups in the database: each period's made once it has ended,
// from the changes recorded, and what is past keeping taken out.

const periodMs: Record<HistoryPeriod, number> = {
  "5m": times.fiveMinutesMs,
  hour: times.hourMs,
};

export function createRollups(db: CoreDatabase) {
  function compiledThrough(period: HistoryPeriod): number | null {
    return (
      db
        .select({ through: historyCompiled.through })
        .from(historyCompiled)
        .where(eq(historyCompiled.period, period))
        .get()
        ?.through.getTime() ?? null
    );
  }

  function setCompiled(period: HistoryPeriod, through: number) {
    db.insert(historyCompiled)
      .values({ period, through: new Date(through) })
      .onConflictDoUpdate({
        target: historyCompiled.period,
        set: { through: new Date(through) },
      })
      .run();
  }

  // Where a period's roll-ups begin when none has been made: at the first
  // change recorded, or now when there is none.
  function firstPeriod(period: HistoryPeriod, end: number) {
    const first = db
      .select({ at: historyStates.at })
      .from(historyStates)
      .orderBy(asc(historyStates.at))
      .limit(1)
      .get();
    return first ? floorTime(first.at.getTime(), periodMs[period]) : end;
  }

  function writeRollup(
    seriesId: number,
    period: HistoryPeriod,
    start: number,
    field: HistoryField,
    rollup: Rollup,
  ) {
    const values = {
      seriesId,
      period,
      start: new Date(start),
      field,
      ...rollup,
    };
    db.insert(historyStatistics)
      .values(values)
      .onConflictDoUpdate({
        target: [
          historyStatistics.seriesId,
          historyStatistics.period,
          historyStatistics.start,
          historyStatistics.field,
        ],
        set: rollup,
      })
      .run();
  }

  // The 5-minute roll-ups of every series from `from` until `to`, both on
  // the 5 minutes: what each was before `from` carries in.
  function compileFiveMinutes(from: number, to: number) {
    const carried = db.all<{
      seriesId: number;
      at: number;
      availability: Availability;
      state: string | null;
    }>(sql`
      select series_id as seriesId, at, availability, state from (
        select series_id, at, availability, state,
          row_number() over (partition by series_id order by at desc, id desc) as n
        from ${historyStates} where at < ${from}
      ) where n = 1`);
    const rows = db
      .select()
      .from(historyStates)
      .where(
        and(
          gte(historyStates.at, new Date(from)),
          lt(historyStates.at, new Date(to)),
        ),
      )
      .orderBy(asc(historyStates.at), asc(historyStates.id))
      .all();
    const bySeries = new Map<number, (Recorded & { at: number })[]>();
    for (const row of carried) {
      bySeries.set(row.seriesId, [
        {
          at: row.at,
          availability: row.availability,
          state: row.state === null ? null : JSON.parse(row.state),
        },
      ]);
    }
    for (const row of rows) {
      const states = bySeries.get(row.seriesId) ?? [];
      states.push({
        at: row.at.getTime(),
        availability: row.availability,
        state: row.state ?? null,
      });
      bySeries.set(row.seriesId, states);
    }
    const kinds = new Map(
      db
        .select({ id: historySeries.id, kind: historySeries.kind })
        .from(historySeries)
        .all()
        .map((row) => [row.id, row.kind]),
    );
    for (const [seriesId, states] of bySeries) {
      const kind = kinds.get(seriesId);
      if (!kind) continue;
      for (const [field, samples] of samplesOf(kind, states)) {
        for (const [start, rollup] of rollUps(
          samples,
          from,
          to,
          times.fiveMinutesMs,
        )) {
          writeRollup(seriesId, "5m", start, field, rollup);
        }
      }
    }
  }

  // Each hour from `from` until `to` from its 5 minutes.
  function compileHours(from: number, to: number) {
    const rows = db
      .select()
      .from(historyStatistics)
      .where(
        and(
          eq(historyStatistics.period, "5m"),
          gte(historyStatistics.start, new Date(from)),
          lt(historyStatistics.start, new Date(to)),
        ),
      )
      .all();
    const hours = new Map<string, Rollup[]>();
    for (const row of rows) {
      const hour = floorTime(row.start.getTime(), times.hourMs);
      const key = `${row.seriesId}/${row.field}/${hour}`;
      hours.set(key, [...(hours.get(key) ?? []), row]);
    }
    for (const [key, rollups] of hours) {
      const [seriesId, field, hour] = key.split("/");
      const rollup = combine(rollups);
      if (rollup) {
        writeRollup(
          Number(seriesId),
          "hour",
          Number(hour),
          field as HistoryField,
          rollup,
        );
      }
    }
  }

  /**
   * Makes the roll-ups of every period that has ended since the last were
   * made, as far back as the changes they come from are kept: after the
   * core was stopped too.
   */
  function compile(at: number) {
    const end = floorTime(at, times.fiveMinutesMs);
    let through = Math.max(
      compiledThrough("5m") ?? firstPeriod("5m", end),
      end - times.statesKeptMs,
    );
    while (through < end) {
      // A day at a time, so no write holds the database long.
      const until = Math.min(end, through + 24 * times.hourMs);
      db.transaction(() => {
        compileFiveMinutes(through, until);
        setCompiled("5m", until);
      });
      through = until;
    }
    const hoursEnd = floorTime(through, times.hourMs);
    let hours = Math.max(
      compiledThrough("hour") ?? firstPeriod("hour", hoursEnd),
      hoursEnd - times.fiveMinutesKeptMs,
    );
    while (hours < hoursEnd) {
      const until = Math.min(hoursEnd, hours + 24 * times.hourMs);
      db.transaction(() => {
        compileHours(hours, until);
        setCompiled("hour", until);
      });
      hours = until;
    }
  }

  // Takes out what is past keeping. Each capability keeps the last change
  // before that, so what it was then is still known.
  function purge(at: number) {
    const states = at - times.statesKeptMs;
    db.run(sql`
      delete from ${historyStates} where at < ${states} and id not in (
        select id from (
          select id, row_number() over (partition by series_id order by at desc, id desc) as n
          from ${historyStates} where at < ${states}
        ) where n = 1
      )`);
    db.delete(historyStatistics)
      .where(
        and(
          eq(historyStatistics.period, "5m"),
          lt(historyStatistics.start, new Date(at - times.fiveMinutesKeptMs)),
        ),
      )
      .run();
    db.delete(historyStatistics)
      .where(
        and(
          eq(historyStatistics.period, "hour"),
          lt(historyStatistics.start, new Date(at - times.hoursKeptMs)),
        ),
      )
      .run();
  }

  return { compile, purge };
}
