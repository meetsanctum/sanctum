import { languages, type Language } from "./languages.js";

// How Sanctum writes numbers, counts, lists and dates, and sorts names, in
// a language: each in the locale its catalog entry names, with the `Intl`
// object made once per language and options, since making one is what
// costs on a slow device, not using it.

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

/** A number as the language writes it: "1,250.5" in English. */
export function number(
  language: Language,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return once(
    `number|${language}|${JSON.stringify(options ?? {})}`,
    () => new Intl.NumberFormat(localeOf(language), options),
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

/** A date or time as the language writes it, with the options given. */
export function date(
  language: Language,
  value: Date | number,
  options: Intl.DateTimeFormatOptions,
): string {
  return once(
    `date|${language}|${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(localeOf(language), options),
  ).format(value);
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
