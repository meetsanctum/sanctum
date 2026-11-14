import { describe, expect, it } from "vitest";

import {
  assertDriverProblems,
  defineApp,
  isDeclaredRefusal,
  repairAnswers,
  shownProblem,
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
    core: "^1.0.0",
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

describe("Repair's answers", () => {
  const shown = shownProblem({ problems, questions }, "keyMismatch")!;

  it("are one for each question asked, as typed", () => {
    expect(repairAnswers(shown, { key: " a key= " })).toEqual({
      key: " a key= ",
    });
    expect(repairAnswers(shown, {})).toBeNull();
    expect(repairAnswers(shown, { key: "" })).toBeNull();
    expect(repairAnswers(shown, { key: "k", other: "x" })).toBeNull();
    expect(repairAnswers(shown, { key: "x".repeat(4_097) })).toBeNull();
  });

  it("are refused only as the question declares", () => {
    expect(
      isDeclaredRefusal(shown, { question: "key", refusal: "wrongKey" }),
    ).toBe(true);
    expect(
      isDeclaredRefusal(shown, { question: "key", refusal: "tooShort" }),
    ).toBe(false);
    expect(
      isDeclaredRefusal(shown, { question: "name", refusal: "wrongKey" }),
    ).toBe(false);
  });
});
