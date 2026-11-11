import {
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

/** Such as "06:30 to 09:00", or "22:00 to 06:30, overnight". */
export function spanWords(span: Span) {
  const words = `${formatMinute(span.start)} to ${formatMinute(span.end)}`;
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

const dateIn = (at: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((each) => each.type === type)!.value);
  // Compare calendar dates; a local day can be 23 or 25 hours long.
  return Date.UTC(part("year"), part("month") - 1, part("day"));
};

/** Such as "at 23:10 yesterday", "at 08:15 today" or "on 28 October". */
export function whenWords(at: Date, now: Date, timeZone: string) {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(at);
  const day = dateIn(at, timeZone);
  if (day === dateIn(now, timeZone)) return `at ${time} today`;
  const yesterday = dateIn(now, timeZone) - 24 * 60 * 60 * 1000;
  if (day === yesterday) return `at ${time} yesterday`;
  return `on ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone,
  }).format(at)}`;
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
  timeZone: string;
}) {
  const { schedule, moodNames, minute, now, timeZone } = options;
  const holding = spanAt(schedule.scheduled, minute);
  const mood = holding && moodNames.get(holding.moodId);
  if (schedule.turnOn === "followSchedule" && holding && mood) {
    return `Turning the lights on now brings ${mood}, until ${formatMinute(holding.end)}.`;
  }
  const snapshot = schedule.snapshot;
  if (!snapshot || snapshot.lights.length === 0) {
    return "Turning the lights on now brings each light on as it remembers itself.";
  }
  const names = namesWords(snapshot.lights.map(options.lightName));
  const when = whenWords(new Date(snapshot.takenAt), now, timeZone);
  return schedule.turnOn === "asTheyWere"
    ? `Turning the lights on now brings back ${names} as they were ${when}.`
    : `Turning the lights on now brings back ${names}, the lights that were on ${when}.`;
}
