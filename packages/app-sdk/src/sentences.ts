import { z } from "zod";

import { requestLanguages, type RequestLanguage } from "./requests.js";

// The sentences Sanctum's Assistant understands when someone speaks to a
// smart speaker, per language: the core teaches them to speech recognition,
// which then hears only these, so speech outside them comes back empty. The
// Assistant declares them in its definition (`defineApp({ sentences })`),
// so they come in its manifest and an update brings new ones.
//
// Each is a template in hassil's syntax: `(a|b)` for alternatives, `[a]` for
// what may be left out, and `{blank}` for one of the home's names, which the
// core fills in as it teaches: its rooms, floors, lights and moods. Anything
// else, numbers included ("forty percent"), is written out in the template,
// since recognition takes no ranges. Speech that matches comes back as the
// words of one template, which the Assistant matches again.

/** The home's names a template may leave blank, which the core fills in. */
export const sentenceBlanks = ["room", "floor", "light", "mood"] as const;
export type SentenceBlank = (typeof sentenceBlanks)[number];

export type AssistantSentences = Partial<Record<RequestLanguage, string[]>>;

export const sentenceLimits = {
  /** Templates in one language. */
  perLanguage: 500,
  /** Characters in one template. */
  length: 256,
  /**
   * The steps speech recognition may take to build a language's grammar on
   * a Pi 4, as its image allows (deploy/speech-to-phrase).
   */
  grammarSteps: 250_000,
} as const;

/**
 * A larger home than most, which a list of sentences must fit before the
 * Assistant can be installed: so many names of each, this long on average.
 */
export const referenceHome: Record<
  SentenceBlank,
  { count: number; length: number }
> = {
  room: { count: 30, length: 16 },
  floor: { count: 5, length: 16 },
  light: { count: 150, length: 20 },
  mood: { count: 60, length: 16 },
};

const blankPattern = /\{([^{}]*)\}/g;

const overBudget = sentenceLimits.grammarSteps + 1;

// The recognizer builds each variant of a word before tokenizing it.
// Spaces and list references end a word, so choices across those breaks
// never multiply together.
function joinedWordSteps(template: string) {
  const tokens = template.match(/\{[^{}]*\}|[^\s()[\]{}|]+|./gsu) ?? [];
  let index = 0;
  let steps = 0;

  function alternatives(): { count: number; length: number } | null {
    let count = 0;
    let length = 0;
    let allFragments = true;
    for (;;) {
      let choices = 1;
      let wordLength = 0;
      let parts = 0;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === "|" || token === ")" || token === "]") break;
        index++;
        let part: { count: number; length: number } | null;
        if (token === "(" || token === "[") {
          part = alternatives();
          if (tokens[index] === (token === "(" ? ")" : "]")) index++;
          if (part && token === "[") part.count++;
        } else {
          part = /^(?:\s|\{)/u.test(token)
            ? null
            : { count: 1, length: token.length };
        }
        if (!part) {
          allFragments = false;
          choices = 1;
          wordLength = 0;
          parts = 0;
          continue;
        }
        choices = Math.min(overBudget, choices * part.count);
        wordLength += part.length;
        parts++;
        if (parts > 1 && choices > 1) {
          steps = Math.min(overBudget, steps + choices * (1 + 4 * wordLength));
        }
      }
      count = Math.min(overBudget, count + choices);
      length = Math.max(length, wordLength);
      if (tokens[index] !== "|") break;
      index++;
    }
    return allFragments ? { count, length } : null;
  }

  alternatives();
  return steps;
}

/**
 * About how many steps speech recognition takes to build the grammar for
 * these templates with these names. Count the ordinary text and list cost
 * and allow for the variants formed by adjacent fragments in a word.
 */
