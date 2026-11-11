// How long history keeps what, and how often it writes, ported from v1's
// recorder-time.ts. v1 kept its hourly roll-ups for ever; here they go after
// two years, so the core's database stays bounded on a Pi's SD card.

const dayMs = 24 * 60 * 60_000;

export const historyTimes = {
  // Each change, then the 5-minute roll-ups, for as long as v1 kept them.
  statesKeptMs: 10 * dayMs,
  fiveMinutesKeptMs: 10 * dayMs,
  hoursKeptMs: 730 * dayMs,
  fiveMinutesMs: 5 * 60_000,
  hourMs: 60 * 60_000,
  // Changes wait in memory and are written together, as v1 did: every few
  // seconds, or at once when this many are waiting, so a Pi's SD card sees
  // few writes.
  flushMs: 5_000,
  flushAt: 100,
  // How many may wait while writing fails; the oldest go after that.
  queuedAtMost: 10_000,
  // Roll-ups are made every 5 minutes, and what is past keeping goes once
  // a day.
  compileMs: 5 * 60_000,
  purgeMs: dayMs,
} as const;

export function floorTime(timeMs: number, bucketMs: number) {
  return Math.floor(timeMs / bucketMs) * bucketMs;
}
