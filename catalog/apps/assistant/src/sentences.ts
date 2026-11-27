import type {
  AssistantSentences,
  NotUnderstood,
  RequestLanguage,
  SentenceBlank,
} from "@meetsanctum/app-sdk";

// What the Assistant understands, in each language: templates in hassil's
// syntax, as speech recognition learns them, each with what it asks for.
// The same templates match what was said or typed again (matching.ts), so
// speech recognition and the Assistant never disagree on what a sentence
// means.
//
// Besides the core's blanks ({room}, {floor}, {light}), a template may hold
// a choice, `<switch>`, `<step>` or `<percent>`: the words it may be, which
// it is said as for speech recognition and read back as a value. Numbers
// are written out, since recognition takes no ranges.

/** Where a request's lights are. */
export type Where = "here" | SentenceBlank | "home";

/** What a sentence asks for, before the home's names are looked up. */
export type Intent =
  | { do: "switch"; where: Where }
  | { do: "step"; where: Where; to?: "brighter" | "dimmer" }
  | { do: "set"; where: Where }
  | { do: "mood"; where: "here" | "room" }
  | { do: "restore" }
  | { do: "timer" };

export type ChoiceName = "switch" | "step" | "percent";

/** Each choice's words, and what each means. */
export type Choices = {
  switch: Record<string, "on" | "off">;
  step: Record<string, "brighter" | "dimmer">;
  percent: Record<string, number>;
};

export type Sentence = { template: string; intent: Intent };

export type Language = {
  choices: Choices;
  sentences: Sentence[];
  /** Said for speech outside the sentences, and written for typed words. */
  notUnderstood: string;
};

const switchOf = (where: Where): Intent => ({ do: "switch", where });
const stepOf = (where: Where, to?: "brighter" | "dimmer"): Intent =>
  to ? { do: "step", where, to } : { do: "step", where };
const setOf = (where: Where): Intent => ({ do: "set", where });

// A named light before a room's lights: "turn off the office light" means
// the light called Office Light where there is one.
const en: Language = {
  choices: {
    switch: { on: "on", off: "off" },
    step: {
      brighter: "brighter",
      up: "brighter",
      dimmer: "dimmer",
      down: "dimmer",
    },
    percent: {
      five: 5,
      ten: 10,
      twenty: 20,
      "twenty five": 25,
      thirty: 30,
      forty: 40,
      fifty: 50,
      sixty: 60,
      seventy: 70,
      "seventy five": 75,
      eighty: 80,
      ninety: 90,
      "a hundred": 100,
      "one hundred": 100,
    },
  },
  sentences: [
    // On and off.
    {
      template: "(turn|switch) <switch> [the] {light}",
      intent: switchOf("light"),
    },
    {
      template: "(turn|switch) [the] {light} <switch>",
      intent: switchOf("light"),
    },
    {
      template: "(turn|switch) <switch> [the] (light|lights) in [the] {room}",
      intent: switchOf("room"),
    },
    {
      template: "(turn|switch) [the] (light|lights) in [the] {room} <switch>",
      intent: switchOf("room"),
    },
    {
      template: "(turn|switch) <switch> [the] {room} (light|lights)",
      intent: switchOf("room"),
    },
    {
      template: "(turn|switch) [the] {room} (light|lights) <switch>",
      intent: switchOf("room"),
    },
    { template: "{room} (light|lights) <switch>", intent: switchOf("room") },
    {
      template: "(turn|switch) <switch> [the] (light|lights) on [the] {floor}",
      intent: switchOf("floor"),
    },
    {
      template: "(turn|switch) <switch> [the] {floor} (light|lights)",
      intent: switchOf("floor"),
    },
    {
      template: "(turn|switch) <switch> all [of] [the] lights",
      intent: switchOf("home"),
    },
    {
      template: "(turn|switch) all [of] [the] lights <switch>",
      intent: switchOf("home"),
    },
    {
      template:
        "(turn|switch) <switch> [the] lights (everywhere|in the whole (house|home))",
      intent: switchOf("home"),
    },
    {
      template: "(turn|switch) <switch> [the] (light|lights)",
      intent: switchOf("here"),
    },
    {
      template: "(turn|switch) [the] (light|lights) <switch>",
      intent: switchOf("here"),
    },
    { template: "[the] (light|lights) <switch>", intent: switchOf("here") },
    // Brighter and dimmer.
    { template: "(make|turn) [the] {light} <step>", intent: stepOf("light") },
    {
      template: "(make|turn) [the] (light|lights) in [the] {room} <step>",
      intent: stepOf("room"),
    },
    {
      template: "(make|turn) [the] {room} (light|lights) <step>",
      intent: stepOf("room"),
    },
    {
      template: "dim [the] (light|lights) in [the] {room}",
      intent: stepOf("room", "dimmer"),
    },
    {
      template: "brighten [the] (light|lights) in [the] {room}",
      intent: stepOf("room", "brighter"),
    },
    {
      template: "(make|turn) [the] (light|lights) on [the] {floor} <step>",
      intent: stepOf("floor"),
    },
    {
      template: "(make|turn) all [of] [the] lights <step>",
      intent: stepOf("home"),
    },
    {
      template: "(make|turn) [the] (light|lights) <step>",
      intent: stepOf("here"),
    },
    { template: "dim [the] (light|lights)", intent: stepOf("here", "dimmer") },
    {
      template: "brighten [the] (light|lights)",
      intent: stepOf("here", "brighter"),
    },
    { template: "[the] (light|lights) <step>", intent: stepOf("here") },
    // To a brightness.
    {
      template: "(set|dim|turn) [the] {light} to <percent> percent",
      intent: setOf("light"),
    },
    {
      template:
        "(set|dim|turn) [the] (light|lights) in [the] {room} to <percent> percent",
      intent: setOf("room"),
    },
    {
      template:
        "(set|dim|turn) [the] {room} (light|lights) to <percent> percent",
      intent: setOf("room"),
    },
    {
      template:
        "(set|dim|turn) [the] (light|lights) on [the] {floor} to <percent> percent",
      intent: setOf("floor"),
    },
    {
      template: "(set|dim|turn) all [of] [the] lights to <percent> percent",
      intent: setOf("home"),
    },
    {
      template: "(set|dim|turn) [the] (light|lights) to <percent> percent",
      intent: setOf("here"),
    },
    // A room's mood, by its name: after the lights, so a light's name wins.
    {
      template: "(set|switch|change) [the] {room} to {mood}",
      intent: { do: "mood", where: "room" },
    },
    {
      template: "(set|start|turn on) {mood} in [the] {room}",
      intent: { do: "mood", where: "room" },
    },
    {
      template: "{mood} in [the] {room}",
      intent: { do: "mood", where: "room" },
    },
    {
      template: "(set|start|turn on) [the] {mood} [mood]",
      intent: { do: "mood", where: "here" },
    },
    {
      template: "set the mood to {mood}",
      intent: { do: "mood", where: "here" },
    },
    // Putting back what it did.
    { template: "(put|change|set) it back", intent: { do: "restore" } },
    { template: "(put|turn) [the] lights back", intent: { do: "restore" } },
    { template: "undo [(that|it)]", intent: { do: "restore" } },
    // Timers, which it can't set.
    {
      template:
        "(set|start) a timer [for (one|two|three|five|ten|fifteen|twenty|thirty|forty five|sixty) (second|seconds|minute|minutes|hour|hours)]",
      intent: { do: "timer" },
    },
    {
      template:
        "(set|start) a (one|two|three|five|ten|fifteen|twenty|thirty|forty five|sixty) (second|minute|hour) timer",
      intent: { do: "timer" },
    },
  ],
  notUnderstood: "I can only help with lights and moods.",
};

