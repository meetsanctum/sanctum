import { join } from "node:path";

import { errorMessage } from "../docker.js";
import { readJson, writeJson } from "../state.js";

// The host's last 24 hours for Settings → Status: how busy the processor was,
// how warm it ran and how much memory was in use, as each 5 minutes' mean of
// the samples taken every 10 seconds. The machine is not one of the home's
// devices, so this is not the core's History: the manager already samples
// it, and 24 hours is all Status shows.
//
// The day is kept in memory and written to the manager's volume every 15
// minutes and when it stops, so an update or a restart keeps it; a power
// cut loses at most the last 15 minutes, which were not read anyway.

export type HostSample = {
  // From 0 to 1.
  usage: number | null;
  celsius: number | null;
  // Bytes: what the kernel says is not available.
  memoryUsed: number | null;
};

// Each 5 minutes' mean of what was sampled in them; null where nothing was.
export type HistoryPoint = {
  at: string;
  usage: number | null;
  celsius: number | null;
  memoryUsed: number | null;
};

const periodMs = 5 * 60_000;
const dayMs = 24 * 60 * 60_000;
const saveEvery = 3;

type Sums = { [key in keyof HostSample]: { sum: number; count: number } };

const emptySums = (): Sums => ({
  usage: { sum: 0, count: 0 },
  celsius: { sum: 0, count: 0 },
  memoryUsed: { sum: 0, count: 0 },
});

const mean = ({ sum, count }: { sum: number; count: number }) =>
  count === 0 ? null : sum / count;

const isPoint = (value: unknown): value is HistoryPoint =>
  typeof value === "object" &&
  value !== null &&
  "at" in value &&
  typeof value.at === "string" &&
  !Number.isNaN(Date.parse(value.at));

export function createHostHistory(options: {
  dataDir: string;
  log: (message: string) => void;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const path = join(options.dataDir, "host-history.json");
  let points: HistoryPoint[] = [];
  let period: number | undefined;
  let sums = emptySums();
  let unsaved = 0;
  let saving = Promise.resolve();

  // Only the last 24 hours.
  function trim() {
    const from = now().getTime() - dayMs;
    points = points.filter((point) => Date.parse(point.at) >= from);
  }

  // The 5 minutes sampled so far, once they have ended.
  function close() {
    if (period === undefined) return;
    points.push({
      at: new Date(period).toISOString(),
      usage: mean(sums.usage),
      celsius: mean(sums.celsius),
      memoryUsed: mean(sums.memoryUsed),
    });
    sums = emptySums();
    trim();
    unsaved += 1;
  }

  function save() {
    saving = saving.then(async () => {
      const count = unsaved;
      try {
        await writeJson(path, { points });
        unsaved = Math.max(0, unsaved - count);
      } catch (error) {
        // Keep the unsaved count so the next ended period retries.
        options.log(`Could not keep the host's day: ${errorMessage(error)}`);
      }
    });
    return saving;
  }

  return {
    // What was kept before the manager stopped, within the last 24 hours.
    async load() {
      const kept = await readJson<{ points?: unknown }>(path).catch(() => null);
      points = Array.isArray(kept?.points) ? kept.points.filter(isPoint) : [];
      trim();
    },

    add(sample: HostSample) {
      const at = now().getTime();
      const current = at - (at % periodMs);
      if (period !== undefined && current !== period) {
        close();
        if (unsaved >= saveEvery) void save();
      }
      period = current;
      for (const key of ["usage", "celsius", "memoryUsed"] as const) {
        const value = sample[key];
        if (value === null || !Number.isFinite(value)) continue;
        sums[key].sum += value;
        sums[key].count += 1;
      }
    },

    // The ended 5 minutes of the last 24 hours, oldest first.
    points() {
      trim();
      return points;
    },

    // Keeps the day before the manager stops; the 5 minutes under way are
    // not ended, so they are left out.
    save,
  };
}

export type HostHistory = ReturnType<typeof createHostHistory>;
