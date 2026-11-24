import {
  askedOf,
  attemptMs,
  isAsked,
  maxWrongAnswers,
  type Actor,
  type AddResult,
  type AttemptEnd,
  type AttemptEnded,
  type DeviceAsking,
  type DeviceInfo,
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

type Device = { driver: string; key: string };
type Target =
  | ({ operation: "add" } & Device)
  | {
      operation: "repair";
      id: string;
    };

export type AddDone = Extract<
  AddResult,
  { added: DeviceInfo } | { refused: unknown }
>;
export type RepairDone =
  { repaired: DeviceInfo } | { refused: { question: string; refusal: string } };

type Completion =
  | { operation: "add"; done: AddDone }
  | { operation: "repair"; done: RepairDone };

/** What adding or repairing does for the attempts it opens. */
export type AskingFlow<Done extends Completion> = Device & {
  target: Extract<Target, { operation: Done["operation"] }>;
  /** The run of the driver it began with, where the call is tied to a run. */
  run: number | undefined;
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
  cancel(attempt: string, actor: Actor, hold: Hold, run: number): Promise<void>;
  /** Records an attempt that ended after a refused answer, by that refusal. */
  refused(refusal: string): void;
};

type Attempt = {
  id: string;
  client: string;
  turn: string;
  flow: AskingFlow<Completion>;
  step: number;
  asks: DeviceQuestion[];
  deadline: number;
  lastsUntil: number | null;
  wrong: number;
  // The refusal of the last answer refused, if one was.
  refusal: string | null;
  settled: boolean;
  cleanup?: Promise<void>;
  timer: NodeJS.Timeout | undefined;
};

const turnOf = (device: Device) => `${device.driver}\u0000${device.key}`;
const targetOf = (target: Target) =>
  target.operation === "add"
    ? JSON.stringify(["add", target.driver, target.key])
    : JSON.stringify(["repair", target.id]);
const cancelKey = (target: string, client: string, id: string) =>
  JSON.stringify([target, client, id]);

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
  const open = new Map<string, Attempt>();
  const starting = new Map<string, Attempt>();
  const ended = new Map<
    string,
    { target: string; client: string; end: AttemptEnd; at: number }
  >();
  const earlyCancels = new Map<string, { at: number }>();
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

  function asking(attempt: Attempt): DeviceAsking {
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

  function forget(attempt: Attempt) {
    if (open.get(attempt.turn) === attempt) open.delete(attempt.turn);
    clearTimeout(attempt.timer);
  }

  function remember(attempt: Attempt, why: AttemptEnd): AttemptEnded {
    prune();
    ended.set(attempt.id, {
      client: attempt.client,
      target: targetOf(attempt.flow.target),
      end: why,
      at: now(),
    });
    return { ended: why };
  }

  function endedFor(target: string, client: string, id: string) {
    prune();
    const before = ended.get(id);
    return before?.client === client && before.target === target
      ? { ended: before.end }
      : undefined;
  }

  async function cancelDriver(attempt: Attempt, actor: Actor, hold: Hold) {
    const { flow } = attempt;
    if (flow.run !== undefined && flow.runNow() === flow.run) {
      await flow.cancel(attempt.id, actor, hold, flow.run).catch(() => {});
    }
  }

  // Ends an attempt within its device's turn. The driver closes what it
  // opened, unless its run is gone, which closed it. A failure to close is
  // the driver's, which the host logs without its words.
  async function end(
    attempt: Attempt,
    why: AttemptEnd,
    actor: Actor,
    hold: Hold,
  ): Promise<AttemptEnded> {
    forget(attempt);
    const outcome = remember(attempt, why);
    if (attempt.refusal !== null) attempt.flow.refused(attempt.refusal);
    if (why !== "stopped") await cancelDriver(attempt, actor, hold);
    return outcome;
  }

  // The time an attempt has runs out as a step of its own.
  function expire(attempt: Attempt) {
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
  async function answered<Done extends Completion>(
    flow: AskingFlow<Done>,
    step: {
      asks: readonly DeviceQuestion[];
      answers: Record<string, string>;
      again?: string;
    },
    attempt: Attempt | undefined,
    actor: Actor,
    hold: Hold,
  ): Promise<Done | DeviceAsking | AttemptEnded> {
    // Whatever ends it here, a driver that may have opened something for
    // it closes it.
    const close = async () => {
      if (!attempt) return;
      forget(attempt);
      await cancelDriver(attempt, actor, hold);
    };
    const running: Promise<unknown>[] = [];
    let result: unknown;
    try {
      result = await flow.call(
        {
          answers: step.answers,
          ...(attempt ? { attempt: attempt.id } : {}),
          ...(step.again !== undefined ? { again: step.again } : {}),
        },
        actor,
        (call) => {
          running.push(call);
          hold(call);
        },
        attempt
          ? Math.max(1, Math.min(stepWithinMs, attempt.deadline - now()))
          : undefined,
      );
    } catch (error) {
      const failure = flow.failed(error);
      if (attempt && failure.code === "timeout") {
        // The response times out before the driver stops. Close pairing
        // after that work ends, still in the same device turn.
        attempt.cleanup = Promise.allSettled(running).then(close);
        hold(attempt.cleanup);
      } else {
        await close();
      }
      throw failure;
    }
    if (attempt?.settled && result !== undefined) {
      return end(attempt, "settled", actor, hold);
    }
    if (!isAsked(result)) {
      let done: Done;
      try {
        done = flow.finish(result, step.asks);
      } catch (error) {
        await close();
        throw error;
      }
      if ("refused" in done.done) {
        await close();
      } else if (attempt) {
        forget(attempt);
      }
      return done;
    }
    const asked = askedOf(result, flow.later, step.asks);
    if (!attempt || !asked) {
      const failure = flow.failed(new Error("asked what it may not"));
      await close();
      throw failure;
    }
    if (closed || flow.runNow() !== flow.run) {
      return end(attempt, "stopped", actor, hold);
    }
    const at = now();
    const lasting = asked.asks.find((question) => question.lasts);
    attempt.step += 1;
    attempt.asks = asked.asks;
    attempt.lastsUntil = lasting ? at + lasting.lasts!.seconds * 1_000 : null;
    if (asked.refused) {
      attempt.wrong += 1;
      attempt.refusal = asked.refused.refusal;
      if (attempt.wrong >= maxWrongAnswers) {
        return end(attempt, "wrong", actor, hold);
      }
    }
    if (attempt.step === 1) {
      starting.delete(attempt.turn);
      open.set(attempt.turn, attempt);
      attempt.timer = setTimeout(() => expire(attempt), attempt.deadline - at);
      attempt.timer.unref?.();
    }
    return {
      ...asking(attempt),
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
    async start<Done extends Completion>(
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
      const turn = turnOf(flow);
      const had = open.get(turn);
      const target = targetOf(flow.target);
      prune();
      if (attempt !== undefined) {
        // An id belongs to a single pending, open or remembered attempt.
        if (
          ended.has(attempt) ||
          [...open.values(), ...starting.values()].some(
            (each) => each.id === attempt,
          )
        ) {
          throw new ActionCallError("conflict");
        }
        if (earlyCancels.has(cancelKey(target, client, attempt))) {
          return { ended: "cancelled" };
        }
      }
      let pending: Attempt | undefined;
      if (attempt !== undefined && flow.later.length > 0) {
        const all = [...open.values(), ...starting.values()].filter(
          (each) => each !== had,
        );
        if (
          all.length >= inAll ||
          all.filter((each) => each.client === client).length >= perClient
        ) {
          throw new ActionCallError("limited");
        }
        pending = {
          id: attempt,
          client,
          turn,
          flow,
          step: 0,
          asks: [],
          deadline: now() + attemptMs,
          lastsUntil: null,
          wrong: 0,
          refusal: null,
          settled: false,
          timer: undefined,
        };
        starting.set(turn, pending);
      }
      const release = () => {
        if (pending && starting.get(turn) === pending) starting.delete(turn);
      };
      try {
        if (had) {
          const cancelling: Promise<unknown>[] = [];
          await end(
            had,
            had.settled ? "settled" : "replaced",
            actor,
            (call) => {
              cancelling.push(call);
              hold(call);
            },
          );
          await Promise.allSettled(cancelling);
        }
        const fell =
          flow.run !== undefined && flow.runNow() !== flow.run
            ? "stopped"
            : pending?.settled
              ? "settled"
              : flow.standing();
        if (fell) return pending ? remember(pending, fell) : { ended: fell };
        if (pending) pending.deadline = now() + attemptMs;
        return await answered(flow, step, pending, actor, hold);
      } finally {
        if (pending?.cleanup) void pending.cleanup.then(release, release);
        else release();
      }
    },

    /**
     * Takes an answer to what the device's open attempt asks, or a request
     * for a question that lasts to be asked again, in the device's turn.
     * "gone" where the client has no such attempt open and none it had has
     * ended in the meantime.
     */
    next(
      device: Device,
      target: Target,
      client: string,
      request: AskingStep,
      actor: Actor,
    ): Promise<DeviceAsking | AttemptEnded | Completion | "gone"> {
      const key = targetOf(target);
      return turns.take(device, async (hold) => {
        const attempt = open.get(turnOf(device));
        if (!attempt || attempt.id !== request.attempt) {
          return endedFor(key, client, request.attempt) ?? "gone";
        }
        if (
          attempt.client !== client ||
          targetOf(attempt.flow.target) !== key
        ) {
          return "gone";
        }
        if (request.step !== attempt.step) {
          throw new ActionCallError("conflict");
        }
        const { flow } = attempt;
        if (flow.runNow() !== flow.run) {
          return end(attempt, "stopped", actor, hold);
        }
        const fell = attempt.settled ? "settled" : flow.standing();
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
        return answered(
          flow,
          {
            answers,
            asks: request.again === undefined ? attempt.asks : [],
            ...(request.again !== undefined ? { again: request.again } : {}),
          },
          attempt,
          actor,
          hold,
        );
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
      target: Target,
      client: string,
      id: string,
      actor: Actor,
    ): Promise<AttemptEnded> {
      const key = targetOf(target);
      return turns.take(device, async (hold) => {
        const attempt = open.get(turnOf(device));
        if (
          attempt?.id === id &&
          attempt.client === client &&
          targetOf(attempt.flow.target) === key
        ) {
          return end(
            attempt,
            attempt.settled ? "settled" : "cancelled",
            actor,
            hold,
          );
        }
        const before = endedFor(key, client, id);
        if (before) return before;
        if (!ended.has(id))
          earlyCancels.set(cancelKey(key, client, id), { at: now() });
        return { ended: "cancelled" };
      });
    },

    /** Looks up an ended Repair after its device is gone. */
    endedRepair(device: string, client: string, id: string) {
      return endedFor(
        targetOf({ operation: "repair", id: device }),
        client,
        id,
      );
    },

    /** A problem changed outside its repair. Let a driver step in progress finish. */
    settleRepair(device: Device, id: string) {
      const turn = turnOf(device);
      const attempt = starting.get(turn) ?? open.get(turn);
      const target = attempt?.flow.target;
      if (
        !attempt ||
        target?.operation !== "repair" ||
        target.id !== id ||
        attempt.settled
      )
        return;
      attempt.settled = true;
      void turns
        .take(device, async (hold) => {
          if (open.get(turn) === attempt) {
            await end(
              attempt,
              "settled",
              { kind: "app", id: device.driver },
              hold,
            );
          }
        })
        .catch(() => {});
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
      starting.clear();
    },
  };
}

export type Asking = ReturnType<typeof createAsking>;