// German names rooms with an article of their own ("im Büro", "in der
// Küche"), which the sentences take in any form.
const de: Language = {
  choices: {
    switch: { an: "on", ein: "on", aus: "off" },
    step: { heller: "brighter", dunkler: "dimmer" },
    percent: {
      fünf: 5,
      zehn: 10,
      zwanzig: 20,
      fünfundzwanzig: 25,
      dreißig: 30,
      vierzig: 40,
      fünfzig: 50,
      sechzig: 60,
      siebzig: 70,
      fünfundsiebzig: 75,
      achtzig: 80,
      neunzig: 90,
      hundert: 100,
    },
  },
  sentences: [
    // An und aus.
    {
      template: "(schalte|schalt|mach|mache) [(das|die|den)] {light} <switch>",
      intent: switchOf("light"),
    },
    {
      template:
        "(schalte|schalt|mach|mache) [(das|die)] (Licht|Lichter|Lampen) (im|in der|in den|in|auf dem|auf der) {room} <switch>",
      intent: switchOf("room"),
    },
    {
      template:
        "(schalte|schalt|mach|mache) (im|in der|in den|in|auf dem|auf der) {room} [(das|die)] (Licht|Lichter|Lampen) <switch>",
      intent: switchOf("room"),
    },
    {
      template:
        "(Licht|Lichter) (im|in der|in den|in|auf dem|auf der) {room} <switch>",
      intent: switchOf("room"),
    },
    {
      template:
        "(schalte|schalt|mach|mache) [(das|die)] (Licht|Lichter|Lampen) (im|in der|in den|in|auf dem|auf der) {floor} <switch>",
      intent: switchOf("floor"),
    },
    {
      template: "(schalte|schalt|mach|mache) alle (Lichter|Lampen) <switch>",
      intent: switchOf("home"),
    },
    {
      template:
        "(schalte|schalt|mach|mache) [(das|die)] (Licht|Lichter|Lampen) (überall|im ganzen Haus) <switch>",
      intent: switchOf("home"),
    },
    {
      template:
        "(schalte|schalt|mach|mache) überall [(das|die)] (Licht|Lichter|Lampen) <switch>",
      intent: switchOf("home"),
    },
    {
      template:
        "(schalte|schalt|mach|mache) [(das|die)] (Licht|Lichter|Lampen) <switch>",
      intent: switchOf("here"),
    },
    { template: "[das] (Licht|Lichter) <switch>", intent: switchOf("here") },
    // Heller und dunkler.
    {
      template: "(mach|mache) [(das|die|den)] {light} <step>",
      intent: stepOf("light"),
    },
    {
      template:
        "(mach|mache) [(das|die)] (Licht|Lichter|Lampen) (im|in der|in den|in|auf dem|auf der) {room} <step>",
      intent: stepOf("room"),
    },
    {
      template:
        "(dimm|dimme) [(das|die)] (Licht|Lichter|Lampen) (im|in der|in den|in|auf dem|auf der) {room}",
      intent: stepOf("room", "dimmer"),
    },
    {
      template:
        "(mach|mache) [(das|die)] (Licht|Lichter|Lampen) (im|in der|in den|in|auf dem|auf der) {floor} <step>",
      intent: stepOf("floor"),
    },
    {
      template: "(mach|mache) alle (Lichter|Lampen) <step>",
      intent: stepOf("home"),
    },
    {
      template: "(mach|mache) [(das|die)] (Licht|Lichter|Lampen) <step>",
      intent: stepOf("here"),
    },
    {
      template: "(dimm|dimme) [(das|die)] (Licht|Lichter|Lampen)",
      intent: stepOf("here", "dimmer"),
    },
    // Auf eine Helligkeit.
    {
      template:
        "(stell|stelle|dimm|dimme|mach|mache) [(das|die|den)] {light} auf <percent> Prozent",
      intent: setOf("light"),
    },
    {
      template:
        "(stell|stelle|dimm|dimme|mach|mache) [(das|die)] (Licht|Lichter|Lampen) (im|in der|in den|in|auf dem|auf der) {room} auf <percent> Prozent",
      intent: setOf("room"),
    },
    {
      template:
        "(stell|stelle|dimm|dimme|mach|mache) [(das|die)] (Licht|Lichter|Lampen) (im|in der|in den|in|auf dem|auf der) {floor} auf <percent> Prozent",
      intent: setOf("floor"),
    },
    {
      template:
        "(stell|stelle|dimm|dimme|mach|mache) alle (Lichter|Lampen) auf <percent> Prozent",
      intent: setOf("home"),
    },
    {
      template:
        "(stell|stelle|dimm|dimme|mach|mache) [(das|die)] (Licht|Lichter|Lampen) auf <percent> Prozent",
      intent: setOf("here"),
    },
    // Die Stimmung eines Raums, nach dem Licht.
    {
      template: "(stell|stelle|setz|setze) [(den|das|die)] {room} auf {mood}",
      intent: { do: "mood", where: "room" },
    },
    {
      template:
        "(starte|aktiviere|stell|stelle) {mood} (im|in der|in den|in|auf dem|auf der) {room}",
      intent: { do: "mood", where: "room" },
    },
    {
      template: "{mood} (im|in der|in den|in|auf dem|auf der) {room}",
      intent: { do: "mood", where: "room" },
    },
    {
      template: "(starte|aktiviere) [die Stimmung] {mood}",
      intent: { do: "mood", where: "here" },
    },
    {
      template: "(stell|stelle|setz|setze) die Stimmung auf {mood}",
      intent: { do: "mood", where: "here" },
    },
    // Zurück.
    { template: "(mach|mache) das rückgängig", intent: { do: "restore" } },
    {
      template: "(stell|stelle) [(es|das)] [wieder] zurück",
      intent: { do: "restore" },
    },
    { template: "rückgängig", intent: { do: "restore" } },
    // Timer, die es nicht stellen kann.
    {
      template:
        "(stell|stelle|setz|setze|starte) [einen] (Timer|Wecker) [(auf|für) (eine|einer|zwei|drei|fünf|zehn|fünfzehn|zwanzig|dreißig|sechzig) (Sekunde|Sekunden|Minute|Minuten|Stunde|Stunden)]",
      intent: { do: "timer" },
    },
  ],
  notUnderstood: "Ich kann nur mit Licht und Stimmungen helfen.",
};

export const languages: Record<RequestLanguage, Language> = { en, de };

const choicePattern = /<(switch|step|percent)>/g;

/** A template as speech recognition learns it: each choice as its words. */
export function spokenTemplate(template: string, choices: Choices) {
  return template.replace(
    choicePattern,
    (_, name: ChoiceName) => `(${Object.keys(choices[name]).join("|")})`,
  );
}

/** Every language's templates, as the Assistant's definition declares them. */
export const sentences: AssistantSentences = Object.fromEntries(
  Object.entries(languages).map(([language, { choices, sentences }]) => [
    language,
    sentences.map(({ template }) => spokenTemplate(template, choices)),
  ]),
);

export const notUnderstood: NotUnderstood = Object.fromEntries(
  Object.entries(languages).map(([language, words]) => [
    language,
    words.notUnderstood,
  ]),
);
