import { describe, expect, it } from "vitest";

import {
  answersTo,
  askedOf,
  defineApp,
  shownQuestions,
  toStaticManifest,
  type AppDefinition,
} from "../src/index.js";

// Adding and repairing that ask once started: what a driver declares for
// it, checked as the app is defined and carried by its static manifest, and
// what it may answer that asks.

const code = {
  label: "Code on the TV (1 of 2)",
  kind: "code",
  length: 4,
  refusals: { wrongCode: "That code didn't match." },
} as const;
const questions = {
  first: code,
  second: {
    ...code,
    label: "Code on the TV (2 of 2)",
    lasts: { seconds: 35, again: "Show a new code" },
  },
};
const problems = {
  pairingLost: {
    words: "Its pairing was removed",
    repair: { asks: [], later: ["first", "second"] },
  },
};
const hook = async () => undefined;

function example(driver: Partial<NonNullable<AppDefinition["driver"]>>) {
  return defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [{ id: "devices.register", reason: "For the test." }],
    actions: [],
    events: [],
    driver: { command: hook, ...driver },
  });
}

const asking = {
  questions,
  addLater: ["first", "second"],
  add: hook,
  cancelAdd: hook,
  problems,
  repair: hook,
  cancelRepair: hook,
};

describe("what a driver asks once started", () => {
  it("is carried by its static manifest with the cancel hooks", () => {
    const manifest = toStaticManifest(example(asking));

    expect(manifest.driver).toEqual({
      hooks: ["command", "repair", "add", "cancelAdd", "cancelRepair"],
      problems,
      questions,
      addLater: ["first", "second"],
    });
  });

  it.each([
    [
      "a code without its length",
      { questions: { first: { ...code, length: undefined } } },
    ],
    ["a length on text", { questions: { first: { ...code, kind: "text" } } }],
    ["a code of 13 digits", { questions: { first: { ...code, length: 13 } } }],
    [
      "a code lasting 5 seconds",
      {
        questions: {
          first: { ...code, lasts: { seconds: 5, again: "Again" } },
        },
      },
    ],
    ["adding asking what it doesn't declare", { addLater: ["first", "third"] }],
    ["adding asking a question twice", { addLater: ["first", "first"] }],
    ["adding that asks without cancelAdd", { cancelAdd: undefined }],
    ["cancelAdd where adding asks nothing", { addLater: [] }],
    ["adding that asks without add", { add: undefined }],
    ["a repair that asks without cancelRepair", { cancelRepair: undefined }],
    [
      "cancelRepair where no repair asks",
      { problems: { pairingLost: { words: "Lost", repair: { asks: [] } } } },
    ],
  ])("refuses %s", (_what, change) => {
    expect(() => example({ ...asking, ...change } as never)).toThrow();
  });

  it("is shown with a code's length and how long it lasts", () => {
    expect(shownQuestions({ questions }, ["second"])).toEqual([
      {
        id: "second",
        label: "Code on the TV (2 of 2)",
        kind: "code",
        length: 4,
        help: null,
        placeholder: null,
        refusals: { wrongCode: "That code didn't match." },
        lasts: { seconds: 35, again: "Show a new code" },
      },
    ]);
  });
});

describe("a code's answer", () => {
  const [first] = shownQuestions({ questions }, ["first"]);

  it("is its declared number of ASCII digits, kept as typed", () => {
    expect(answersTo([first!], { first: "0042" })).toEqual({ first: "0042" });
    for (const typed of ["042", "00042", "00x2", "٠٠٤٢", " 042", "4.20"]) {
      expect(answersTo([first!], { first: typed })).toBeNull();
    }
  });
});

describe("what a driver answers that asks", () => {
  const later = shownQuestions({ questions }, ["first", "second"]);
  const [first] = later;

  it("names questions declared for what it does, each once", () => {
    expect(askedOf({ asks: ["second"] }, later, [])).toMatchObject({
      asks: [{ id: "second" }],
    });
    expect(askedOf({ asks: ["third"] }, later, [])).toBeNull();
    expect(askedOf({ asks: ["first", "first"] }, later, [])).toBeNull();
    expect(askedOf({ asks: [] }, later, [])).toBeNull();
    expect(askedOf({ asks: ["first"], words: "x" }, later, [])).toBeNull();
    expect(askedOf({ asks: ["toString"] }, later, [])).toBeNull();
  });

  it("asks at most one question that lasts", () => {
    const lasting = shownQuestions(
      { questions: { ...questions, first: questions.second } },
      ["first", "second"],
    );

    expect(askedOf({ asks: ["first", "second"] }, lasting, [])).toBeNull();
    expect(askedOf({ asks: ["first", "second"] }, later, [])).not.toBeNull();
  });

  it("refuses an answer only as a question just answered declares", () => {
    const refused = { question: "first", refusal: "wrongCode" };

    expect(askedOf({ asks: ["first"], refused }, later, [first!])).toEqual({
      asks: [first],
      refused,
    });
    expect(askedOf({ asks: ["first"], refused }, later, [])).toBeNull();
    expect(
      askedOf(
        { asks: ["first"], refused: { ...refused, refusal: "tooShort" } },
        later,
        [first!],
      ),
    ).toBeNull();
  });
});
