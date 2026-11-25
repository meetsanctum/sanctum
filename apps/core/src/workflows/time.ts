import { weekdays, type Weekday } from "@meetsanctum/app-sdk";
import {
  addDays,
  localParts,
  weekdayIndex,
  zonedTime,
  type LocalDate,
} from "@meetsanctum/app-sdk/clock";

// The workflows' times of day in the home's time zone, for timers and the
// time condition, on the home clock: a time the clocks skip comes as much
// later as they moved, and one they repeat comes the first time.

const weekdayOf = (date: LocalDate): Weekday => weekdays[weekdayIndex(date)]!;

function hourMinute(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

/** The first time after `after` the local clock reads `time` on one of `days`. */
export function nextDaily(
  after: Date,
  time: string,
  timeZone: string,
  days?: readonly Weekday[],
): Date {
  return nextDailyOccurrence(after, time, timeZone, days).nextAt;
}

const dayMs = 24 * 60 * 60_000;

export const calendarDay = (date: LocalDate) =>
  Date.UTC(date.year, date.month - 1, date.day);

/** The next daily occurrence, past any calendar day already handled. */
export function nextDailyOccurrence(
  after: Date,
  time: string,
  timeZone: string,
  days?: readonly Weekday[],
  lastDailyDay: number | null = null,
) {
  const { hour, minute } = hourMinute(time);
  const today = localParts(after, timeZone);
  const first =
    lastDailyDay === null
      ? 0
      : Math.max(0, (lastDailyDay - calendarDay(today)) / dayMs + 1);
  for (let ahead = first; ahead <= first + 8; ahead++) {
    const date = addDays(today, ahead);
    if (days && !days.includes(weekdayOf(date))) {
      continue;
    }
    const at = zonedTime(date, hour, minute, timeZone);
    if (at.getTime() > after.getTime()) {
      return { nextAt: at, nextDailyDay: calendarDay(date) };
    }
  }
  // Only reached with no days at all, which their schema refuses.
  throw new Error("No day to run on");
}

/** The first beat after `after` of something every `seconds`, from the epoch. */
export function nextEvery(after: Date, seconds: number, offsetSeconds = 0) {
  const every = seconds * 1000;
  const offset = offsetSeconds * 1000;
  const beat = Math.floor((after.getTime() - offset) / every) + 1;
  return new Date(beat * every + offset);
}

/**
 * Whether the local time is from `start` up to `end`, across midnight when
 * `start` is later. Days are those the span starts on.
 */
export function withinTimes(
  at: Date,
  span: { after: string; before: string; days?: readonly Weekday[] },
  timeZone: string,
) {
  const local = localParts(at, timeZone);
  const now = local.hour * 60 + local.minute;
  const start = hourMinute(span.after);
  const end = hourMinute(span.before);
  const from = start.hour * 60 + start.minute;
  const to = end.hour * 60 + end.minute;
  let startedOn: LocalDate = local;
  if (from <= to) {
    if (now < from || now >= to) return false;
  } else if (now < to) {
    // After midnight: the span began the day before.
    startedOn = addDays(local, -1);
  } else if (now < from) {
    return false;
  }
  return !span.days || span.days.includes(weekdayOf(startedOn));
}
