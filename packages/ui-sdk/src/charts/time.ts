// The times and days the charts write, in the device's own time zone: a time
// of day as 07:30, a day's name as Mon and a date as Mon 3 Nov, each a
// default a chart's props can replace.

export const hourMs = 60 * 60_000;
export const dayMs = 24 * hourMs;

/** A time of day, such as 07:30. */
export function timeText(at: number) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Local midnight of the day `at` is in, `daysBack` days before. */
export function midnight(at: number, daysBack = 0) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

/** The local hours every 6 within the day, whatever the clocks did. */
export function sixHours(from: number, now: number) {
  const hours: number[] = [];
  for (
    const day = new Date(from);
    day.getTime() < now;
    day.setHours(24, 0, 0, 0)
  ) {
    for (const hour of [0, 6, 12, 18]) {
      const tick = new Date(day);
      const at = tick.setHours(hour, 0, 0, 0);
      // A clock change can move a skipped hour forward.
      if (
        at > from &&
        at < now &&
        tick.getHours() === hour &&
        tick.getMinutes() === 0 &&
        tick.getSeconds() === 0
      ) {
        hours.push(at);
      }
    }
  }
  return hours;
}

const weekdayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const dayAndDateFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** A day's name under its column, such as Mon. */
export const weekdayText = (start: number) => weekdayFormat.format(start);

/** A day and its date, such as Mon 3 Nov. */
export const dateText = (start: number) => dayAndDateFormat.format(start);
