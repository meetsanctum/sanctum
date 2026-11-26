// The home clock works out dates and times in the home's time zone. Places
// keeps the household's zone and hour preference. Workflows use the zone to
// schedule time triggers, and Models uses it to count usage by day.
//
// A time of day the clocks skip comes as much later as they moved (02:30
// becomes 03:30), and one they repeat comes the first time, as JavaScript's
// Temporal does; a day starts at its first instant, even where its midnight
// is skipped. It uses the runtime's Intl and keeps a bounded cache of recent
// formatters because making one costs far more than using it.

/** How the home writes a time of day, which the household sets: 14:48 or 2:48 PM. */
export const hourCycles = ["24h", "12h"] as const;
export type HourCycle = (typeof hourCycles)[number];

/** A date on the home's calendar. */
export type LocalDate = { year: number; month: number; day: number };

/** What the home's wall clock reads at an instant. */
export type LocalParts = LocalDate & {
  hour: number;
  minute: number;
  second: number;
};

const formats = new Map<string, Intl.DateTimeFormat>();
const maxFormats = 128;

function formatter(
  key: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
) {
  const found = formats.get(key);
  if (found) {
    formats.delete(key);
    formats.set(key, found);
    return found;
  }
  const created = new Intl.DateTimeFormat(locale, options);
  if (formats.size === maxFormats) {
    formats.delete(formats.keys().next().value!);
  }
  formats.set(key, created);
  return created;
}

