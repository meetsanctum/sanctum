import { z } from "zod";

import {
  isDeclaredRefusal,
  maxQuestions,
  problemId,
  type DeviceQuestion,
} from "./device-problems.js";

// Adding and repairing that ask once they have started, as a TV that shows a
// code only once pairing begins, then a second once the first is accepted.
// driver.add or driver.repair answers with what it asks next, of the
// questions declared for it (driver.addLater, a problem's repair.later); the
// core keeps the attempt open while the person reads the code off the
// device, and hands each answer back by the same question's id. An attempt
// lasts 3 minutes in all. Cancel, the time running out, a newer Add or
// Repair of the same device and Remove end it, and the core then calls
// driver.cancelAdd or driver.cancelRepair so the driver closes what it
// opened: a device left waiting for an answer may show no new code to the
// next attempt.

/** How long an attempt that asks stays open, in all. */
export const attemptMs = 180_000;

/** The most wrong answers an attempt takes before it ends. */
export const maxWrongAnswers = 5;

/**
 * What a driver answers once adding or repairing needs more of the person:
 * the questions it asks next, by id, and the refusal of the answer just
 * given that made it ask again, if one did.
 */
export type DriverAsked = {
  asks: string[];
  refused?: { question: string; refusal: string };
};

/** What the core hands a driver to end adding a device that asks (driver.cancelAdd). */
export type DriverCancelAdd = { key: string; attempt: string };

/** What the core hands a driver to end repairing a device that asks (driver.cancelRepair). */
export type DriverCancelRepair = {
  key: string;
  device: string;
  attempt: string;
};

/**
 * Why an attempt ended before it added or repaired the device: Cancel, its
 * time, a newer one of the same device, too many wrong answers, its driver
 * stopping, the device being removed, or its problem clearing outside it.
 */
export const attemptEnds = [
  "cancelled",
  "time",
  "replaced",
  "wrong",
  "stopped",
  "removed",
  "settled",
] as const;
export type AttemptEnd = (typeof attemptEnds)[number];

/** An attempt that ended without adding or repairing the device. */
export type AttemptEnded = { ended: AttemptEnd };

/** What a client sees while adding or repairing asks (POST /api/devices/add, /repair). */
export type DeviceAsking = {
  /** The attempt the client named as it started. */
  attempt: string;
  /** Goes up with each set of questions; an answer names the step it answers. */
  step: number;
  asks: DeviceQuestion[];
  /** The refusal of the answer just given, in the words its question declares. */
  refused?: { question: string; refusal: string };
  /** What's left of the attempt's time. */
  withinMs: number;
  /** What's left of the time a question that lasts has, if one is asked. */
  lastsMs: number | null;
};

/** An attempt's id, which the client makes as it starts one. */
export const attemptId = z.uuid();

/** Whether a driver's answer asks something rather than ending adding or repairing. */
export function isAsked(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    Object.hasOwn(result, "asks")
  );
}

/**
 * What a driver asks next, if its answer is one it may give: 1 to 8
 * distinct questions of those declared for what it does (`later`), at most
 * one of them lasting, and any refusal one the questions just answered
 * (`answered`) declares. Null for anything else, which is the driver's
 * failure.
 */
export function askedOf(
  result: unknown,
  later: readonly DeviceQuestion[],
  answered: readonly DeviceQuestion[],
): {
  asks: DeviceQuestion[];
  refused?: { question: string; refusal: string };
} | null {
  const parsed = z
    .strictObject({
      asks: z.array(z.string().regex(problemId)).min(1).max(maxQuestions),
      refused: z.unknown().optional(),
    })
    .safeParse(result);
  if (!parsed.success) return null;
  const ids = parsed.data.asks;
  if (new Set(ids).size !== ids.length) return null;
  const asks = ids.map((id) => later.find((question) => question.id === id));
  if (asks.some((question) => question === undefined)) return null;
  const shown = asks as DeviceQuestion[];
  if (shown.filter((question) => question.lasts).length > 1) return null;
  const { refused } = parsed.data;
  if (refused === undefined) return { asks: shown };
  if (!isDeclaredRefusal(answered, refused)) return null;
  return {
    asks: shown,
    refused: { question: refused.question, refusal: refused.refusal },
  };
}
