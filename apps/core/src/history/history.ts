import {
  historyFields,
  type Availability,
  type CapabilityInfo,
  type CapabilityKind,
  type DeviceHistory,
  type DeviceInfo,
  type DeviceStatistics,
  type HistoryField,
  type HistoryKept,
  type HistoryPeriod,
  type HistoryStatistic,
} from "@meetsanctum/app-sdk";
import { and, asc, desc, eq, gt, gte, lt, lte } from "drizzle-orm";
import { z } from "zod";

import type { ChangedBy, RecordActivity } from "../activity/activity.js";
import { ActionCallError } from "../app-host/errors.js";
import type { CoreDatabase } from "../database.js";
import type { DeviceChange } from "../devices/devices.js";
import type { View } from "../devices/views.js";
import { devices } from "../devices/schema.js";
import {
  historyDevices,
  historySeries,
  historyStates,
  historyStatistics,
} from "./schema.js";
import { createRollups } from "./compile.js";
import { isRecorded, type Recorded } from "./statistics.js";
import { historyTimes as times } from "./time.js";

// History: each change of what a device's capability reported, or of whether
// the device answered, kept for 10 days, and roll-ups of it every 5 minutes,
// kept as long, and every hour, kept for two years. Changes wait in memory
// and are written together every few seconds. Nothing is known while the
// core is stopped, so each capability is recorded as unknown when it stops
// and as it is when it starts. Anyone can stop keeping a device's history,
// which deletes it. Every client reads it through the gate; it names no one.

type Pending = Recorded & {
  device: string;
  capability: string;
  kind: CapabilityKind;
  at: Date;
};

const isoTime = z.iso
  .datetime({ offset: true })
  .transform((at) => new Date(at));

export const statesQuery = z.object({
  device: z.string().min(1).max(64),
  capability: z.string().min(1).max(32),
  from: isoTime.optional(),
  to: isoTime.optional(),
});

export const statisticsQuery = statesQuery.extend({
  period: z.enum(["5m", "hour"]),
});

export const keepRequest = z.object({
  device: z.string().min(1).max(64),
  kept: z.boolean(),
});

// How much one read may cover: the changes history keeps, two days of
// 5-minute roll-ups and a month of hourly ones.
const longestRange: Record<"states" | HistoryPeriod, number> = {
  states: times.statesKeptMs,
  "5m": 2 * 24 * times.hourMs,
  hour: 31 * 24 * times.hourMs,
};

const sameRecorded = (a: Recorded, b: Recorded) =>
  a.availability === b.availability &&
  JSON.stringify(a.state) === JSON.stringify(b.state);

const seriesKey = (device: string, capability: string) =>
  `${device}/${capability}`;

