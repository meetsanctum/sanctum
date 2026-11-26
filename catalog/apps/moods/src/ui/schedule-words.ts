import type { HomeClock } from "@meetsanctum/app-sdk/clock";

import {
  day,
  formatMinute,
  isOvernight,
  lengthOf,
  spanAt,
  type Span,
} from "../schedules/times.js";
import type { RoomSchedule } from "./schedules";

// The words Moods' pages use for a room's schedule and for what turning
// its lights on brings, apart from the pages so they can be checked on
// their own.

/** The minute of the day it is at an instant on the home's clock. */
export function minuteOfDay(clock: HomeClock, at: Date) {
  const { hour, minute } = clock.parts(at);
  return hour * 60 + minute;
}

/**
 * A minute of the day as the home writes it: 07:45, or 7:45 AM. The day's
 * end is 24:00, or 12:00 AM.
 */
export function minuteWords(clock: HomeClock, minute: number) {
  return clock.hourCycle === "24h"
    ? formatMinute(minute)
    : clock.wallTimeText(formatMinute(minute % day));
}

/** Midnight at the end of the day needs a day label in 12-hour time. */
export function endWords(clock: HomeClock, minute: number) {
  const time = minuteWords(clock, minute);
  return minute === day && clock.hourCycle === "12h"
    ? `${time}, next day`
    : time;
}

/** Such as "06:30 to 09:00", or "22:00 to 06:30, overnight". */
export function spanWords(clock: HomeClock, span: Span) {
  const words = `${minuteWords(clock, span.start)} to ${endWords(clock, span.end)}`;
  return isOvernight(span) && span.end !== 0 ? `${words}, overnight` : words;
}

/** Such as "1 hour", "45 minutes" or "3 hours 30 minutes". */
export function lengthWords(span: Span) {
  const minutes = lengthOf(span);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [
    hours > 0 && `${hours} ${hours === 1 ? "hour" : "hours"}`,
    rest > 0 && `${rest} minutes`,
  ].filter(Boolean);
  return parts.join(" ");
}

/** Such as "Desk lamp", "Ceiling and Desk lamp" or "Ceiling, Desk lamp and Shelf". */
export function namesWords(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Such as "at 23:10 yesterday", "at 08:15 today" or "on 28 October". */
export function whenWords(clock: HomeClock, at: Date, now: Date) {
  const time = clock.timeText(at);
  const date = clock.date(at);
  if (date === clock.date(now)) return `at ${time} today`;
  // The day before's own date: a day can be 23 or 25 hours long.
  const yesterday = clock.date(clock.startOfDay(now.getTime(), 1));
  if (date === yesterday) return `at ${time} yesterday`;
  return `on ${clock.longDayText(at)}`;
}

/**
 * What turning a room's lights on brings now, as its page says under
 * Turning the lights on, by the rule Moods publishes (turn-on.ts).
 */
export function turnOnWords(options: {
  schedule: RoomSchedule;
  /** The names of the room's moods, by id. */
  moodNames: ReadonlyMap<string, string>;
  /** The names of the lights, by device and capability. */
  lightName: (light: { device: string; capability: string }) => string;
  minute: number;
  now: Date;
  clock: HomeClock;
}) {
  const { schedule, moodNames, minute, now, clock } = options;
  const holding = spanAt(schedule.scheduled, minute);
  const mood = holding && moodNames.get(holding.moodId);
  if (schedule.turnOn === "followSchedule" && holding && mood) {
    return `Turning the lights on now brings ${mood}, until ${endWords(clock, holding.end)}.`;
  }
  const snapshot = schedule.snapshot;
  if (!snapshot || snapshot.lights.length === 0) {
    return "Turning the lights on now brings each light on as it remembers itself.";
  }
  const names = namesWords(snapshot.lights.map(options.lightName));
  const when = whenWords(clock, new Date(snapshot.takenAt), now);
  return schedule.turnOn === "asTheyWere"
    ? `Turning the lights on now brings back ${names} as they were ${when}.`
    : `Turning the lights on now brings back ${names}, the lights that were on ${when}.`;
}
