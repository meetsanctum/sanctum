// How long history keeps what, and how often it writes. Hourly roll-ups go
// after two years, so the core's database stays bounded on a Pi's SD card.

const dayMs = 24 * 60 * 60_000;

export const historyTimes = {
  // How long each change is kept, then the 5-minute roll-ups.
  statesKeptMs: 10 * dayMs,
  fiveMinutesKeptMs: 10 * dayMs,
  hoursKeptMs: 730 * dayMs,
  fiveMinutesMs: 5 * 60_000,
  hourMs: 60 * 60_000,
  // Changes wait in memory and are written together: every few seconds, or
  // at once when this many are waiting, so a Pi's SD card sees few writes.
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
