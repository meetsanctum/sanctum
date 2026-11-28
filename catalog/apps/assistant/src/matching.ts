import type { SentenceBlank } from "@meetsanctum/app-sdk";

import type {
  ChoiceName,
  Choices,
  Intent,
  LanguageSentences,
  Look,
} from "./sentences.js";

// Matches what someone said or typed against the Assistant's templates, with
// the home's names in their blanks. Speech recognition hands back the words
// of one template, so a spoken request matches exactly; a typed one matches
// when it is one of the sentences, in any case and with punctuation. Words
// match whole, so "turn on" never matches "turnon" and a name never matches
// inside a longer word.

/** The home's names for each blank, as the home writes them. */
export type HomeNames = Record<SentenceBlank, readonly string[]>;

/** A sentence that matched: what it asks, the names in it and its choices. */
export type Matched = {
  intent: Intent;
  names: Partial<Record<SentenceBlank, string>>;
  choices: {
    switch?: "on" | "off";
    step?: "brighter" | "dimmer";
    percent?: number;
    look?: Look;
  };
};

const notLetter = "(?<![\\p{L}\\p{N}])";
const notLetterAfter = "(?![\\p{L}\\p{N}])";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lower case, one space between words, one kind of apostrophe, and no
 * punctuation but within names.
 */
export function normalized(text: string) {
  return text
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.,!?;:"“”„«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whole words, in any order of the given words, longest first, so a longer
// name wins over one it starts with ("Office Light" over "Office").
function wordsPattern(words: readonly string[]) {
  const unique = [...new Set(words.map(normalized).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  return unique
    .map((word) => word.split(" ").map(escape).join("\\s+"))
    .join("|");
}

/** A template as a regular expression, or null when a blank has no names. */
export function compile(
  template: string,
  choices: Choices,
  names: HomeNames,
): RegExp | null {
  let pattern = "";
  const tokens =
    template.match(
      /<percent>\s+\p{L}+|\{[^{}]*\}|<[^<>]*>|[()[\]|]|\s+|[^\s()[\]{}<>|]+/gu,
    ) ?? [];
  for (const token of tokens) {
    if (token === "(" || token === "[") pattern += "(?:";
    else if (token === ")") pattern += ")";
    else if (token === "]") pattern += ")?";
    else if (token === "|") pattern += "|";
    else if (/^\s+$/u.test(token)) pattern += "\\s*";
    else if (token.startsWith("{")) {
      const blank = token.slice(1, -1) as SentenceBlank;
      const alternatives = wordsPattern(names[blank] ?? []);
      if (!alternatives) return null;
      pattern += `${notLetter}(?<${blank}>${alternatives})${notLetterAfter}`;
    } else if (token.startsWith("<percent>") && token !== "<percent>") {
      // Digits and the % sign belong to the brightness value, never a name.
      const unit = escape(normalized(token.slice("<percent>".length)));
      const spelled = wordsPattern(Object.keys(choices.percent));
      pattern += `${notLetter}(?:(?<percent>${spelled})\\s+${unit}|(?<digits>[0-9]{1,3})\\s*(?:%|${unit}))${notLetterAfter}`;
    } else if (token.startsWith("<")) {
      const choice = token.slice(1, -1) as ChoiceName;
      pattern += `${notLetter}(?<${choice}>${wordsPattern(Object.keys(choices[choice]))})${notLetterAfter}`;
    } else {
      pattern += `${notLetter}${escape(normalized(token))}${notLetterAfter}`;
    }
  }
  return new RegExp(`^\\s*${pattern}\\s*$`, "u");
}

// The name as the home writes it, for the words that matched it.
function nameOf(names: readonly string[], matched: string) {
  return names.find((name) => normalized(name) === normalized(matched));
}

/** The first sentence that matches the words, or null for none. */
export function match(
  text: string,
  language: LanguageSentences,
  names: HomeNames,
): Matched | null {
  const words = normalized(text);
  for (const { template, intent } of language.sentences) {
    const found = compile(template, language.choices, names)?.exec(words);
    if (!found) continue;
    const groups = found.groups ?? {};
    const matched: Matched = { intent, names: {}, choices: {} };
    for (const blank of ["room", "floor", "light", "mood"] as const) {
      const said = groups[blank];
      if (said === undefined) continue;
      const name = nameOf(names[blank], said);
      if (name !== undefined) matched.names[blank] = name;
    }
    const choice = <Name extends ChoiceName>(name: Name) => {
      const said = groups[name];
      return said === undefined
        ? undefined
        : (language.choices[name][normalized(said)] as Choices[Name][string]);
    };
    const switched = choice("switch");
    if (switched !== undefined) matched.choices.switch = switched;
    const step = choice("step");
    if (step !== undefined) matched.choices.step = step;
    const look = choice("look");
    if (look !== undefined) matched.choices.look = look;
    const percent =
      groups.digits === undefined ? choice("percent") : Number(groups.digits);
    if (percent !== undefined) {
      if (
        groups.digits !== undefined &&
        !Object.values(language.choices.percent).includes(percent)
      ) {
        continue;
      }
      matched.choices.percent = percent;
    }
    return matched;
  }
  return null;
}