const partsFormat = (timeZone: string) =>
  formatter(`parts|${timeZone}`, "en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Whether the runtime knows a time zone, such as Europe/Zurich. */
export function isTimeZone(timeZone: string) {
  try {
    partsFormat(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The time zone of the machine or device this runs on. */
export const hostTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What the wall clock reads in a time zone at an instant. */
export function localParts(at: Date | number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const { type, value } of partsFormat(timeZone).formatToParts(at)) {
    if (type !== "literal") parts[type] = Number(value);
  }
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
  const local = localParts(at, timeZone);
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

/** The instant a local date and time of day names in a time zone. */
export function zonedTime(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const { year, month, day } = addDays(date, 0);
  if (year !== date.year || month !== date.month || day !== date.day) {
    throw new RangeError(`Invalid local date: ${dateKey(date)}`);
  }
  return new Date(resolveTime(date, hour, minute, timeZone));
}

function resolveTime(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
  startOfDate = false,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // The offsets on either side of any change of the clocks that day.
  const before = offsetAt(wall - 14 * 3600_000, timeZone);
  const after = offsetAt(wall + 14 * 3600_000, timeZone);
  const fits = [wall - before, wall - after].filter(
    (at) => wall - offsetAt(at, timeZone) === at,
  );
  // Repeated: the first. Skipped: as much later as the clocks moved.
  if (fits.length > 0) return Math.min(...fits);
  if (!startOfDate) return wall - before;

  // Midnight is in a gap. The two offsets bracket the instant when the
  // clock enters the date (or passes it entirely).
  let earlier = wall - after;
  let later = wall - before;
  while (later - earlier > 1) {
    const middle = earlier + Math.floor((later - earlier) / 2);
    if (offsetAt(middle, timeZone) === before) earlier = middle;
    else later = middle;
  }
  return later;
}

/** The date some days after another, or before it with a negative count. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
  };
}

/** A date's day of the week, from 0 for Monday to 6 for Sunday. */
export function weekdayIndex(date: LocalDate) {
  // getUTCDay counts from Sunday.
  return (
    (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) %
    7
  );
}

const pad = (value: number, digits = 2) => String(value).padStart(digits, "0");
const dateKey = (date: LocalDate) =>
  `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;

function parseLocalDate(date: string): LocalDate {
  const parts = /^(\d+)-(\d{1,2})-(\d{1,2})$/.exec(date);
  if (!parts) {
    throw new RangeError(`Invalid local date: ${date}`);
  }
  return {
    year: Number(parts[1]),
    month: Number(parts[2]),
    day: Number(parts[3]),
  };
}

/** The date in a time zone at an instant, such as 2026-10-29. */
export function localDate(timeZone: string, at: Date | number) {
  return dateKey(localParts(at, timeZone));
}

/** The date some days after another, such as 2026-11-01 one day after 2026-10-31. */
export function addLocalDays(date: string, days: number) {
  return dateKey(addDays(parseLocalDate(date), days));
}

/** The instant of a local date, such as 2026-10-29, and time of day in a time zone. */
export function zonedDateToUtc(
  date: string,
  hour: number,
  minute: number,
  timeZone: string,
) {
  return zonedTime(parseLocalDate(date), hour, minute, timeZone);
}

// What a day's start and its marked hours came to, by zone and date, kept a
// while: a screen asks for today's and the week's again each minute.
const days = new Map<string, number | number[]>();
const maxDays = 256;

function kept<T extends number | number[]>(key: string, work: () => T): T {
  const known = days.get(key);
  if (known !== undefined) return known as T;
  const value = work();
  if (days.size === maxDays) days.delete(days.keys().next().value!);
  days.set(key, value);
  return value;
}

const dayStart = (date: LocalDate, timeZone: string) =>
  kept(`start|${timeZone}|${dateKey(date)}`, () =>
    resolveTime(date, 0, 0, timeZone, true),
  );

/** When the day an instant falls on starts in a time zone, `daysBack` days before. */
export function startOfDay(at: number, timeZone: string, daysBack = 0) {
  return dayStart(addDays(localParts(at, timeZone), -daysBack), timeZone);
}

/** How many calendar days separate two instants, positive when to is later. */
export function calendarDaysBetween(
  from: number,
  to: number,
  timeZone: string,
) {
  return Math.round(
    (startOfDay(to, timeZone) - startOfDay(from, timeZone)) / (24 * 3600_000),
  );
}

// A date's whole hours every `every` hours from midnight, leaving out those
// the clocks skip.
const markedHours = (date: LocalDate, timeZone: string, every: number) =>
  kept(`hours|${every}|${timeZone}|${dateKey(date)}`, () => {
    const hours: number[] = [];
    for (let hour = 0; hour < 24; hour += every) {
      const at = resolveTime(date, hour, 0, timeZone);
      const local = localParts(at, timeZone);
      if (
        local.year === date.year &&
        local.month === date.month &&
        local.day === date.day &&
        local.hour === hour &&
        local.minute === 0 &&
        local.second === 0
      ) {
        hours.push(at);
      }
    }
    return hours;
  });

/**
 * The whole local hours every `every` hours from midnight, strictly
 * between two instants, as a day's axis marks them: an hour the clocks
 * skip has none.
 */
export function hoursBetween(
  from: number,
  to: number,
  timeZone: string,
  every = 6,
) {
  if (!Number.isInteger(every) || every <= 0) {
    throw new RangeError("The hour interval must be a positive integer");
  }
  const hours: number[] = [];
  for (
    let date: LocalDate = localParts(from, timeZone);
    dayStart(date, timeZone) < to;
    date = addDays(date, 1)
  ) {
    for (const at of markedHours(date, timeZone, every)) {
      if (at > from && at < to) hours.push(at);
    }
  }
  return hours;
}

const invalid = "Invalid Date";

// What a formatter writes for an instant, or Invalid Date, as a Date says
// itself, for one that isn't an instant, rather than failing to draw.
function written(
  key: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  at: Date | number,
) {
  const time = typeof at === "number" ? at : at.getTime();
  if (!Number.isFinite(time) || Math.abs(time) > 8_640_000_000_000_000)
    return invalid;
  return formatter(key, locale, options).format(time);
}

// A time of day on the clock, with or without its seconds.
function clockText(
  at: Date | number,
  timeZone: string,
  hourCycle: HourCycle,
  seconds: boolean,
) {
  const second = seconds ? ({ second: "2-digit" } as const) : {};
  const key = `${seconds ? "seconds" : "time"}|${hourCycle}|${timeZone}`;
  return hourCycle === "12h"
    ? written(
        key,
        "en-US",
        {
          timeZone,
          hour: "numeric",
          minute: "2-digit",
          ...second,
          hourCycle: "h12",
        },
        at,
      )
    : written(
        key,
        "en-GB",
        {
          timeZone,
          hour: "2-digit",
          minute: "2-digit",
          ...second,
          hourCycle: "h23",
        },
        at,
      );
}

/** A time of day as the home writes it: 07:30, or 7:30 AM with 12 hours. */
export const timeText = (
  at: Date | number,
  timeZone: string,
  hourCycle: HourCycle = "24h",
) => clockText(at, timeZone, hourCycle, false);

/** A time of day to the second, where minutes don't tell two apart: 07:30:12, or 7:30:12 AM. */
export const secondsText = (
  at: Date | number,
  timeZone: string,
  hourCycle: HourCycle = "24h",
) => clockText(at, timeZone, hourCycle, true);

/**
 * A wall-clock time as the home writes it, such as a schedule's 07:30, which
 * belongs to no day or zone: 07:30, or 7:30 AM with 12 hours. Anything that
 * isn't a time of day comes back as it is.
 */
export function wallTimeText(time: string, hourCycle: HourCycle = "24h") {
  const parts = /^(\d{1,2}):(\d{2})$/.exec(time);
  const hour = Number(parts?.[1]);
  const minute = Number(parts?.[2]);
  if (!parts || hour > 23 || minute > 59) return time;
  return timeText(Date.UTC(1970, 0, 1, hour, minute), "UTC", hourCycle);
}

/** An hour on its own, as an axis or a column of hours writes it: 16:00, or 4 PM with 12 hours. */
export function hourText(
  at: Date | number,
  timeZone: string,
  hourCycle: HourCycle = "24h",
) {
  if (hourCycle === "12h") {
    return written(
      `hour12|${timeZone}`,
      "en-US",
      { timeZone, hour: "numeric", hourCycle: "h12" },
      at,
    );
  }
  const hour = written(
    `hour24|${timeZone}`,
    "en-GB",
    { timeZone, hour: "2-digit", hourCycle: "h23" },
    at,
  );
  return hour === invalid ? hour : `${hour}:00`;
}

/** A day's name, such as Mon. */
export const weekdayText = (at: Date | number, timeZone: string) =>
  written(
    `weekday|${timeZone}`,
    "en-GB",
    {
      timeZone,
      weekday: "short",
    },
    at,
  );

/** A day's whole name, such as Monday. */
export const longWeekdayText = (at: Date | number, timeZone: string) =>
  written(
    `longWeekday|${timeZone}`,
    "en-GB",
    { timeZone, weekday: "long" },
    at,
  );

/** A date without its day, its month in full, such as 3 November. */
export const longDayText = (at: Date | number, timeZone: string) =>
  written(
    `longDay|${timeZone}`,
    "en-GB",
    { timeZone, day: "numeric", month: "long" },
    at,
  );

/** A date without its day, such as 3 Nov. */
export const dayText = (at: Date | number, timeZone: string) =>
  written(
    `day|${timeZone}`,
    "en-GB",
    {
      timeZone,
      day: "numeric",
      month: "short",
    },
    at,
  );

/** A day and its date, such as Mon 3 Nov. */
export const dateText = (at: Date | number, timeZone: string) =>
  written(
    `date|${timeZone}`,
    "en-GB",
    {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
    },
    at,
  );

/** The home clock: every way of working out days and times above, bound to the home's zone and its hours. */
export type HomeClock = {
  /** The home's time zone, such as Europe/Zurich. */
  readonly timeZone: string;
  readonly hourCycle: HourCycle;
  now(): Date;
  /**
   * The same hours and time in another zone, for data stamped with the zone
   * it was fetched in, such as a forecast's days.
   */
  withTimeZone(timeZone: string): HomeClock;
  /** What the home's wall clock reads, now unless said. */
  parts(at?: Date | number): LocalParts;
  /** The home's date, today unless said, such as 2026-10-29. */
  date(at?: Date | number): string;
  /** When the home's day starts, today's unless said, `daysBack` days before. */
  startOfDay(at?: number, daysBack?: number): number;
  /** The instant of a time of day on one of the home's dates. */
  at(date: LocalDate | string, hour: number, minute: number): Date;
  /** The whole hours every `every` hours from midnight strictly between two instants. */
  hours(from: number, to: number, every?: number): number[];
  /** A time of day as the home writes it: 07:30, or 7:30 AM. */
  timeText(at: Date | number): string;
  /** An hour on its own: 16:00, or 4 PM. */
  hourText(at: Date | number): string;
  /** A time of day to the second: 07:30:12, or 7:30:12 AM. */
  secondsText(at: Date | number): string;
  /** A wall-clock time such as a schedule's 07:30, as the home writes it: 07:30, or 7:30 AM. */
  wallTimeText(time: string): string;
  /** A day's name, such as Mon. */
  weekdayText(at: Date | number): string;
  /** A day's whole name, such as Monday. */
  longWeekdayText(at: Date | number): string;
  /** A date without its day, such as 3 Nov. */
  dayText(at: Date | number): string;
  /** A date without its day, its month in full, such as 3 November. */
  longDayText(at: Date | number): string;
  /** A day and its date, such as Mon 3 Nov. */
  dateText(at: Date | number): string;
};

/**
 * The home clock for a time zone, or for the device's own while the home's
 * isn't known or the runtime doesn't know it, as an old web view may not,
 * so a time is always drawn.
 */
export function homeClock(
  options: {
    timeZone?: string | null;
    hourCycle?: HourCycle;
    now?: () => Date;
  } = {},
): HomeClock {
  const timeZone =
    options.timeZone && isTimeZone(options.timeZone)
      ? options.timeZone
      : hostTimeZone();
  const hourCycle = options.hourCycle ?? "24h";
  const now = options.now ?? (() => new Date());
  return {
    timeZone,
    hourCycle,
    now,
    withTimeZone: (zone) => homeClock({ timeZone: zone, hourCycle, now }),
    parts: (at = now()) => localParts(at, timeZone),
    date: (at = now()) => localDate(timeZone, at),
    startOfDay: (at = now().getTime(), daysBack = 0) =>
      startOfDay(at, timeZone, daysBack),
    at: (date, hour, minute) =>
      zonedTime(
        typeof date === "string" ? parseLocalDate(date) : date,
        hour,
        minute,
        timeZone,
      ),
    hours: (from, to, every) => hoursBetween(from, to, timeZone, every),
    timeText: (at) => timeText(at, timeZone, hourCycle),
    hourText: (at) => hourText(at, timeZone, hourCycle),
    secondsText: (at) => secondsText(at, timeZone, hourCycle),
    wallTimeText: (time) => wallTimeText(time, hourCycle),
    weekdayText: (at) => weekdayText(at, timeZone),
    longWeekdayText: (at) => longWeekdayText(at, timeZone),
    dayText: (at) => dayText(at, timeZone),
    longDayText: (at) => longDayText(at, timeZone),
    dateText: (at) => dateText(at, timeZone),
  };
}
