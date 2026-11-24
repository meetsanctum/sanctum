import {
  askedOf,
  attemptMs,
  isAsked,
  maxWrongAnswers,
  type Actor,
  type AttemptEnd,
  type AttemptEnded,
  type DeviceAsking,
  type DeviceQuestion,
} from "@meetsanctum/app-sdk";

import type { ActivityAuthor } from "../activity/activity.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Hold, Turns } from "./turns.js";

// Adding and repairing that ask once they have started, as a TV shows a code
// only once pairing begins (app-sdk's device-asking.ts). The driver's answer
// that asks opens an attempt, which the client named as it started; the core
// keeps it, at most one for each device, while the person reads the code off
// the device. Each step takes the device's turn as any add, repair or remove
// does, so a cancel waits for an answer still with the driver, and nothing
// waits on the person.
//
// An attempt belongs to the client that started it and to the run of the
// driver that asked: another client's request naming it finds nothing, and
// a driver that stopped or restarted has dropped what it opened. A step
// counter tells a stale or doubled answer from the one the questions on the
// screen wait for. The attempt ends on Cancel, after its 3 minutes, on a
// newer start of the same device, on too many wrong answers, as the device
// is removed or, for a repair, as its problem clears outside it; the core
// then has the driver close what it opened, unless its run is gone. Answers
// reach no log and no activity entry, and the attempt's id reaches neither.

/** The longest one step's call to the driver may take, as adding's. */
export const stepWithinMs = 60_000;

// An answer to a question that lasts, a moment after its time, travelled.
const lastsGraceMs = 2_000;

// The attempts a client, and the whole home, may hold open at once.
const perClient = 4;
const inAll = 32;

// An ended or cancelled attempt is remembered as long as one lasts, so its
// card's next request learns how it ended.
const rememberedMax = 256;

/** What adding or repairing does for the attempts it opens. */
export type AskingFlow<Done> = {
  driver: string;
  key: string;
  /** The run of the driver it began with. */
  run: number;
  /** The questions it may ask once started. */
  later: readonly DeviceQuestion[];
  /** The driver's run now, or nothing while none takes calls. */
  runNow(): number | undefined;
  /** Hands the driver an answer, or a question to ask again: what it answers. */
  call(
    step: { answers: Record<string, string>; attempt?: string; again?: string },
    actor: Actor,
    hold: Hold,
    // A step of an attempt that asks has what's left of its time, up to a
    // minute; a call that can't ask keeps the driver's usual time.
    withinMs: number | undefined,
  ): Promise<unknown>;
  /**
   * What an answer that ends it comes to, which it records: the device
   * added or set right, or a refusal. It throws for what it can't take.
   */
  finish(result: unknown, answered: readonly DeviceQuestion[]): Done;
  /** What the driver's failure comes to, which it records. */
  failed(error: unknown): ActionCallError;
  /** How what it acts on ended outside it, or null while it stands. */
  standing(): AttemptEnd | null;
  /** Has the driver close what it opened for the attempt. */
  cancel(attempt: string, actor: Actor, hold: Hold): Promise<void>;
  /** Records an attempt that ended after a refused answer, by that refusal. */
  refused(refusal: string): void;
};

type Open = {
  id: string;
  client: string;
  turn: string;
  flow: AskingFlow<unknown>;
  step: number;
  asks: DeviceQuestion[];
  deadline: number;
  lastsUntil: number | null;
  wrong: number;
  // The refusal of the last answer refused, if one was.
  refusal: string | null;
  timer: NodeJS.Timeout | undefined;
};

type Device = { driver: string; key: string };

const turnOf = (device: Device) => `${device.driver}\u0000${device.key}`;

/** Who adds or repairs a device: an attempt is the client's that started it. */
export type Asker = ActivityAuthor & { clientId: string };

/** What a request for a step of an attempt says. */
export type AskingStep = {
  attempt: string;
  step: number;
  answers?: unknown;
  again?: string;
};