export function createHistory(
  db: CoreDatabase,
  options: {
    devices: {
      list(view: View): DeviceInfo[];
      get(id: string, view: View): DeviceInfo | null;
    };
    record: RecordActivity;
    log: (message: string) => void;
    now?: () => Date;
  },
) {
  const now = options.now ?? (() => new Date());
  const { log, record } = options;
  const everything: View = {};
  const queue: Pending[] = [];
  // What each capability was last recorded as, queued or written, and each
  // series' id, read from the database once.
  const last = new Map<string, (Recorded & { kind: CapabilityKind }) | null>();
  const series = new Map<string, { id: number; kind: CapabilityKind }>();
  // The devices whose history the household does not keep.
  const notKept = new Set(
    db
      .select({ device: historyDevices.deviceId })
      .from(historyDevices)
      .where(eq(historyDevices.kept, false))
      .all()
      .map((row) => row.device),
  );
  const rollups = createRollups(db);
  let timers: NodeJS.Timeout[] = [];
  let purgedAt: number | null = null;

  function lastRecorded(
    device: string,
    capability: string,
    kind: CapabilityKind,
  ): Recorded | null {
    const key = seriesKey(device, capability);
    const cached = last.get(key);
    if (cached === null || cached?.kind === kind) return cached;
    const row = db
      .select({
        availability: historyStates.availability,
        state: historyStates.state,
      })
      .from(historyStates)
      .innerJoin(historySeries, eq(historySeries.id, historyStates.seriesId))
      .where(
        and(
          eq(historySeries.deviceId, device),
          eq(historySeries.capabilityId, capability),
          eq(historySeries.kind, kind),
        ),
      )
      .orderBy(desc(historyStates.at), desc(historyStates.id))
      .limit(1)
      .get();
    const found = row ? { ...row, kind } : null;
    last.set(key, found);
    return found;
  }

  // Queues what a capability is now, unless it is what was last recorded.
  function observe(
    device: string,
    capability: Pick<CapabilityInfo, "id" | "kind" | "observed">,
    availability: Availability,
    at: Date,
  ) {
    const { kind } = capability;
    if (!isRecorded(kind) || notKept.has(device)) return;
    const current: Recorded = {
      availability,
      state: (capability.observed as Record<string, unknown> | null) ?? null,
    };
    const was = lastRecorded(device, capability.id, kind);
    // A capability starts once something is known of it, as a new device
    // once it reports.
    if (was ? sameRecorded(was, current) : current.state === null) return;
    last.set(seriesKey(device, capability.id), { ...current, kind });
    queue.push({ device, capability: capability.id, kind, at, ...current });
  }

  function observeDevice(device: DeviceInfo, at: Date) {
    for (const capability of device.capabilities) {
      observe(device.id, capability, device.availability, at);
    }
  }

  // Forgets what was kept in memory of a device whose history went.
  function forget(device: string, capability?: string) {
    for (const key of [...last.keys(), ...series.keys()]) {
      if (
        capability === undefined
          ? key.startsWith(`${device}/`)
          : key === seriesKey(device, capability)
      ) {
        last.delete(key);
        series.delete(key);
      }
    }
    for (let index = queue.length - 1; index >= 0; index--) {
      const pending = queue[index]!;
      if (
        pending.device === device &&
        (capability === undefined || pending.capability === capability)
      )
        queue.splice(index, 1);
    }
  }

  // A capability's series, made when it is first recorded; one whose kind
  // changed starts afresh. None for a device the core no longer has.
  function seriesFor(pending: Pending): number | null {
    const key = seriesKey(pending.device, pending.capability);
    const known = series.get(key);
    if (known?.kind === pending.kind) return known.id;
    const row = db
      .select()
      .from(historySeries)
      .where(
        and(
          eq(historySeries.deviceId, pending.device),
          eq(historySeries.capabilityId, pending.capability),
        ),
      )
      .get();
    if (row?.kind === pending.kind) {
      series.set(key, { id: row.id, kind: row.kind });
      return row.id;
    }
    if (row) {
      db.delete(historySeries).where(eq(historySeries.id, row.id)).run();
    }
    const exists = db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.id, pending.device))
      .get();
    if (!exists) return null;
    const { id } = db
      .insert(historySeries)
      .values({
        deviceId: pending.device,
        capabilityId: pending.capability,
        kind: pending.kind,
      })
      .returning({ id: historySeries.id })
      .get();
    series.set(key, { id, kind: pending.kind });
    return id;
  }

  /** Writes the changes waiting in memory. */
  function flush() {
    if (queue.length === 0) return;
    const batch = queue.splice(0);
    try {
      db.transaction(() => {
        for (const pending of batch) {
          const seriesId = seriesFor(pending);
          if (seriesId === null) continue;
          db.insert(historyStates)
            .values({
              seriesId,
              at: pending.at,
              availability: pending.availability,
              state: pending.state,
            })
            .run();
        }
      });
    } catch (error) {
      // The series made in the failed transaction are not there.
      series.clear();
      queue.unshift(...batch);
      const dropped = queue.length - times.queuedAtMost;
      if (dropped > 0) queue.splice(0, dropped);
      log(
        `history: ${batch.length} changes were not written (${error instanceof Error ? error.message : String(error)})${dropped > 0 ? `; dropped the oldest ${dropped}` : ""}`,
      );
    }
  }

  /** Writes what waits, makes the roll-ups due and, once a day, takes out what is past keeping. */
  function maintain() {
    const at = now().getTime();
    try {
      flush();
      // A failed batch must be retried before its periods are marked done
      // or the states they still need are purged.
      if (queue.length > 0) return;
      rollups.compile(at);
      if (purgedAt === null || at - purgedAt >= times.purgeMs) {
        rollups.purge(at);
        purgedAt = at;
      }
    } catch (error) {
      log(
        `history: roll-ups failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  // A capability of a device the view may see, which history records.
  function visible(view: View, device: string, capability: string) {
    const shown = options.devices.get(device, view);
    const found = shown?.capabilities.find((each) => each.id === capability);
    if (!shown || !found || !isRecorded(found.kind)) {
      throw new ActionCallError("not_found");
    }
    return found;
  }

  // The range a read covers: until now and a day back unless it says.
  function range(
    query: { from?: Date; to?: Date },
    longest: number,
  ): { from: Date; to: Date } {
    const to = query.to ?? now();
    const from = query.from ?? new Date(to.getTime() - 24 * times.hourMs);
    if (from >= to || to.getTime() - from.getTime() > longest) {
      throw new ActionCallError("invalid_request");
    }
    return { from, to };
  }

  function seriesId(device: string, capability: CapabilityInfo) {
    return (
      db
        .select({ id: historySeries.id })
        .from(historySeries)
        .where(
          and(
            eq(historySeries.deviceId, device),
            eq(historySeries.capabilityId, capability.id),
            eq(historySeries.kind, capability.kind),
          ),
        )
        .get()?.id ?? null
    );
  }

  const module = {
    /** Follows a device's change, once it has committed. */
    deviceChanged(change: DeviceChange) {
      if (!change.after) {
        // Its history went with it.
        forget(change.id);
        notKept.delete(change.id);
        return;
      }
      for (const previous of change.before?.capabilities ?? []) {
        if (
          change.after.capabilities.some(
            (current) =>
              current.id === previous.id && current.kind === previous.kind,
          )
        )
          continue;
        db.delete(historySeries)
          .where(
            and(
              eq(historySeries.deviceId, change.id),
              eq(historySeries.capabilityId, previous.id),
            ),
          )
          .run();
        forget(change.id, previous.id);
      }
      observeDevice(change.after, now());
      if (queue.length >= times.flushAt) flush();
    },

    /**
     * Records what every device is now, makes the roll-ups due, then
     * writes and rolls up every few seconds and minutes; tests do it by
     * hand.
     */
    start(startOptions: { ticking?: boolean } = {}) {
      const at = now();
      for (const device of options.devices.list(everything)) {
        observeDevice(device, at);
      }
      flush();
      if (startOptions.ticking === false) return;
      maintain();
      timers = [
        setInterval(flush, times.flushMs),
        setInterval(maintain, times.compileMs),
      ];
      for (const timer of timers) timer.unref();
    },

    flush,
    maintain,

    /** What a capability did from `from` until `to` (GET /api/history/states). */
    states(view: View, query: z.output<typeof statesQuery>): DeviceHistory {
      const capability = visible(view, query.device, query.capability);
      const { from, to } = range(query, longestRange.states);
      flush();
      const id = seriesId(query.device, capability);
      const read = (row: typeof historyStates.$inferSelect) => ({
        at: row.at.toISOString(),
        availability: row.availability,
        state: row.state ?? null,
      });
      const before =
        id === null
          ? undefined
          : db
              .select()
              .from(historyStates)
              .where(
                and(
                  eq(historyStates.seriesId, id),
                  lte(historyStates.at, from),
                ),
              )
              .orderBy(desc(historyStates.at), desc(historyStates.id))
              .limit(1)
              .get();
      const during =
        id === null
          ? []
          : db
              .select()
              .from(historyStates)
              .where(
                and(
                  eq(historyStates.seriesId, id),
                  gt(historyStates.at, from),
                  lte(historyStates.at, to),
                ),
              )
              .orderBy(asc(historyStates.at), asc(historyStates.id))
              .all();
      return {
        device: query.device,
        capability: capability.id,
        kind: capability.kind,
        from: from.toISOString(),
        to: to.toISOString(),
        kept: !notKept.has(query.device),
        states: [...(before ? [before] : []), ...during].map(read),
      };
    },

    /** A capability's roll-ups over the periods that start from `from` until `to` (GET /api/history/statistics). */
    statistics(
      view: View,
      query: z.output<typeof statisticsQuery>,
    ): DeviceStatistics {
      const capability = visible(view, query.device, query.capability);
      const { from, to } = range(query, longestRange[query.period]);
      maintain();
      const id = seriesId(query.device, capability);
      const fields: Partial<Record<HistoryField, HistoryStatistic[]>> = {};
      for (const field of historyFields[capability.kind]) fields[field] = [];
      if (id !== null) {
        for (const row of db
          .select()
          .from(historyStatistics)
          .where(
            and(
              eq(historyStatistics.seriesId, id),
              eq(historyStatistics.period, query.period),
              gte(historyStatistics.start, from),
              lt(historyStatistics.start, to),
            ),
          )
          .orderBy(asc(historyStatistics.start))
          .all()) {
          fields[row.field as HistoryField]?.push({
            start: row.start.toISOString(),
            mean: row.mean,
            min: row.min,
            max: row.max,
            seconds: row.seconds,
          });
        }
      }
      return {
        device: query.device,
        capability: capability.id,
        kind: capability.kind,
        period: query.period,
        from: from.toISOString(),
        to: to.toISOString(),
        kept: !notKept.has(query.device),
        fields,
      };
    },

    /** Whether each device the view may see with something to record keeps its history. */
    kept(view: View): HistoryKept[] {
      return options.devices
        .list(view)
        .filter((device) =>
          device.capabilities.some((each) => isRecorded(each.kind)),
        )
        .map((device) => ({
          device: device.id,
          kept: !notKept.has(device.id),
        }));
    },

    /**
     * The household's choice to keep a device's history or not (POST
     * /api/history/keep): not keeping it deletes what was kept, and keeping
     * it again starts from what the device is now.
     */
    keep(by: ChangedBy, input: z.output<typeof keepRequest>): HistoryKept {
      const device = options.devices.get(input.device, everything);
      if (!device) throw new ActionCallError("not_found");
      db.transaction(() => {
        db.insert(historyDevices)
          .values({ deviceId: device.id, kept: input.kept, updatedAt: now() })
          .onConflictDoUpdate({
            target: historyDevices.deviceId,
            set: { kept: input.kept, updatedAt: now() },
          })
          .run();
        if (!input.kept) {
          db.delete(historySeries)
            .where(eq(historySeries.deviceId, device.id))
            .run();
        }
      });
      if (input.kept) {
        notKept.delete(device.id);
        observeDevice(device, now());
        flush();
      } else {
        notKept.add(device.id);
        forget(device.id);
      }
      record({
        action: input.kept ? "history.keep" : "history.forget",
        outcome: "ok",
        personId: by.personId,
        clientId: by.clientId,
        subjectId: device.id,
      });
      return { device: device.id, kept: input.kept };
    },

    /** Records every capability as unknown, since the core is stopping, and writes what waits. */
    close() {
      for (const timer of timers) clearInterval(timer);
      timers = [];
      const at = now();
      for (const device of options.devices.list(everything)) {
        for (const capability of device.capabilities) {
          observe(device.id, { ...capability, observed: null }, "unknown", at);
        }
      }
      flush();
    },
  };
  return module;
}

export type History = ReturnType<typeof createHistory>;
