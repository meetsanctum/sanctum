import { replyTextMaxLength, type SpeechLanguage } from "@meetsanctum/app-sdk";

import { deColourNames, type Look } from "./sentences.js";
import { agentsPage } from "./tools.js";

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
  | { is: "on" | "off" | "brighter" | "dimmer" }
  | { is: "at"; percent: number }
  | { is: "look"; look: Look };

type RestoreIssue = "changed" | "offline" | "uncertain" | "limited" | "failed";

type ColourWarning = {
  minimumLength: number;
  appendTo(summary: string): string;
};

export type Replies = {
  changed(subject: Subject, state: LightsState): string;
  already(subject: Subject, state: LightsState): string;
  roomRules(state: LightsState, already: boolean): string;
  /** Dimmer leaves lights that are off alone. */
  allOff(subject: Subject): string;
  noLights(subject: Subject): string;
  notAnswering(subject: Subject): string;
  /** A colour, where no light can show one. */
  noColour(subject: Subject): string;
  /** A notice about the lights a colour left as they were. */
  cannotShowColour(names: readonly string[]): ColourWarning;
  missedLights(
    summary: string,
    names: readonly string[],
    allOffline: boolean,
    reserved?: number,
  ): string;
  nothingChanged: string;
  putBack: string;
  somePutBack: string;
  nothingPutBack: string;
  restoreIssues: Record<RestoreIssue, string>;
  changedSince: string;
  cannotPutBack: string;
  cannotUndoMood: string;
  /** A mood that ran, by its name and its room's. */
  moodSet(mood: string, room: string): string;
  /** No mood of that name where it was asked for. */
  noSuchMood(mood: string, room: string | null): string;
  /**
   * `run` refused: its own words, or where it's switched on: the app's
   * settings, or Settings' page for AI agents when a core area is off.
   */
  cannotRunMood(toolWords: string, appName: string): string;
  duplicateMood(mood: string, room: string | null): string;
  /** Several rooms have a mood of that name, and none was said. */
  whichMoodRoom(mood: string): string;
  lightOrMood: string;
  noTimers: string;
  notInARoom: string;
  whichRoom: string;
  whichNamed(kind: "room" | "floor" | "light", name: string): string;
  notAllowed: string;
  /** A tool's refusal in this language, where its own words are English. */
  failed(toolWords: string, error?: string): string;
};

const list = (names: readonly string[], and: string) =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;

function withNames(
  summary: string,
  names: readonly string[],
  and: string,
  more: (count: number) => string,
  ending: string,
  reserved = 0,
) {
  const limit =
    replyTextMaxLength - reserved - summary.length - 1 - ending.length;
  const full = list(names, and);
  if (full.length <= limit) return `${summary} ${full}${ending}`;

  const shown: string[] = [];
  let length = 0;
  for (const name of names) {
    const count = names.length - shown.length - 1;
    if (length + name.length + and.length + 2 + more(count).length > limit)
      break;
    shown.push(name);
    length += name.length + 2; // Each earlier name also takes a comma and space.
  }
  const shortened = list([...shown, more(names.length - shown.length)], and);
  return `${summary} ${shortened}${ending}`;
}

function colourWarning(
  names: readonly string[],
  and: string,
  more: (count: number) => string,
  ending: string,
): ColourWarning {
  return {
    minimumLength: 1 + more(names.length).length + ending.length,
    appendTo: (summary) => withNames(summary, names, and, more, ending),
  };
}

const enWhites = { picker: "white", warm: "warm white", cool: "cool white" };

const enState = (state: LightsState) => {
  if (state.is === "at") return `at ${state.percent}%`;
  if (state.is !== "look") return state.is;
  const { look } = state;
  if ("colour" in look) return look.colour.toLowerCase();
  return look.bright ? `bright ${enWhites[look.white]}` : enWhites[look.white];
};

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
  roomRules: (state, already) =>
    `Lights ${already ? "already " : ""}${enState(state)} where room rules allow.`,
  allOff: (subject) =>
    `${enSubject(subject)} ${subject.kind === "light" ? "is" : "are"} off.`,
  noLights: (subject) =>
    subject.kind === "home"
      ? "There are no lights."
      : `No lights in ${subject.name}.`,
  notAnswering: (subject) => `${enSubject(subject)} didn't answer.`,
  noColour: (subject) =>
    subject.kind === "home"
      ? "No light can show colours."
      : subject.kind === "place"
        ? `No light in ${subject.name} can show colours.`
        : `${subject.name} can't show colours.`,
  cannotShowColour: (names) =>
    colourWarning(
      names,
      "and",
      (count) => `${count} more`,
      " can't show colours.",
    ),
  missedLights: (summary, names, allOffline, reserved) =>
    withNames(
      summary,
      names,
      "and",
      (count) => `${count} more`,
      allOffline ? " didn't answer." : " couldn't be changed.",
      reserved,
    ),
  nothingChanged: "Nothing changed.",
  putBack: "Put back.",
  somePutBack: "Some lights were put back.",
  nothingPutBack: "Nothing was put back.",
  restoreIssues: {
    changed: "A light changed in the meantime.",
    offline: "A light is offline.",
    uncertain: "A light still has a command pending.",
    limited: "The device command limit blocked a restore.",
    failed: "A light couldn't be restored.",
  },
  changedSince: "Nothing put back: it changed since.",
  cannotPutBack: "There's nothing I can put back.",
  cannotUndoMood: "I can't undo a mood.",
  moodSet: (mood, room) => `${mood} in ${room}.`,
  noSuchMood: (mood, room) =>
    room
      ? `${room} has no mood called ${mood}.`
      : `There's no mood called ${mood}.`,
  cannotRunMood: (toolWords) => toolWords,
  duplicateMood: (mood, room) =>
    room
      ? `More than one mood in ${room} is called ${mood}.`
      : `More than one mood in the same room is called ${mood}.`,
  whichMoodRoom: (mood) =>
    `Which room? Several have a mood called ${mood}. Say the room too.`,
  lightOrMood:
    "Did you mean to change the lights or start a mood? Say ‘make’ for lights or ‘start’ for a mood.",
  noTimers: "I can't set timers yet.",
  notInARoom: "I'm not in a room yet. Choose my room in Settings, Devices.",
  whichRoom: "Which room's lights? Say the room too.",
  whichNamed: (kind, name) => `Which ${kind}? More than one is named ${name}.`,
  notAllowed: "I'm not allowed to do that.",
  failed: (toolWords) => toolWords,
};

