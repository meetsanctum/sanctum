// Date formatters for the home clock (clock.ts) and words.ts: kept for the
// most recent 128 options, since making one costs and options such as the
// home's time zone can change.

const formats = new Map<string, Intl.DateTimeFormat>();
const maxFormats = 128;

export function dateFormatter(
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

export const invalidDate = "Invalid Date";

// Match Date's display for an invalid instant without asking Intl to format it.
export function formatDate(
  at: Date | number,
  getFormatter: () => Intl.DateTimeFormat,
) {
  const time = typeof at === "number" ? at : at.getTime();
  if (!Number.isFinite(time) || Math.abs(time) > 8_640_000_000_000_000)
    return invalidDate;
  return getFormatter().format(time);
}
