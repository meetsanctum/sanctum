import { describe, expect, it } from "vitest";

import {
  assertDriverProblems,
  defineApp,
  answersTo,
  isDeclaredAddRefusal,
  isDeclaredRefusal,
  shownProblem,
  shownRefusals,
  shownQuestions,
  toStaticManifest,
  type AppDefinition,
} from "../src/index.js";

// A driver's declared problems and questions: checked as the app is
// defined, carried by its static manifest, and shown with a device.

const questions = {
  key: {
    label: "Encryption key",
    kind: "secret",
    placeholder: "44 characters, ending in =",
    refusals: { wrongKey: "That key doesn't match." },
  },
} as const;
const problems = {
  keyMismatch: {
    words: "Its encryption key doesn't match",
    repair: { help: "Enter the key from its configuration.", asks: ["key"] },
  },
  loose: { words: "Its plug is loose" },
};
const repair = async () => undefined;

function example(driver: Partial<NonNullable<AppDefinition["driver"]>>) {
  return defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [{ id: "devices.register", reason: "For the test." }],
    actions: [],
    events: [],
    driver: { command: async () => undefined, ...driver },
  });
}

describe("a driver's problems", () => {
  it("are carried by its static manifest with the repair hook", () => {
    const manifest = toStaticManifest(example({ problems, questions, repair }));

    expect(manifest.driver).toEqual({
      hooks: ["command", "repair"],
      problems,
      questions,
    });
    expect(toStaticManifest(example({})).driver).toEqual({
      hooks: ["command"],
    });
  });

  it.each([
    [
      "words over 100 characters",
      { problems: { long: { words: "x".repeat(101) } } },
    ],
    [
      "words padded past 100 characters",
      { problems: { long: { words: " ".repeat(100) + "x" } } },
    ],
    [
      "an id that isn't camelCase",
      { problems: { "key-mismatch": { words: "No" } } },
    ],
    [
      "a repair asking what it doesn't declare",
      {
        problems: { broken: { words: "Broken", repair: { asks: ["code"] } } },
        repair,
      },
    ],
    [
      "a repair asking an inherited property instead of a declared question",
      {
        problems: {
          broken: { words: "Broken", repair: { asks: ["toString"] } },
        },
        repair,
      },
    ],
    ["a repair without the hook", { problems, questions }],
    [
      "the hook without a repair",
      { problems: { loose: problems.loose }, repair },
    ],
    [
      "a question of another kind",
      {
        problems,
        questions: { key: { ...questions.key, kind: "number" } },
        repair,
      },
    ],
  ])("refuses %s", (_what, driver) => {
    expect(() => assertDriverProblems(driver as never)).toThrow();
    expect(() => example(driver as never)).toThrow();
  });

  it("are shown with what Repair asks, and none for one no longer declared", () => {
    const driver = { problems, questions };

    expect(shownProblem(driver, "keyMismatch")).toEqual({
      id: "keyMismatch",
      words: "Its encryption key doesn't match",
      repair: {
        help: "Enter the key from its configuration.",
        asks: [
          {
            id: "key",
            label: "Encryption key",
            kind: "secret",
            help: null,
            placeholder: "44 characters, ending in =",
            refusals: { wrongKey: "That key doesn't match." },
          },
        ],
      },
    });
    expect(shownProblem(driver, "loose")?.repair).toBeNull();
    expect(shownProblem(driver, "gone")).toBeNull();
    expect(shownProblem(driver, "toString")).toBeNull();
  });
});

describe("a driver's refusals of adding", () => {
  it("are checked as the app is defined and carried by its static manifest", () => {
    const refusals = { notWaiting: "It stopped waiting for a key." };

    expect(toStaticManifest(example({ refusals })).driver).toMatchObject({
      refusals,
    });
    expect(toStaticManifest(example({})).driver).not.toHaveProperty("refusals");
    expect(() => example({ refusals: { notWaiting: "" } })).toThrow(
      "A driver's refusals",
    );
    expect(() => example({ refusals: { "not-waiting": "Words." } })).toThrow(
      "A driver's refusals",
    );
  });
});

describe("answers to what's asked", () => {
  const asks = shownProblem({ problems, questions }, "keyMismatch")!.repair!
    .asks;

  it("are one for each question asked, as typed", () => {
    expect(answersTo(asks, { key: " a key= " })).toEqual({
      key: " a key= ",
    });
    expect(answersTo(asks, {})).toBeNull();
    expect(answersTo(asks, { key: "" })).toBeNull();
    expect(answersTo(asks, { key: "k", other: "x" })).toBeNull();
    expect(answersTo(asks, { key: "x".repeat(4_097) })).toBeNull();
    expect(answersTo([], {})).toEqual({});
  });

  it("are refused only as the question declares", () => {
    expect(
      isDeclaredRefusal(asks, { question: "key", refusal: "wrongKey" }),
    ).toBe(true);
    expect(
      isDeclaredRefusal(asks, { question: "key", refusal: "tooShort" }),
    ).toBe(false);
    expect(
      isDeclaredRefusal(asks, { question: "name", refusal: "wrongKey" }),
    ).toBe(false);
    expect(
      isDeclaredRefusal([], { question: "key", refusal: "wrongKey" }),
    ).toBe(false);
  });

  it("are refused, in adding, as a question or the driver declares", () => {
    const refusals = shownRefusals({
      refusals: { notWaiting: "It stopped waiting for a key." },
    });

    expect(refusals).toEqual({ notWaiting: "It stopped waiting for a key." });
    expect(
      isDeclaredAddRefusal(asks, refusals, {
        question: "key",
        refusal: "wrongKey",
      }),
    ).toBe(true);
    expect(isDeclaredAddRefusal([], refusals, { refusal: "notWaiting" })).toBe(
      true,
    );
    // A question's refusal is no refusal of adding at all, nor the other way.
    expect(isDeclaredAddRefusal(asks, refusals, { refusal: "wrongKey" })).toBe(
      false,
    );
    expect(
      isDeclaredAddRefusal(asks, refusals, {
        question: "key",
        refusal: "notWaiting",
      }),
    ).toBe(false);
    expect(
      isDeclaredAddRefusal([], refusals, { refusal: "notWaiting", extra: 1 }),
    ).toBe(false);
  });

  it("are asked in the driver's words, leaving out what it no longer declares", () => {
    expect(shownQuestions({ questions }, ["gone", "key"])).toEqual(asks);
    expect(shownQuestions({ questions }, ["toString"])).toEqual([]);
    expect(shownQuestions(null, ["key"])).toEqual([]);
  });
});
