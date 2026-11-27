import { dateFormatter, formatDate } from "./date-format.js";
import { languages, type Language } from "./languages.js";

// How Sanctum writes numbers, counts, lists and dates, and sorts names, in
// a language: each in the locale its catalog entry names, with the `Intl`
// object reused per language and options, since making one is what costs
// on a slow device.

const made = new Map<string, unknown>();

function once<T>(key: string, make: () => T): T {
  let found = made.get(key) as T | undefined;
  if (found === undefined) {
    found = make();
    made.set(key, found);
  }
  return found;
}

const localeOf = (language: Language) => languages[language].locale;

const numberOptionNames = [
  "localeMatcher",
  "numberingSystem",
  "style",
  "currency",
  "currencyDisplay",
  "currencySign",
  "unit",
  "unitDisplay",
  "notation",
  "minimumIntegerDigits",
  "minimumFractionDigits",
  "maximumFractionDigits",
  "minimumSignificantDigits",
  "maximumSignificantDigits",
  "roundingIncrement",
  "roundingMode",
  "roundingPriority",
  "trailingZeroDisplay",
  "compactDisplay",
  "useGrouping",
  "signDisplay",
];

const dateOptionNames = [
  "localeMatcher",
  "calendar",
  "numberingSystem",
  "hour12",
  "hourCycle",
  "timeZone",
  "weekday",
  "era",
  "year",
  "month",
  "day",
  "dayPeriod",
  "hour",
  "minute",
  "second",
  "fractionalSecondDigits",
  "timeZoneName",
  "formatMatcher",
  "dateStyle",
  "timeStyle",
];

// Intl reads inherited options too. Use the same values for the cache key
// and the formatter, and leave coercion of unusual values to Intl.
function readOptions<T extends object>(options: T, names: readonly string[]) {
  const values = Object.create(null) as Record<string, unknown>;
  let cacheable = true;
  for (const name of names) {
    const value: unknown = Reflect.get(options, name);
    if (value === undefined) continue;
    values[name] = value;
    cacheable &&=
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value));
  }
  return {
    values: values as T,
    key: cacheable ? JSON.stringify(values) : null,
  };
}

/** A number as the language writes it: "1,250.5" in English. */
export function number(
  language: Language,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  const locale = localeOf(language);
  const { values, key } =
    options === undefined
      ? { values: undefined, key: "{}" }
      : readOptions(options, numberOptionNames);
  if (key === null) return new Intl.NumberFormat(locale, values).format(value);
  return once(
    `number|${language}|${key}`,
    () => new Intl.NumberFormat(locale, values),
  ).format(value);
}

/**
 * A count with the noun its number takes, "# " standing for the count:
 * plural("en", 3, { one: "# light", other: "# lights" }) is "3 lights".
 */
export type PluralForms = { one: string; other: string } & Partial<
  Record<Exclude<Intl.LDMLPluralRule, "one" | "other">, string>
>;

export function plural(
  language: Language,
  count: number,
  forms: PluralForms,
): string {
  const rules = once(
    `plural|${language}`,
    () => new Intl.PluralRules(localeOf(language)),
  );
  const form = forms[rules.select(count)] ?? forms.other;
  return form.replaceAll("#", number(language, count));
}

/**
 * Items as one list, "a, b and c" in English, or "a, b or c" for a choice
 * between them. One item is itself, none is "".
 */
export function list(
  language: Language,
  items: readonly string[],
  type: "conjunction" | "disjunction" = "conjunction",
): string {
  return once(
    `list|${language}|${type}`,
    () => new Intl.ListFormat(localeOf(language), { type }),
  ).format(items);
}

/** A date or time as the language writes it, or "Invalid Date" for an invalid instant. */
export function date(
  language: Language,
  value: Date | number,
  options: Intl.DateTimeFormatOptions,
): string {
  return formatDate(value, () => {
    const locale = localeOf(language);
    const { values, key } = readOptions(options, dateOptionNames);
    return key === null
      ? new Intl.DateTimeFormat(locale, values)
      : dateFormatter(`words|${language}|${key}`, locale, values);
  });
}

/**
 * How the language orders names, numbers within them by their value:
 * "Light 2" before "Light 10". For sorting what people read, not ids.
 */
export function compare(language: Language): (a: string, b: string) => number {
  return once(
    `compare|${language}`,
    () => new Intl.Collator(localeOf(language), { numeric: true }).compare,
  );
}
