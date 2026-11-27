import { describe, expect, it } from "vitest";

import {
  aiAssistantPermission,
  assistantAppId,
  defineApp,
  grammarSteps,
  sentenceIssues,
  sentenceLimits,
  toStaticManifest,
} from "../src/index.js";

// The sentences Sanctum's Assistant brings for smart speakers: checked as it
// is defined, so a list too large to learn fails before it's installed.

const assistant = (sentences: unknown) =>
  defineApp({
    id: assistantAppId,
    name: "Assistant",
    version: "1.0.0",
    core: "^2.0.0",
    permissions: [{ id: aiAssistantPermission, reason: "To do what you ask." }],
    actions: [],
    events: [],
    requests: async () => {},
    sentences: sentences as never,
  });

describe("the Assistant's sentences", () => {
  it("come in its manifest, by language", () => {
    const sentences = {
      en: ["turn (on|off) the {room} lights", "put it back"],
      de: ["schalte das licht im {room} (ein|aus)"],
    };
    expect(toStaticManifest(assistant(sentences)).sentences).toEqual(sentences);
  });

  it("are the Assistant's alone", () => {
    expect(() =>
      defineApp({
        id: "sanctum.example",
        name: "Example",
        version: "1.0.0",
        core: "^2.0.0",
        permissions: [],
        actions: [],
        events: [],
        sentences: { en: ["turn on the lights"] },
      }),
    ).toThrow("Only Sanctum's Assistant brings sentences");
  });

  it("require a request handler", () => {
    expect(() =>
      defineApp({
        ...assistant({ en: ["turn on the lights"] }),
        requests: undefined,
      }),
    ).toThrow("needs a requests handler");
  });

  it("leave only the home's names blank", () => {
    expect(sentenceIssues({ en: ["set the {thermostat} to warm"] })).toEqual([
      expect.stringContaining(
        "leaves {thermostat} blank, which isn't one of room, floor, light, mood",
      ),
    ]);
    expect(() => assistant({ en: ["turn on the {zone}"] })).toThrow("{zone}");
  });

  it("need brackets that match", () => {
    for (const template of [
      "turn (on|off the lights",
      "turn on [the lights",
      "turn on the {room lights",
      "turn on the {(room)} lights",
    ]) {
      expect(sentenceIssues({ en: [template] }).length).toBeGreaterThan(0);
    }
    expect(
      sentenceIssues({ en: ["turn [(on|off)] [the] {room} lights"] }),
    ).toEqual([]);
  });

  it("requires round brackets for optional choices when defining the Assistant", () => {
    expect(() => assistant({ de: ["mach [das|die] Licht aus"] })).toThrow(
      "an optional part's choices need round brackets: [(a|b)]",
    );
    expect(() =>
      assistant({ de: ["mach [(das|die)] Licht aus"] }),
    ).not.toThrow();
  });

  it("keep to their limits per language", () => {
    expect(
      sentenceIssues({ en: Array(sentenceLimits.perLanguage + 1).fill("hi") }),
    ).toHaveLength(1);
    expect(
      sentenceIssues({ en: ["x".repeat(sentenceLimits.length + 1)] }),
    ).toHaveLength(1);
    expect(sentenceIssues({ fr: ["allume la lumière"] })).toHaveLength(1);
    expect(sentenceIssues({ en: [] })).toHaveLength(1);
  });

  it("must fit what speech recognition learns in a large home", () => {
    // Each names a light: 150 of them, 20 characters each, in a large home,
    // so lights take most of what can be learned.
    const fits = Array(12).fill("turn (on|off) [the] {light}");
    expect(sentenceIssues({ en: fits })).toEqual([]);
    const tooMany = Array(30).fill(
      "turn (on|off) [the] {light} and [the] {light} and [the] {light}",
    );
    expect(sentenceIssues({ en: tooMany })).toEqual([
      expect.stringContaining("en sentences take about"),
    ]);
  });

  it("count the steps to learn them by what they and the names spell", () => {
    expect(grammarSteps(["turn on the {room} lights"], {})).toBe(
      "turn on the  lights".length * 4,
    );
    expect(grammarSteps(["{room}"], { room: ["Office", "Kitchen"] })).toBe(
      (7 + 8) * 4,
    );
  });

  it("bounds the combinations of adjacent fragments within a word", () => {
    const joined = "light" + "[x]".repeat(18);
    expect(sentenceIssues({ en: [joined] })).toEqual([
      expect.stringContaining("en sentences take about"),
    ]);
    const nested = "light" + "[(x|y)]".repeat(12);
    expect(grammarSteps([nested], {})).toBeGreaterThan(
      sentenceLimits.grammarSteps,
    );
    const spaced = "light " + "[x] ".repeat(18);
    expect(grammarSteps([spaced], {})).toBeLessThan(
      sentenceLimits.grammarSteps,
    );
  });

  it("say what speech they don't know gets, in their languages", () => {
    const sentences = { en: ["turn on the lights"] };
    const notUnderstood = { en: "I can only help with lights and moods" };
    expect(
      toStaticManifest(defineApp({ ...assistant(sentences), notUnderstood }))
        .notUnderstood,
    ).toEqual(notUnderstood);
    expect(() =>
      defineApp({
        ...assistant(sentences),
        notUnderstood: { de: "Ich helfe nur mit Licht und Stimmungen" },
      }),
    ).toThrow("has no de sentences");
    expect(() =>
      defineApp({ ...assistant(sentences), notUnderstood: { en: " " } }),
    ).toThrow("not-understood replies don't fit");
    expect(() =>
      defineApp({
        ...assistant(sentences),
        notUnderstood: { en: `${" ".repeat(200)}Try again` },
      }),
    ).toThrow();
    expect(() => defineApp({ ...assistant(undefined), notUnderstood })).toThrow(
      "with its sentences",
    );
  });
});
