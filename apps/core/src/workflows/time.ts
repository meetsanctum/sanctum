import { weekdays, type Weekday } from "@meetsanctum/app-sdk";

// Times of day in the home's time zone, for timers and the time condition. A
// time that a change of the clocks skips comes as much later as the clocks
// moved (02:30 becomes 03:30), and one they repeat comes the first time, as
// JavaScript's Temporal does.

type LocalDate = { year: number; month: number; day: number };

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string) {
  let found = formats.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(timeZone, found);
  }
  return found;
}

/** Whether the runtime knows a time zone, such as Europe/Zurich. */
export function isTimeZone(timeZone: string) {
  try {
    format(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The host's own time zone. */
export const hostTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The wall clock in a time zone at an instant. */
export function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    format(timeZone)
      .formatToParts(at)
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

// How far the wall clock is ahead of UTC at an instant, in ms.
function offsetAt(at: number, timeZone: string) {
  const local = localParts(new Date(at), timeZone);
  const wall = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/** The instant a local date and time names in a time zone. */
export function zonedTime(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // The offsets on either side of any change of the clocks that day.
  const before = offsetAt(wall - 14 * 3600_000, timeZone);
  const after = offsetAt(wall + 14 * 3600_000, timeZone);
  const fits = [wall - before, wall - after].filter(
    (at) => wall - offsetAt(at, timeZone) === at,
  );
  // Repeated: the first. Skipped: as much later as the clocks moved.
  return new Date(fits.length > 0 ? Math.min(...fits) : wall - before);
}

function addDays(date: LocalDate, days: number): LocalDate {
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
  };
}

function weekdayOf(date: LocalDate): Weekday {
  // getUTCDay counts from Sunday.
  const index = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay();
  return weekdays[(index + 6) % 7]!;
}

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
  const { hour, minute } = hourMinute(time);
  const today = localParts(after, timeZone);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const date = addDays(today, ahead);
    if (days && !days.includes(weekdayOf(date))) {
      continue;
    }
    const at = zonedTime(date, hour, minute, timeZone);
    if (at.getTime() > after.getTime()) {
      return at;
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
