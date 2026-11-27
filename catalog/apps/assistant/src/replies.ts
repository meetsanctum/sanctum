import type { RequestLanguage } from "@meetsanctum/app-sdk";

// What the Assistant answers, in each language: short, since a smart speaker
// says it, and naming what changed by the home's own names. The names keep
// the household's spelling and take no article, as a room's name may not
// fit one ("Lena's Room").

/** What a reply is about: a room's or floor's lights, one light or all. */
export type Subject =
  | { kind: "place"; name: string }
  | { kind: "light"; name: string }
  | { kind: "home" };

/** What happened to the lights, or what they already are. */
export type LightsState =
  { is: "on" | "off" | "brighter" | "dimmer" } | { is: "at"; percent: number };

export type Replies = {
  changed(subject: Subject, state: LightsState): string;
  already(subject: Subject, state: LightsState): string;
  /** Dimmer leaves lights that are off alone. */
  allOff(subject: Subject): string;
  noLights(subject: Subject): string;
  notAnswering(subject: Subject): string;
  /** After what changed: the lights that didn't, by name. */
  didNotAnswer(names: readonly string[]): string;
  nothingChanged: string;
  putBack: string;
  changedSince: string;
  cannotPutBack: string;
  noTimers: string;
  notInARoom: string;
  whichRoom: string;
  notAllowed: string;
  /** A tool's refusal in this language, where its own words are English. */
  failed(toolWords: string): string;
};

const list = (names: readonly string[], and: string) =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;

const enState = (state: LightsState) =>
  state.is === "at" ? `at ${state.percent}%` : state.is;

const enSubject = (subject: Subject) =>
  subject.kind === "home"
    ? "All lights"
    : subject.kind === "place"
      ? `${subject.name} lights`
      : subject.name;

const en: Replies = {
  changed: (subject, state) => `${enSubject(subject)} ${enState(state)}.`,
  already: (subject, state) =>
    `${enSubject(subject)} already ${enState(state)}.`,
  allOff: (subject) =>
    `${enSubject(subject)} ${subject.kind === "light" ? "is" : "are"} off.`,
  noLights: (subject) =>
    subject.kind === "home"
      ? "There are no lights."
      : `No lights in ${subject.name}.`,
  notAnswering: (subject) => `${enSubject(subject)} didn't answer.`,
  didNotAnswer: (names) => `${list(names, "and")} didn't answer.`,
  nothingChanged: "Nothing changed.",
  putBack: "Put back.",
  changedSince: "Nothing put back: it changed since.",
  cannotPutBack: "There's nothing I can put back.",
  noTimers: "I can't set timers yet.",
  notInARoom: "I'm not in a room yet. Choose my room in Settings, Devices.",
  whichRoom: "Which room's lights? Say the room too.",
  notAllowed: "I'm not allowed to do that.",
  failed: (toolWords) => toolWords,
};

const deState = (state: LightsState) =>
  ({
    on: "an",
    off: "aus",
    brighter: "heller",
    dimmer: "dunkler",
    at: `auf ${"percent" in state ? state.percent : 0} %`,
  })[state.is];

// "Küche: Licht an", since a room's article in German goes by its name.
const deSaid = (subject: Subject, words: string) =>
  subject.kind === "home"
    ? `Alle Lichter ${words}.`
    : subject.kind === "place"
      ? `${subject.name}: Licht ${words}.`
      : `${subject.name} ${words}.`;

const de: Replies = {
  changed: (subject, state) => deSaid(subject, deState(state)),
  already: (subject, state) => deSaid(subject, `schon ${deState(state)}`),
  allOff: (subject) =>
    deSaid(subject, subject.kind === "home" ? "sind aus" : "ist aus"),
  noLights: (subject) =>
    subject.kind === "home"
      ? "Es gibt kein Licht."
      : `${subject.name}: kein Licht.`,
  notAnswering: (subject) =>
    deSaid(
      subject,
      subject.kind === "home" ? "antworten nicht" : "antwortet nicht",
    ),
  didNotAnswer: (names) =>
    `${list(names, "und")} ${names.length > 1 ? "antworten" : "antwortet"} nicht.`,
  nothingChanged: "Nichts geändert.",
  putBack: "Zurückgestellt.",
  changedSince: "Nichts zurückgestellt: es wurde inzwischen geändert.",
  cannotPutBack: "Da kann ich nichts zurückstellen.",
  noTimers: "Ich kann noch keine Timer stellen.",
  notInARoom:
    "Ich bin noch in keinem Raum. Wähle meinen Raum unter Settings, Devices.",
  whichRoom: "Welcher Raum? Sag den Raum mit dazu.",
  notAllowed: "Das darf ich nicht.",
  failed: () => "Das hat nicht geklappt.",
};

export const replies: Record<RequestLanguage, Replies> = { en, de };
