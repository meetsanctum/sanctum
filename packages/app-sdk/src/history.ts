import type { Availability, CapabilityKind } from "./devices.js";

// A device's history: what each of its capabilities reported over time, as
// the core records it, and roll-ups of it every 5 minutes and every hour.
// These are the answers of the core's history routes, which clients read;
// apps do not read history.

/** What a capability was, from `at` until the next change. */
export type HistoryState<State = Record<string, unknown>> = {
  at: string;
  /** Offline: the device did not answer, so what it was is not known. */
  availability: Availability;
  /** What it last reported, or none while nothing is known. */
  state: State | null;
};

/** What GET /api/history/states answers for one capability. */
export type DeviceHistory = {
  device: string;
  capability: string;
  kind: CapabilityKind;
  from: string;
  to: string;
  /** Whether the household keeps this device's history. */
  kept: boolean;
  /**
   * What it was at `from`, which may have begun before it, then each change
   * until `to`, oldest first; empty while nothing has been recorded.
   */
  states: HistoryState[];
};

/** The lengths of the core's roll-ups. */
export const historyPeriods = ["5m", "hour"] as const;
export type HistoryPeriod = (typeof historyPeriods)[number];

/**
 * The values each capability kind rolls up: whether a light or a switch was
 * on, as 1 or 0, a light's brightness while it was on, a sensor's reading
 * in its measure's standard unit, and whether a motion sensor saw someone,
 * as 1 or 0.
 */
export const historyFields = {
  light: ["on", "brightness"],
  switch: ["on"],
  button: [],
  sensor: ["value"],
  occupancy: ["occupied"],
} as const satisfies Record<CapabilityKind, readonly string[]>;
export type HistoryField = (typeof historyFields)[CapabilityKind][number];

/**
 * One value over one 5 minutes or hour, weighed by time: `on`'s mean is the
 * share of the time it was on. `seconds` is how long the value was known:
 * while the device answered and, for brightness, while the light was on.
 */
export type HistoryStatistic = {
  start: string;
  mean: number;
  min: number;
  max: number;
  seconds: number;
};

/** What GET /api/history/statistics answers for one capability. */
export type DeviceStatistics = {
  device: string;
  capability: string;
  kind: CapabilityKind;
  period: HistoryPeriod;
  from: string;
  to: string;
  kept: boolean;
  /**
   * Each of its kind's values, oldest first, for every period within the
   * range that has ended; a period in which a value was never known has none.
   */
  fields: Partial<Record<HistoryField, HistoryStatistic[]>>;
};

/** Whether the household keeps a device's history (GET /api/history/devices). */
export type HistoryKept = { device: string; kept: boolean };
