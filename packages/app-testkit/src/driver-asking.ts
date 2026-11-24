import { randomUUID } from "node:crypto";

import {
  answersTo,
  askedOf,
  attemptMs,
  isAsked,
  isDeclaredAddRefusal,
  isDeclaredRefusal,
  maxWrongAnswers,
  type AppContext,
  type AppDefinition,
  type AttemptEnd,
  type DeviceQuestion,
} from "@meetsanctum/app-sdk";

// The suite core's adding and repairing that ask once they have started, as
// the core takes them: an attempt the test answers step by step, with a clock
// of its own. Each answer is checked as the core checks it (one for each
// question asked, a code's digits), and so is each driver's answer: what it
// asks must be declared for what it does, and a refusal must be one the
// questions just answered declare. An attempt ends on cancel(), after its
// time, or after too many wrong answers, and the driver then closes what it
// opened.

type Driver = NonNullable<AppDefinition["driver"]>;

/** Where an attempt got to. */
export type AttemptState =
  | {
      kind: "asking";
      asks: DeviceQuestion[];
      refused?: { question: string; refusal: string };
    }
  | { kind: "done" }
  | { kind: "refused"; refusal: string; question?: string }
  | { kind: "ended"; why: AttemptEnd };

/** What one flow's attempt hands the driver, and checks of what it answers. */
export type AttemptFlow = {
  what: string;
  /** The questions asked at the start, and those it may ask once started. */
  first: readonly DeviceQuestion[];
  later: readonly DeviceQuestion[];
  call(step: {
    answers: Record<string, string>;
    attempt: string;
    again?: string;
  }): Promise<unknown>;
  cancel(attempt: string): Promise<void>;
  /** Whether a refusal that ends it is one it may give. */
  isRefusal(refused: unknown, answered: readonly DeviceQuestion[]): boolean;
  /** Checks what it did once it says it's done, as the device registered. */
  done(): void;
  refuse(error: Error): never;
};

/** An attempt a test answers step by step. */
export type Attempt = ReturnType<typeof createAttempt>;