const deWhites = { picker: "weiß", warm: "warmweiß", cool: "kaltweiß" };

const deState = (state: LightsState) => {
  if (state.is === "at") return `auf ${state.percent} %`;
  if (state.is !== "look") {
    return { on: "an", off: "aus", brighter: "heller", dimmer: "dunkler" }[
      state.is
    ];
  }
  const { look } = state;
  if ("colour" in look) return deColourNames[look.colour];
  return look.bright ? "hell" : deWhites[look.white];
};

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
  roomRules: (state, already) =>
    `Licht ${already ? "schon " : ""}${deState(state)}, wo es die Raumregeln erlauben.`,
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
  noColour: (subject) =>
    subject.kind === "home"
      ? "Kein Licht kann Farben zeigen."
      : subject.kind === "place"
        ? `${subject.name}: Kein Licht kann Farben zeigen.`
        : `${subject.name} kann keine Farben zeigen.`,
  cannotShowColour: (names) =>
    colourWarning(
      names,
      "und",
      (count) => `${count} weitere`,
      names.length > 1
        ? " können keine Farben zeigen."
        : " kann keine Farben zeigen.",
    ),
  missedLights: (summary, names, allOffline, reserved) =>
    withNames(
      summary,
      names,
      "und",
      (count) => `${count} weitere`,
      allOffline
        ? names.length > 1
          ? " antworten nicht."
          : " antwortet nicht."
        : names.length > 1
          ? " konnten nicht geändert werden."
          : " konnte nicht geändert werden.",
      reserved,
    ),
  nothingChanged: "Nichts geändert.",
  putBack: "Zurückgestellt.",
  somePutBack: "Einige Lichter wurden zurückgestellt.",
  nothingPutBack: "Nichts wurde zurückgestellt.",
  restoreIssues: {
    changed: "Ein Licht wurde inzwischen geändert.",
    offline: "Ein Licht ist offline.",
    uncertain: "Bei einem Licht steht noch ein Befehl aus.",
    limited:
      "Das Limit für Gerätebefehle hat eine Wiederherstellung verhindert.",
    failed: "Ein Licht konnte nicht zurückgestellt werden.",
  },
  changedSince: "Nichts zurückgestellt: es wurde inzwischen geändert.",
  cannotPutBack: "Da kann ich nichts zurückstellen.",
  cannotUndoMood: "Eine Stimmung kann ich nicht rückgängig machen.",
  moodSet: (mood, room) => `${room}: ${mood}.`,
  noSuchMood: (mood, room) =>
    room
      ? `${room}: keine Stimmung „${mood}“.`
      : `Es gibt keine Stimmung „${mood}“.`,
  // Where it's decided is the app's settings, whose words are English.
  // The core's words name the place; German names it too, as Settings'
  // pages are in English.
  cannotRunMood: (toolWords, appName) =>
    toolWords.includes(agentsPage)
      ? `Ich darf diese Stimmung nicht starten. Das lässt sich unter ${agentsPage} einschalten.`
      : `Ich darf diese Stimmung nicht starten. Das lässt sich in den Einstellungen von ${appName} einschalten.`,
  duplicateMood: (mood, room) =>
    room
      ? `${room}: Mehrere Stimmungen heißen „${mood}“.`
      : `Mehrere Stimmungen im selben Raum heißen „${mood}“.`,
  whichMoodRoom: (mood) =>
    `Welcher Raum? Mehrere haben die Stimmung „${mood}“. Sag den Raum mit dazu.`,
  lightOrMood:
    "Möchtest du das Licht ändern oder eine Stimmung starten? Sag „mach“ für das Licht oder „starte“ für die Stimmung.",
  noTimers: "Ich kann noch keine Timer stellen.",
  notInARoom:
    "Ich bin noch in keinem Raum. Wähle meinen Raum unter Settings, Devices.",
  whichRoom: "Welcher Raum? Sag den Raum mit dazu.",
  whichNamed: (kind, name) =>
    `Mehrere ${{ room: "Räume", floor: "Etagen", light: "Lampen" }[kind]} heißen „${name}“. Welche davon meinst du?`,
  notAllowed: "Das darf ich nicht.",
  failed: (_toolWords, error) => {
    if (error === "limited") {
      return "Zu viele Anfragen. Versuch es in einer Minute noch einmal.";
    }
    if (error === "timeout")
      return "Die App hat nicht rechtzeitig geantwortet.";
    return "Das hat nicht geklappt.";
  },
};

export const replies: Record<SpeechLanguage, Replies> = { en, de };
