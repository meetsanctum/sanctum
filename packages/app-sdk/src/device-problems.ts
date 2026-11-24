import { z } from "zod";

import type { DriverAsked } from "./device-asking.js";
import { deviceKey } from "./devices.js";

// What can be wrong with a driver's device, in words the driver declares in
// its manifest, and what setting it right asks. A driver names one of its
// problems for a device (ctx.devices.problem), the core keeps it with the
// device, and Needs attention leads the device's row with its words. Where
// the problem says how, Repair asks the driver's declared questions and
// hands the answers to driver.repair, which sets the device right or
// refuses an answer by one of that question's declared refusals. Adding a
// device the driver found asks its questions the same way (found-devices.ts).
// The words are all declared, never made up as the driver goes, so an answer
// typed into a field can't end up in a message, a log or the activity log.
// Adding and repairing may also ask once they've started, of the questions
// declared for it (device-asking.ts).

/** What a driver may ask someone adding or repairing one of its devices, such as a device's encryption key. */
export type DriverQuestion = {
  /** What the field is called: "Encryption key". */
  readonly label: string;
  /**
   * A secret answer goes to the driver once and nowhere else: the core
   * neither keeps nor logs it, and the field empties once it's done. A code
   * is digits a device shows, such as a TV's, `length` of them, typed on a
   * number pad and shown as typed.
   */
  readonly kind: "secret" | "text" | "code";
  /** How many digits a code has, 1 to 12; only a code has it. */
  readonly length?: number;
  /**
   * How long the device keeps what it showed for this question, in seconds
   * from when the driver asks it, 10 to 120, and the words of the button
   * that has it show a new one once that time is up: "Show a new code".
   */
  readonly lasts?: { readonly seconds: number; readonly again: string };
  /** Where to find the answer, under the field. */
  readonly help?: string;
  readonly placeholder?: string;
  /**
   * Why the driver may refuse an answer, by its own code, in the words the
   * field then shows: "That key doesn't match…".
   */
  readonly refusals: Readonly<Record<string, string>>;
};

/** Something that can be wrong with one of a driver's devices. */
export type DriverProblem = {
  /** What's wrong, leading the device's row: "Its encryption key doesn't match". */
  readonly words: string;
  /**
   * How Repair sets it right: what its dialog says, and the questions it
   * asks, which may be none. Without it, the device has no Repair.
   */
  readonly repair?: {
    readonly help?: string;
    readonly asks: readonly string[];
    /**
     * What repairing may ask once it has started, by id, such as a code
     * the device shows only then (device-asking.ts).
     */
    readonly later?: readonly string[];
  };
};

/** What the core asks of a driver to set one of its devices right (driver.repair). */
export type DriverRepair = {
  /** The device, by the driver's own key. */
  key: string;
  /** The device's id in the core. */
  device: string;
  /** The problem it's repairing. */
  problem: string;
  /** An answer to each question the repair, or its last step, asks, by its id. */
  answers: Record<string, string>;
  /**
   * Which attempt this is, where the repair may ask once it has started: a
   * new one means starting afresh, dropping whatever an earlier one left.
   */
  attempt?: string;
  /** The question whose time is up, when someone asks for it again, with no answers. */
  again?: string;
};

/**
 * Nothing once the device is set right, the question whose answer the
 * driver refused and the refusal it declares for it, or what it asks next
 * (device-asking.ts). The driver clears the problem itself
 * (ctx.devices.problem) once the device shows it's right.
 */
export type DriverRepairResult =
  void | { refused: { question: string; refusal: string } } | DriverAsked;

/** A question as the core shows it with a device's problem or a found device. */
export type DeviceQuestion = {
  id: string;
  label: string;
  kind: "secret" | "text" | "code";
  /** A code's digits. */
  length: number | null;
  help: string | null;
  placeholder: string | null;
  refusals: Record<string, string>;
  /** How long the device keeps it, and the words that ask for it again. */
  lasts: { seconds: number; again: string } | null;
};

/** What's wrong with a device, as its driver declares it. */
export type DeviceProblem = {
  id: string;
  words: string;
  /** What Repair says and asks, or null where the device has no Repair. */
  repair: { help: string | null; asks: DeviceQuestion[] } | null;
};

/** What a driver says is wrong with one of its devices, by its key: one of its problems, or null once nothing is. */
export const deviceProblemReport = z.object({
  key: deviceKey,
  problem: z.string().min(1).max(64).nullable(),
});
export type DeviceProblemReport = z.infer<typeof deviceProblemReport>;

/** A problem's, question's or refusal's id: such as keyMismatch. */
export const problemId = /^[a-z][A-Za-z0-9]{0,63}$/;
/** The longest a problem's words are, as they lead a device's row. */
export const maxProblemWords = 100;
/** The longest an answer is, in bytes of UTF-8. */
export const maxAnswerBytes = 4_096;
/** The most questions a driver declares, and so the most one thing asks. */
export const maxQuestions = 8;