export function grammarSteps(
  templates: readonly string[],
  names: Partial<Record<SentenceBlank, readonly string[]>>,
) {
  let steps = 0;
  for (const template of templates) {
    steps +=
      template.replace(blankPattern, "").length * 4 + joinedWordSteps(template);
    if (steps >= overBudget) return overBudget;
    for (const [, blank] of template.matchAll(blankPattern)) {
      if (!Object.hasOwn(names, blank!)) continue;
      for (const name of names[blank as SentenceBlank] ?? []) {
        steps += (name.length + 1) * 4;
        if (steps >= overBudget) return overBudget;
      }
    }
  }
  return steps;
}

const referenceNames = Object.fromEntries(
  sentenceBlanks.map((blank) => [
    blank,
    Array.from({ length: referenceHome[blank].count }, () =>
      "x".repeat(referenceHome[blank].length),
    ),
  ]),
) as Record<SentenceBlank, string[]>;

// Brackets that open and close in order, and blanks with none inside.
function bracketsIssue(template: string) {
  const open: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const character of template) {
    if (character === "(" || character === "[" || character === "{") {
      if (open.at(-1) === "{") return "a blank can't hold brackets";
      open.push(character);
    } else if (character in pairs) {
      if (open.pop() !== pairs[character]) return "its brackets don't match";
    }
  }
  return open.length > 0 ? "its brackets don't match" : null;
}

/** What's wrong with a list of sentences, or nothing. */
export function sentenceIssues(sentences: unknown): string[] {
  const parsed = assistantSentencesSchema.safeParse(sentences);
  if (!parsed.success) {
    return [`Its sentences don't fit: ${z.prettifyError(parsed.error)}`];
  }
  const issues: string[] = [];
  for (const [language, templates] of Object.entries(parsed.data)) {
    for (const template of templates ?? []) {
      const brackets = bracketsIssue(template);
      if (brackets) issues.push(`"${template}" (${language}): ${brackets}`);
      for (const [, blank] of template.matchAll(blankPattern)) {
        if (!(sentenceBlanks as readonly string[]).includes(blank!)) {
          issues.push(
            `"${template}" (${language}) leaves {${blank}} blank, which isn't one of ${sentenceBlanks.join(", ")}`,
          );
        }
      }
    }
    const steps = grammarSteps(templates ?? [], referenceNames);
    if (steps > sentenceLimits.grammarSteps) {
      issues.push(
        `Its ${language} sentences take about ${steps.toLocaleString("en")} steps to learn in a large home, over ${sentenceLimits.grammarSteps.toLocaleString("en")}`,
      );
    }
  }
  return issues;
}

export const assistantSentencesSchema = z.partialRecord(
  z.enum(requestLanguages),
  z
    .array(z.string().trim().min(1).max(sentenceLimits.length))
    .min(1)
    .max(sentenceLimits.perLanguage),
) satisfies z.ZodType<AssistantSentences>;

/**
 * What a smart speaker says, in each language, for speech outside the
 * Assistant's sentences, such as "I can only help with lights and moods":
 * the Assistant's, since it knows what it understands. Silence gets nothing.
 */
export type NotUnderstood = Partial<Record<RequestLanguage, string>>;

/** How long a not-understood reply is at most. */
export const notUnderstoodMaxLength = 200;

export const notUnderstoodSchema = z.partialRecord(
  z.enum(requestLanguages),
  z.string().max(notUnderstoodMaxLength).trim().min(1),
) satisfies z.ZodType<NotUnderstood>;

/** What's wrong with not-understood replies, or nothing. */
export function notUnderstoodIssues(
  notUnderstood: unknown,
  sentences: AssistantSentences | undefined,
): string[] {
  const parsed = notUnderstoodSchema.safeParse(notUnderstood);
  if (!parsed.success) {
    return [
      `Its not-understood replies don't fit: ${z.prettifyError(parsed.error)}`,
    ];
  }
  return Object.keys(parsed.data)
    .filter((language) => !sentences?.[language as RequestLanguage])
    .map(
      (language) =>
        `It says what it didn't understand in ${language}, but has no ${language} sentences`,
    );
}
