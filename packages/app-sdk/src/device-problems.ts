import { z } from "zod";

import { deviceKey } from "./devices.js";

// What can be wrong with a driver's device, in words the driver declares in
// its manifest, and what setting it right asks. A driver names one of its
// problems for a device (ctx.devices.problem), the core keeps it with the
// device, and Needs attention leads the device's row with its words. Where
// the problem says how, Repair asks the driver's declared questions and
// hands the answers to driver.repair, which sets the device right or
// refuses an answer by one of that question's declared refusals. The words
// are all declared, never made up as the driver goes, so an answer typed into
// a field can't end up in a message, a log or the activity log.

/** What a driver may ask someone repairing one of its devices, such as a device's encryption key. */
export type DriverQuestion = {
  /** What the field is called: "Encryption key". */
  readonly label: string;
  /**
   * A secret answer goes to the driver once and nowhere else: the core
   * neither keeps nor logs it, and the field empties once it's done.
   */
  readonly kind: "secret" | "text";
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
  /** An answer to each question the problem's repair asks, by its id. */
  answers: Record<string, string>;
};

/**
 * Nothing once the device is set right, or the question whose answer the
 * driver refused and the refusal it declares for it. The driver clears the
 * problem itself (ctx.devices.problem) once the device shows it's right.
 */
export type DriverRepairResult = void | {
  refused: { question: string; refusal: string };
};

/** A question as the core shows it with a device's problem. */
export type DeviceQuestion = {
  id: string;
  label: string;
  kind: "secret" | "text";
  help: string | null;
  placeholder: string | null;
  refusals: Record<string, string>;
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

const maxProblems = 32;
const maxQuestions = 8;
const maxRefusals = 8;

const words = (max: number) => z.string().max(max).trim().min(1);
const ids = <T extends z.ZodType>(value: T, max: number) =>
  z
    .record(z.string().regex(problemId), value)
    .refine((record) => Object.keys(record).length <= max, {
      message: `at most ${max}`,
    });

const questionShape = z.strictObject({
  label: words(60),
  kind: z.enum(["secret", "text"]),
  help: words(300).optional(),
  placeholder: words(60).optional(),
  refusals: ids(words(200), maxRefusals),
});

const problemShape = z.strictObject({
  words: words(maxProblemWords),
  repair: z
    .strictObject({
      help: words(300).optional(),
      asks: z.array(z.string().regex(problemId)).max(maxQuestions),
    })
    .optional(),
});

type DriverWithProblems = {
  readonly problems?: Readonly<Record<string, DriverProblem>>;
  readonly questions?: Readonly<Record<string, DriverQuestion>>;
  readonly repair?: unknown;
};

/**
 * Checks a driver's problems and questions: each declared once with its
 * words, a repair asking only questions it declares, and driver.repair
 * there exactly when some problem has a repair.
 */
export function assertDriverProblems(
  driver: DriverWithProblems,
  // A static manifest names the hook rather than carrying its function.
  hasRepair = driver.repair !== undefined,
) {
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
  let repairs = false;
  for (const [id, problem] of Object.entries(problems.data)) {
    if (!problem.repair) continue;
    repairs = true;
    const asks = problem.repair.asks;
    if (new Set(asks).size !== asks.length) {
      throw new Error(`The repair of ${id} asks a question twice`);
    }
    for (const question of asks) {
      if (!Object.hasOwn(questions.data, question)) {
        throw new Error(
          `The repair of ${id} asks ${question}, which the driver doesn't declare`,
        );
      }
    }
  }
  if (driver.repair !== undefined && typeof driver.repair !== "function") {
    throw new Error("A driver's repair must be a function");
  }
  if (repairs !== hasRepair) {
    throw new Error(
      "A driver has a repair function exactly when one of its problems has a repair",
    );
  }
}

/** A driver's problems and questions as its static manifest carries them, or nothing when it has none. */
export function staticProblems(driver: DriverWithProblems) {
  const problems = driver.problems ?? {};
  const questions = driver.questions ?? {};
  return {
    ...(Object.keys(problems).length > 0
      ? { problems: JSON.parse(JSON.stringify(problems)) as typeof problems }
      : {}),
    ...(Object.keys(questions).length > 0
      ? {
          questions: JSON.parse(JSON.stringify(questions)) as typeof questions,
        }
      : {}),
  };
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
  const questions = driver?.questions ?? {};
  return {
    id,
    words: problem.words,
    repair: problem.repair
      ? {
          help: problem.repair.help ?? null,
          asks: problem.repair.asks.flatMap((question) => {
            const asked = Object.hasOwn(questions, question)
              ? questions[question]
              : undefined;
            return asked
              ? [
                  {
                    id: question,
                    label: asked.label,
                    kind: asked.kind,
                    help: asked.help ?? null,
                    placeholder: asked.placeholder ?? null,
                    refusals: { ...asked.refusals },
                  },
                ]
              : [];
          }),
        }
      : null,
  };
}

/**
 * The answers to what a problem's repair asks: one for each question, and
 * nothing else. Answers are taken as typed, never trimmed, as a key's every
 * character counts.
 */
export function repairAnswers(problem: DeviceProblem, answers: unknown) {
  const asked = problem.repair?.asks.map((question) => question.id) ?? [];
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
  return parsed.data;
}

/** Whether a driver's refusal is one the question it names declares, among those the repair asks. */
export function isDeclaredRefusal(
  problem: DeviceProblem,
  refused: unknown,
): refused is { question: string; refusal: string } {
  const parsed = z
    .object({ question: z.string(), refusal: z.string() })
    .safeParse(refused);
  if (!parsed.success) return false;
  const question = problem.repair?.asks.find(
    (each) => each.id === parsed.data.question,
  );
  return (
    question !== undefined &&
    Object.hasOwn(question.refusals, parsed.data.refusal)
  );
}