const maxProblems = 32;
const maxRefusals = 8;

const words = (max: number) => z.string().max(max).trim().min(1);
const ids = <T extends z.ZodType>(value: T, max: number) =>
  z
    .record(z.string().regex(problemId), value)
    .refine((record) => Object.keys(record).length <= max, {
      message: `at most ${max}`,
    });

/** The most digits a code has. */
export const maxCodeLength = 12;

const questionIds = z.array(z.string().regex(problemId)).max(maxQuestions);

const questionShape = z
  .strictObject({
    label: words(60),
    kind: z.enum(["secret", "text", "code"]),
    length: z.number().int().min(1).max(maxCodeLength).optional(),
    help: words(300).optional(),
    placeholder: words(60).optional(),
    refusals: ids(words(200), maxRefusals),
    lasts: z
      .strictObject({
        seconds: z.number().int().min(10).max(120),
        again: words(60),
      })
      .optional(),
  })
  .refine(
    (question) =>
      (question.kind === "code") === (question.length !== undefined),
    "a code, and only a code, says its length",
  );

const problemShape = z.strictObject({
  words: words(maxProblemWords),
  repair: z
    .strictObject({
      help: words(300).optional(),
      asks: questionIds,
      later: questionIds.optional(),
    })
    .optional(),
});

/** The hooks whose presence goes with what a driver declares. */
const declaredHooks = ["repair", "add", "cancelAdd", "cancelRepair"] as const;
type DeclaredHook = (typeof declaredHooks)[number];

type DriverWithProblems = {
  readonly problems?: Readonly<Record<string, DriverProblem>>;
  readonly questions?: Readonly<Record<string, DriverQuestion>>;
  readonly refusals?: Readonly<Record<string, string>>;
  readonly addLater?: readonly string[];
} & { readonly [hook in DeclaredHook]?: unknown };

/**
 * Checks a driver's problems and questions: each declared once with its
 * words, a repair or adding asking only questions it declares, driver.repair
 * there exactly when some problem has a repair, and each cancel hook there
 * exactly when what it ends may ask once it has started.
 */
export function assertDriverProblems(
  driver: DriverWithProblems,
  // A static manifest names its hooks rather than carrying their functions.
  hooks?: readonly string[],
) {
  const has = (hook: DeclaredHook) =>
    hooks ? hooks.includes(hook) : driver[hook] !== undefined;
  const problems = ids(problemShape, maxProblems).safeParse(
    driver.problems ?? {},
  );
  if (!problems.success) {
    throw new Error(`A driver's problems: ${z.prettifyError(problems.error)}`);
  }
  const questions = ids(questionShape, maxQuestions).safeParse(
    driver.questions ?? {},
  );
  if (!questions.success) {
    throw new Error(
      `A driver's questions: ${z.prettifyError(questions.error)}`,
    );
  }
  const refusals = ids(words(200), maxRefusals).safeParse(
    driver.refusals ?? {},
  );
  if (!refusals.success) {
    throw new Error(`A driver's refusals: ${z.prettifyError(refusals.error)}`);
  }
  const declared = (what: string, asks: readonly string[]) => {
    if (new Set(asks).size !== asks.length) {
      throw new Error(`${what} asks a question twice`);
    }
    for (const question of asks) {
      if (!Object.hasOwn(questions.data, question)) {
        throw new Error(
          `${what} asks ${question}, which the driver doesn't declare`,
        );
      }
    }
  };
  let repairs = false;
  let repairsAsk = false;
  for (const [id, problem] of Object.entries(problems.data)) {
    if (!problem.repair) continue;
    repairs = true;
    declared(`The repair of ${id}`, problem.repair.asks);
    declared(`The repair of ${id}, once started,`, problem.repair.later ?? []);
    repairsAsk ||= (problem.repair.later ?? []).length > 0;
  }
  const addLater = questionIds.safeParse(driver.addLater ?? []);
  if (!addLater.success) {
    throw new Error(
      `What adding asks once started: ${z.prettifyError(addLater.error)}`,
    );
  }
  declared("Adding, once started,", addLater.data);
  const addsAsk = addLater.data.length > 0;
  for (const hook of declaredHooks) {
    if (driver[hook] !== undefined && typeof driver[hook] !== "function") {
      throw new Error(`A driver's ${hook} must be a function`);
    }
  }
  if (repairs !== has("repair")) {
    throw new Error(
      "A driver has a repair function exactly when one of its problems has a repair",
    );
  }
  if (addsAsk && !has("add")) {
    throw new Error("A driver that asks once adding has started can add");
  }
  if (addsAsk !== has("cancelAdd")) {
    throw new Error(
      "A driver has a cancelAdd function exactly when adding may ask once started",
    );
  }
  if (repairsAsk !== has("cancelRepair")) {
    throw new Error(
      "A driver has a cancelRepair function exactly when a repair may ask once started",
    );
  }
}