export function createAttempt(flow: AttemptFlow) {
  const id = randomUUID();
  let clock = 0;
  const deadline = attemptMs;
  let asks: DeviceQuestion[] = [...flow.first];
  let lastsUntil: number | null = null;
  let wrong = 0;
  let state: AttemptState | null = null;

  async function end(why: AttemptEnd) {
    state = { kind: "ended", why };
    await flow.cancel(id);
    return state;
  }

  // Takes what the driver answered a step.
  function answered(result: unknown, answeredAsks: readonly DeviceQuestion[]) {
    if (isAsked(result)) {
      const asked = askedOf(result, flow.later, answeredAsks);
      if (!asked) {
        flow.refuse(
          new Error(`${flow.what} asked what it doesn't declare for it`),
        );
      }
      asks = asked.asks;
      const lasting = asks.find((question) => question.lasts);
      lastsUntil = lasting ? clock + lasting.lasts!.seconds * 1_000 : null;
      if (asked.refused) {
        wrong += 1;
        if (wrong >= maxWrongAnswers)
          return (state = { kind: "ended", why: "wrong" });
      }
      state = {
        kind: "asking",
        asks,
        ...(asked.refused ? { refused: asked.refused } : {}),
      };
      return state;
    }
    if (result === undefined) {
      flow.done();
      state = { kind: "done" };
      return state;
    }
    const refused = (result as { refused?: unknown } | null)?.refused;
    if (!flow.isRefusal(refused, answeredAsks)) {
      flow.refuse(
        new Error(`${flow.what} refused in words it doesn't declare`),
      );
    }
    const { question, refusal } = refused as {
      question?: string;
      refusal: string;
    };
    state = {
      kind: "refused",
      refusal,
      ...(question !== undefined ? { question } : {}),
    };
    return state;
  }

  async function takeStep(
    answers: Record<string, string>,
    answeredAsks: readonly DeviceQuestion[],
    again?: string,
  ) {
    let next: AttemptState;
    try {
      const result = await flow.call({
        answers,
        attempt: id,
        ...(again !== undefined ? { again } : {}),
      });
      next = answered(result, answeredAsks);
    } catch (error) {
      state = null;
      await flow.cancel(id).catch(() => {});
      throw error;
    }
    if (next.kind === "refused" || next.kind === "ended") await flow.cancel(id);
    return next;
  }

  function stillAsking() {
    if (state?.kind !== "asking") {
      throw new Error(`The attempt isn't asking: ${JSON.stringify(state)}`);
    }
  }

  return {
    /** The attempt's id, which the driver is handed with every step. */
    id,
    /** Where it got to, once started. */
    get state() {
      return state;
    },
    /** What it asks now. */
    get asks() {
      return asks;
    },

    /** Starts it with the answers to what is asked at the start. */
    async start(answers: Record<string, string> = {}) {
      const checked = answersTo(flow.first, answers);
      if (!checked) throw new Error(`The answers to ${flow.what} are invalid`);
      return takeStep(checked, flow.first);
    },

    /** Answers what it asks now, as Continue does. */
    async answer(answers: Record<string, string>) {
      stillAsking();
      if (clock >= deadline) return end("time");
      const checked = answersTo(asks, answers);
      if (!checked) throw new Error(`The answers to ${flow.what} are invalid`);
      if (lastsUntil !== null && clock > lastsUntil) {
        throw new Error("The time of the question that lasts is up");
      }
      return takeStep(checked, asks);
    },

    /** Asks a question that lasts again, as Show a new code does. */
    async again(question: string) {
      stillAsking();
      if (clock >= deadline) return end("time");
      if (!asks.some((each) => each.id === question && each.lasts)) {
        throw new Error(`${question} isn't asked now, or doesn't last`);
      }
      return takeStep({}, [], question);
    },

    /** Ends it, as Cancel or the card closing does. */
    cancel() {
      stillAsking();
      return end("cancelled");
    },

    /** Moves its clock on; its time running out ends it. */
    async elapse(ms: number) {
      clock += ms;
      if (state?.kind === "asking" && clock >= deadline) await end("time");
      return state;
    },
  };
}

/** The flow of adding a device the driver found. */
export function addingFlow(options: {
  app: string;
  key: string;
  first: readonly DeviceQuestion[];
  later: readonly DeviceQuestion[];
  refusals: Readonly<Record<string, string>>;
  context: () => AppContext;
  add: NonNullable<Driver["add"]>;
  cancelAdd: Driver["cancelAdd"];
  isRegistered: () => boolean;
  refuse: (error: Error) => never;
}): AttemptFlow {
  const { key } = options;
  return {
    what: `Adding ${key}`,
    first: options.first,
    later: options.later,
    call: (step) => options.add(options.context(), { key, ...step }),
    async cancel(attempt) {
      await options.cancelAdd?.(options.context(), { key, attempt });
    },
    isRefusal: (refused, answered) =>
      isDeclaredAddRefusal(answered, options.refusals, refused),
    done() {
      if (!options.isRegistered()) {
        options.refuse(
          new Error(`${options.app} added ${key} without registering it`),
        );
      }
    },
    refuse: options.refuse,
  };
}

/** The flow of repairing one of the driver's devices. */
export function repairingFlow(options: {
  key: string;
  problem: string;
  first: readonly DeviceQuestion[];
  later: readonly DeviceQuestion[];
  context: () => AppContext;
  repair: NonNullable<Driver["repair"]>;
  cancelRepair: Driver["cancelRepair"];
  refuse: (error: Error) => never;
}): AttemptFlow {
  const { key } = options;
  const device = `device:${key}`;
  return {
    what: `Repairing ${key}`,
    first: options.first,
    later: options.later,
    call: (step) =>
      options.repair(options.context(), {
        key,
        device,
        problem: options.problem,
        ...step,
      }),
    async cancel(attempt) {
      await options.cancelRepair?.(options.context(), {
        key,
        device,
        attempt,
      });
    },
    isRefusal: (refused, answered) => isDeclaredRefusal(answered, refused),
    done() {},
    refuse: options.refuse,
  };
}