export function createAsking(options: {
  turns: Turns;
  // Checks the answers to what was asked: null where they don't fit.
  answersTo: (
    asks: readonly DeviceQuestion[],
    answers: unknown,
  ) => Record<string, string> | null;
  now?: () => Date;
}) {
  const { turns } = options;
  const now = () => (options.now?.() ?? new Date()).getTime();
  const open = new Map<string, Open>();
  const ended = new Map<
    string,
    { client: string; end: AttemptEnd; at: number }
  >();
  const earlyCancels = new Map<string, { client: string; at: number }>();
  let closed = false;

  // What is remembered lasts an attempt's time, and is bounded.
  function prune() {
    const before = now() - attemptMs;
    for (const memory of [ended, earlyCancels]) {
      for (const [id, { at }] of memory) {
        if (at < before || memory.size > rememberedMax) memory.delete(id);
      }
    }
  }

  function asking(attempt: Open): DeviceAsking {
    const at = now();
    return {
      attempt: attempt.id,
      step: attempt.step,
      asks: attempt.asks,
      withinMs: Math.max(0, attempt.deadline - at),
      lastsMs:
        attempt.lastsUntil === null
          ? null
          : Math.max(0, attempt.lastsUntil - at),
    };
  }

  // Ends an attempt within its device's turn. The driver closes what it
  // opened, unless its run is gone, which closed it. A failure to close is
  // the driver's, which the host logs without its words.
  async function end(
    attempt: Open,
    why: AttemptEnd,
    actor: Actor,
    hold: Hold,
  ): Promise<AttemptEnded> {
    if (open.get(attempt.turn) === attempt) open.delete(attempt.turn);
    clearTimeout(attempt.timer);
    prune();
    ended.set(attempt.id, { client: attempt.client, end: why, at: now() });
    if (attempt.refusal !== null) attempt.flow.refused(attempt.refusal);
    if (why !== "stopped" && attempt.flow.runNow() === attempt.flow.run) {
      await attempt.flow.cancel(attempt.id, actor, hold).catch(() => {});
    }
    return { ended: why };
  }

  // The time an attempt has runs out as a step of its own.
  function expire(attempt: Open) {
    const device = { driver: attempt.flow.driver, key: attempt.flow.key };
    void turns
      .take(device, async (hold) => {
        if (open.get(attempt.turn) !== attempt) return;
        const app: Actor = { kind: "app", id: attempt.flow.driver };
        await end(attempt, "time", app, hold);
      })
      .catch(() => {});
  }

  // Takes what the driver answered a step: what it asks next keeps the
  // attempt open, and anything else ends it.
  async function answered<Done>(
    flow: AskingFlow<Done>,
    step: {
      client: string;
      attempt: string | undefined;
      // What the step answered, or asked again.
      asks: readonly DeviceQuestion[];
      deadline: number;
      previous: Open | null;
    },
    call: (withinMs: number | undefined) => Promise<unknown>,
    actor: Actor,
    hold: Hold,
  ): Promise<Done | DeviceAsking | AttemptEnded> {
    const { attempt, previous } = step;
    const mayAsk = attempt !== undefined && flow.later.length > 0;
    // Whatever ends it here, a driver that may have opened something for
    // it closes it.
    const close = async () => {
      if (previous) {
        if (open.get(previous.turn) === previous) open.delete(previous.turn);
        clearTimeout(previous.timer);
      }
      if (mayAsk && flow.runNow() === flow.run) {
        await flow.cancel(attempt, actor, hold).catch(() => {});
      }
    };
    let result: unknown;
    try {
      result = await call(
        mayAsk
          ? Math.max(1, Math.min(stepWithinMs, step.deadline - now()))
          : undefined,
      );
    } catch (error) {
      const failure = flow.failed(error);
      await close();
      throw failure;
    }
    if (!isAsked(result)) {
      let done: Done;
      try {
        done = flow.finish(result, step.asks);
      } catch (error) {
        await close();
        throw error;
      }
      if (typeof done === "object" && done && "refused" in done) {
        await close();
      } else if (previous) {
        if (open.get(previous.turn) === previous) open.delete(previous.turn);
        clearTimeout(previous.timer);
      }
      return done;
    }
    const asked = mayAsk ? askedOf(result, flow.later, step.asks) : null;
    if (!asked) {
      const failure = flow.failed(new Error("asked what it may not"));
      await close();
      throw failure;
    }
    const at = now();
    const lasting = asked.asks.find((question) => question.lasts);
    const next: Open = previous ?? {
      id: attempt!,
      client: step.client,
      turn: turnOf(flow),
      flow: flow as AskingFlow<unknown>,
      step: 0,
      asks: [],
      deadline: step.deadline,
      lastsUntil: null,
      wrong: 0,
      refusal: null,
      timer: undefined,
    };
    next.step += 1;
    next.asks = asked.asks;
    next.lastsUntil = lasting ? at + lasting.lasts!.seconds * 1_000 : null;
    if (asked.refused) {
      next.wrong += 1;
      next.refusal = asked.refused.refusal;
      if (next.wrong >= maxWrongAnswers) {
        return end(next, "wrong", actor, hold);
      }
    }
    if (!previous) {
      open.set(next.turn, next);
      next.timer = setTimeout(() => expire(next), next.deadline - at);
      next.timer.unref?.();
    }
    return {
      ...asking(next),
      ...(asked.refused ? { refused: asked.refused } : {}),
    };
  }

  return {
    /**
     * Starts adding or repairing within the device's turn: a newer start
     * ends the attempt the device has, and one the client cancelled before
     * its start arrived doesn't begin. Only a client that names an attempt
     * gets questions; for one that doesn't, a flow that may ask is refused
     * before the driver is called, as such a client couldn't answer.
     */
    async start<Done>(
      flow: AskingFlow<Done>,
      step: {
        attempt: string | undefined;
        client: string;
        answers: Record<string, string>;
        asks: readonly DeviceQuestion[];
      },
      actor: Actor,
      hold: Hold,
    ): Promise<Done | DeviceAsking | AttemptEnded> {
      if (closed) throw new ActionCallError("unavailable");
      const { attempt, client } = step;
      if (flow.later.length > 0 && attempt === undefined) {
        throw new ActionCallError("invalid_request");
      }
      const had = open.get(turnOf(flow));
      if (had) await end(had, "replaced", actor, hold);
      prune();
      if (attempt !== undefined) {
        const cancelled = earlyCancels.get(attempt);
        if (cancelled?.client === client) {
          earlyCancels.delete(attempt);
          return { ended: "cancelled" };
        }
        // An id names one attempt, ever.
        if (
          ended.has(attempt) ||
          [...open.values()].some((each) => each.id === attempt)
        ) {
          throw new ActionCallError("conflict");
        }
      }
      if (flow.later.length > 0) {
        const all = [...open.values()];
        if (
          all.length >= inAll ||
          all.filter((each) => each.client === client).length >= perClient
        ) {
          throw new ActionCallError("limited");
        }
      }
      return answered(
        flow,
        {
          client,
          attempt,
          asks: step.asks,
          deadline: now() + attemptMs,
          previous: null,
        },
        (withinMs) =>
          flow.call(
            {
              answers: step.answers,
              ...(attempt !== undefined && flow.later.length > 0
                ? { attempt }
                : {}),
            },
            actor,
            hold,
            withinMs,
          ),
        actor,
        hold,
      );
    },

    /**
     * Takes an answer to what the device's open attempt asks, or a request
     * for a question that lasts to be asked again, in the device's turn.
     * "gone" where the client has no such attempt open and none it had has
     * ended in the meantime.
     */
    next(
      device: Device,
      client: string,
      request: AskingStep,
      actor: Actor,
    ): Promise<DeviceAsking | AttemptEnded | { done: unknown } | "gone"> {
      return turns.take(device, async (hold) => {
        const attempt = open.get(turnOf(device));
        if (!attempt || attempt.id !== request.attempt) {
          prune();
          const before = ended.get(request.attempt);
          return before?.client === client ? { ended: before.end } : "gone";
        }
        if (attempt.client !== client) return "gone";
        if (request.step !== attempt.step) {
          throw new ActionCallError("conflict");
        }
        const { flow } = attempt;
        if (flow.runNow() !== flow.run) {
          return end(attempt, "stopped", actor, hold);
        }
        const fell = flow.standing();
        if (fell) return end(attempt, fell, actor, hold);
        const at = now();
        if (at >= attempt.deadline) return end(attempt, "time", actor, hold);
        let answers: Record<string, string> = {};
        if (request.again !== undefined) {
          const question = attempt.asks.find(
            (each) => each.id === request.again,
          );
          if (!question?.lasts || request.answers !== undefined) {
            throw new ActionCallError("invalid_request");
          }
        } else {
          const checked = options.answersTo(attempt.asks, request.answers);
          if (!checked) throw new ActionCallError("invalid_request");
          // What it answers is gone from the device: the card says so.
          if (
            attempt.lastsUntil !== null &&
            at > attempt.lastsUntil + lastsGraceMs
          ) {
            return asking(attempt);
          }
          answers = checked;
        }
        const result = await answered(
          flow,
          {
            client,
            attempt: attempt.id,
            asks: attempt.asks,
            deadline: attempt.deadline,
            previous: attempt,
          },
          (withinMs) =>
            flow.call(
              {
                answers,
                attempt: attempt.id,
                ...(request.again !== undefined
                  ? { again: request.again }
                  : {}),
              },
              actor,
              hold,
              withinMs,
            ),
          actor,
          hold,
        );
        return typeof result === "object" &&
          result !== null &&
          ("asks" in result || "ended" in result)
          ? (result as DeviceAsking | AttemptEnded)
          : { done: result };
      });
    },

    /**
     * Ends the client's attempt of a device, as Cancel or a closing card
     * asks, in the device's turn: after any step still with the driver. One
     * whose start hasn't arrived is remembered, so it doesn't begin. One
     * that had already ended says how.
     */
    cancel(
      device: Device,
      client: string,
      id: string,
      actor: Actor,
    ): Promise<AttemptEnded> {
      return turns.take(device, async (hold) => {
        const attempt = open.get(turnOf(device));
        if (attempt?.id === id && attempt.client === client) {
          return end(attempt, "cancelled", actor, hold);
        }
        prune();
        const before = ended.get(id);
        if (before?.client === client) return { ended: before.end };
        if (!before) earlyCancels.set(id, { client, at: now() });
        return { ended: "cancelled" };
      });
    },

    /** Ends the device's attempt within a turn already taken, as Remove does. */
    async endWithin(
      device: Device,
      why: AttemptEnd,
      actor: Actor,
      hold: Hold,
    ): Promise<void> {
      const attempt = open.get(turnOf(device));
      if (attempt) await end(attempt, why, actor, hold);
    },

    /** Stops the attempts' clocks as the core stops; the drivers' runs end with it. */
    close() {
      closed = true;
      for (const attempt of open.values()) clearTimeout(attempt.timer);
      open.clear();
    },
  };
}

export type Asking = ReturnType<typeof createAsking>;