/** A driver's problems and questions as its static manifest carries them, or nothing when it has none. */
export function staticProblems(driver: DriverWithProblems) {
  const problems = driver.problems ?? {};
  const questions = driver.questions ?? {};
  const refusals = driver.refusals ?? {};
  const addLater = driver.addLater ?? [];
  return {
    ...(Object.keys(problems).length > 0
      ? { problems: JSON.parse(JSON.stringify(problems)) as typeof problems }
      : {}),
    ...(Object.keys(questions).length > 0
      ? {
          questions: JSON.parse(JSON.stringify(questions)) as typeof questions,
        }
      : {}),
    ...(Object.keys(refusals).length > 0 ? { refusals: { ...refusals } } : {}),
    ...(addLater.length > 0 ? { addLater: [...addLater] } : {}),
  };
}

/**
 * Why a driver may refuse adding a device whatever it's asked, as the core
 * shows it with a found device, from what its static manifest says.
 */
export function shownRefusals(
  driver: DriverWithProblems | null | undefined,
): Record<string, string> {
  return { ...(driver?.refusals ?? {}) };
}

/**
 * The questions a driver declares by these ids, as the core shows them, in
 * that order, from what its static manifest says. One it declares no more,
 * as after a version that dropped it, is left out.
 */
export function shownQuestions(
  driver: DriverWithProblems | null | undefined,
  ids: readonly string[],
): DeviceQuestion[] {
  const questions = driver?.questions ?? {};
  return ids.flatMap((question) => {
    const asked = Object.hasOwn(questions, question)
      ? questions[question]
      : undefined;
    return asked
      ? [
          {
            id: question,
            label: asked.label,
            kind: asked.kind,
            length: asked.length ?? null,
            help: asked.help ?? null,
            placeholder: asked.placeholder ?? null,
            refusals: { ...asked.refusals },
            lasts: asked.lasts
              ? { seconds: asked.lasts.seconds, again: asked.lasts.again }
              : null,
          },
        ]
      : [];
  });
}

/**
 * One of a driver's declared problems as the core shows it with a device,
 * from what its static manifest says, or null when it declares none by that
 * id, as after a version that dropped it.
 */
export function shownProblem(
  driver: DriverWithProblems | null | undefined,
  id: string,
): DeviceProblem | null {
  const problem = Object.hasOwn(driver?.problems ?? {}, id)
    ? driver!.problems![id]
    : undefined;
  if (!problem) return null;
  return {
    id,
    words: problem.words,
    repair: problem.repair
      ? {
          help: problem.repair.help ?? null,
          asks: shownQuestions(driver, problem.repair.asks),
        }
      : null,
  };
}

/**
 * The answers to what is asked: one for each question, and nothing else.
 * Answers are taken as typed, never trimmed, as a key's every character
 * counts. A code is its declared number of ASCII digits, kept as a string so
 * a leading zero stays.
 */
export function answersTo(asks: readonly DeviceQuestion[], answers: unknown) {
  const asked = asks.map((question) => question.id);
  const parsed = z
    .record(
      z.string(),
      z
        .string()
        .min(1)
        .refine((answer) => Buffer.byteLength(answer) <= maxAnswerBytes),
    )
    .safeParse(answers);
  if (!parsed.success) return null;
  const given = Object.keys(parsed.data);
  if (
    given.length !== asked.length ||
    asked.some((question) => !Object.hasOwn(parsed.data, question))
  ) {
    return null;
  }
  const isCode = (question: DeviceQuestion) =>
    question.kind !== "code" ||
    (/^[0-9]+$/.test(parsed.data[question.id]!) &&
      parsed.data[question.id]!.length === question.length);
  return asks.every(isCode) ? parsed.data : null;
}

/**
 * A driver's refusal to add a device: an answer to one of the questions
 * adding it asks, or adding it at all, in words the driver declares.
 */
export type AddRefusal =
  { question: string; refusal: string } | { refusal: string };

/** Whether a driver refused adding a device in words it declares. */
export function isDeclaredAddRefusal(
  asks: readonly DeviceQuestion[],
  refusals: Readonly<Record<string, string>>,
  refused: unknown,
): refused is AddRefusal {
  const parsed = z
    .strictObject({ question: z.string().optional(), refusal: z.string() })
    .safeParse(refused);
  if (!parsed.success) return false;
  const { question, refusal } = parsed.data;
  return question === undefined
    ? Object.hasOwn(refusals, refusal)
    : isDeclaredRefusal(asks, { question, refusal });
}

/** Whether a driver's refusal is one the question it names declares, among those asked. */
export function isDeclaredRefusal(
  asks: readonly DeviceQuestion[],
  refused: unknown,
): refused is { question: string; refusal: string } {
  const parsed = z
    .object({ question: z.string(), refusal: z.string() })
    .safeParse(refused);
  if (!parsed.success) return false;
  const question = asks.find((each) => each.id === parsed.data.question);
  return (
    question !== undefined &&
    Object.hasOwn(question.refusals, parsed.data.refusal)
  );
}
