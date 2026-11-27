import {
  grammarSteps,
  sentenceIssues,
  sentenceLimits,
  type RequestLanguage,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { app } from "../src/index.js";
import { match, type HomeNames } from "../src/matching.js";
import { languages, spokenTemplate } from "../src/sentences.js";

// What the Assistant makes of words: speech recognition's, which are one of
// its templates with the home's names in, and typed ones.

const names: HomeNames = {
  room: ["Office", "Kitchen", "Lena's Room", "Den"],
  floor: ["Ground Floor", "Upstairs"],
  light: ["Office Light", "Desk Lamp"],
  mood: [],
};

const german: HomeNames = {
  room: ["Büro", "Küche", "Wohnzimmer"],
  floor: ["Erdgeschoss"],
  light: ["Stehlampe"],
  mood: [],
};

const en = (text: string) => match(text, languages.en, names);
const de = (text: string) => match(text, languages.de, german);

// One way to say a template: the first of each choice, nothing optional,
// and the first name for each blank.
function sayFirst(template: string, home: HomeNames) {
  let text = template;
  for (;;) {
    const next = text
      .replace(/\[[^[\]]*\]/g, "")
      .replace(/\(([^()|]*)(?:\|[^()]*)?\)/g, "$1");
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/\{(\w+)\}/g, (_, blank: keyof HomeNames) => home[blank][0]!)
    .replace(/\s+/g, " ")
    .trim();
}

describe("the Assistant's sentences", () => {
  it("fit what speech recognition can learn in a large home", () => {
    expect(sentenceIssues(app.sentences)).toEqual([]);
    for (const templates of Object.values(app.sentences!)) {
      expect(templates.length).toBeLessThanOrEqual(sentenceLimits.perLanguage);
    }
  });

  it("are learned in a home like the office's in a few thousand steps", () => {
    for (const home of [names, german]) {
      for (const templates of Object.values(app.sentences!)) {
        expect(grammarSteps(templates, home)).toBeLessThan(
          sentenceLimits.grammarSteps / 10,
        );
      }
    }
  });

  it.each(["en", "de"] as const)(
    "in %s each mean what they say, said the plainest way",
    (language: RequestLanguage) => {
      const words = languages[language];
      // Names that don't run into each other, as Office and Office Light do.
      const home =
        language === "en" ? { ...names, light: ["Desk Lamp"] } : german;
      for (const { template, intent } of words.sentences) {
        const said = sayFirst(spokenTemplate(template, words.choices), home);
        expect(match(said, words, home)?.intent, said).toEqual(intent);
      }
    },
  );
});

describe("matching English", () => {
  it("reads the speaker's room, a room, a floor, the home and a light", () => {
    expect(en("turn off the lights")).toEqual({
      intent: { do: "switch", where: "here" },
      names: {},
      choices: { switch: "off" },
    });
    expect(en("Turn on the lights in the Kitchen.")).toMatchObject({
      intent: { where: "room" },
      names: { room: "Kitchen" },
      choices: { switch: "on" },
    });
    expect(en("turn the kitchen lights off")).toMatchObject({
      names: { room: "Kitchen" },
      choices: { switch: "off" },
    });
    expect(en("Lena’s Room lights on")).toMatchObject({
      names: { room: "Lena's Room" },
    });
    expect(en("switch on the lights on the ground floor")).toMatchObject({
      intent: { where: "floor" },
      names: { floor: "Ground Floor" },
    });
    expect(en("turn off all the lights")).toMatchObject({
      intent: { where: "home" },
    });
    expect(en("turn off the lights everywhere")).toMatchObject({
      intent: { where: "home" },
    });
  });

  it("takes a light's name over a room it starts with", () => {
    expect(en("turn off the office light")).toMatchObject({
      intent: { where: "light" },
      names: { light: "Office Light" },
    });
    expect(en("turn off the office lights")).toMatchObject({
      intent: { where: "room" },
      names: { room: "Office" },
    });
  });

  it("steps lights and sets them to a brightness, typed or said", () => {
    expect(en("make the lights in the kitchen dimmer")).toMatchObject({
      intent: { do: "step", where: "room" },
      choices: { step: "dimmer" },
    });
    expect(en("turn the lights up")).toMatchObject({
      intent: { do: "step", where: "here" },
      choices: { step: "brighter" },
    });
    expect(en("dim the lights")?.intent).toEqual({
      do: "step",
      where: "here",
      to: "dimmer",
    });
    expect(en("set the kitchen lights to forty percent")).toMatchObject({
      intent: { do: "set", where: "room" },
      choices: { percent: 40 },
    });
    expect(en("Set the kitchen lights to 40%")).toMatchObject({
      choices: { percent: 40 },
    });
    expect(en("dim the desk lamp to 75 percent")).toMatchObject({
      intent: { where: "light" },
      choices: { percent: 75 },
    });
    expect(en("set the kitchen lights to 45%")).toBeNull();
  });

  it("keeps numbers and percent signs in light names", () => {
    const home = {
      ...names,
      light: ["Lamp 50%", "Lamp fifty percent", "Lamp 40 Percent"],
    };
    expect(match("Turn on Lamp 50%", languages.en, home)).toMatchObject({
      names: { light: "Lamp 50%" },
    });
    expect(
      match("Set Lamp 40 Percent to 75%", languages.en, home),
    ).toMatchObject({
      names: { light: "Lamp 40 Percent" },
      choices: { percent: 75 },
    });
  });

  it("puts back and knows timers", () => {
    expect(en("put it back")?.intent).toEqual({ do: "restore" });
    expect(en("Undo that!")?.intent).toEqual({ do: "restore" });
    expect(en("set a timer for ten minutes")?.intent).toEqual({ do: "timer" });
    expect(en("set a five minute timer")?.intent).toEqual({ do: "timer" });
  });

  it("matches whole words and whole sentences only", () => {
    expect(en("what's the weather")).toBeNull();
    expect(en("turnoff the lights")).toBeNull();
    expect(en("turn on the lights in the garden")).toBeNull();
    expect(en("turn on the lights in the dentist")).toBeNull();
    expect(en("please turn on the lights and play music")).toBeNull();
  });
});

describe("matching German", () => {
  it("reads rooms with any article, floors and the home", () => {
    expect(de("Mach das Licht aus")).toEqual({
      intent: { do: "switch", where: "here" },
      names: {},
      choices: { switch: "off" },
    });
    expect(de("Schalte das Licht in der Küche ein")).toMatchObject({
      names: { room: "Küche" },
      choices: { switch: "on" },
    });
    expect(de("schalte im wohnzimmer das licht an")).toMatchObject({
      names: { room: "Wohnzimmer" },
      choices: { switch: "on" },
    });
    expect(de("mach das Licht im Erdgeschoss aus")).toMatchObject({
      intent: { where: "floor" },
      names: { floor: "Erdgeschoss" },
    });
    expect(de("schalte alle Lichter aus")).toMatchObject({
      intent: { where: "home" },
    });
    expect(de("mach die Stehlampe an")).toMatchObject({
      intent: { where: "light" },
      names: { light: "Stehlampe" },
    });
  });

  it("steps, sets, puts back and knows timers", () => {
    expect(de("mach das licht im büro heller")).toMatchObject({
      intent: { do: "step", where: "room" },
      choices: { step: "brighter" },
    });
    expect(de("dimme das Licht")?.intent).toEqual({
      do: "step",
      where: "here",
      to: "dimmer",
    });
    expect(
      de("stell das Licht im Wohnzimmer auf fünfzig Prozent"),
    ).toMatchObject({ intent: { do: "set" }, choices: { percent: 50 } });
    expect(de("stell das Licht auf 40 %")).toMatchObject({
      choices: { percent: 40 },
    });
    expect(de("mach das rückgängig")?.intent).toEqual({ do: "restore" });
    expect(de("stell einen Timer auf zehn Minuten")?.intent).toEqual({
      do: "timer",
    });
  });
});
