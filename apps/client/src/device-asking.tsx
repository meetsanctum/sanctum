import type {
  AttemptEnd,
  AttemptEnded,
  DeviceAsking,
  DeviceQuestion,
} from "@meetsanctum/app-sdk";
import { FieldProblem } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { coreFetch } from "./core-fetch";
import { QuestionField, refusalWords } from "./device-questions";

// Adding and repairing that ask once they have started, as a TV shows a code
// only once pairing begins: the questions of the step on the screen, with
// the time a code that lasts has left after its help, and the words for how
// an attempt ended without adding or repairing the device. The client names
// the attempt as it starts, so closing the card or dialog can end it even
// before the first question arrives.

/** A random attempt id, made where crypto.randomUUID isn't, as on a plain-HTTP page. */
export function newAttemptId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((part) => part.join(""))
    .join("-");
}

/** The step on the screen, with when its times end by this client's clock. */
export type Asking = DeviceAsking & {
  until: number;
  lastsUntil: number | null;
  // A refusal of a question no longer asked, in that question's words.
  refusedApart: string | null;
};

/** The step a driver asks, from what the core answered and the step before. */
export function askingOf(
  result: DeviceAsking,
  answered: readonly DeviceQuestion[],
  at = Date.now(),
): Asking {
  const { refused } = result;
  const apart =
    refused && !result.asks.some((each) => each.id === refused.question)
      ? (refusalWords(answered, refused) ?? null)
      : null;
  return {
    ...result,
    until: at + result.withinMs,
    lastsUntil: result.lastsMs === null ? null : at + result.lastsMs,
    refusedApart: apart,
  };
}

export const isAsking = (result: object): result is DeviceAsking =>
  "asks" in result && "step" in result;

export const isEnded = (result: object): result is AttemptEnded =>
  "ended" in result;

/** Why adding or repairing stopped, or nothing where someone cancelled it. */
export function endedWords(
  what: "adding" | "repairing",
  end: AttemptEnd,
  appName: string | null,
): string | null {
  const doing = what === "adding" ? "Adding" : "Repairing";
  const again = what === "adding" ? "Add it again" : "Try again";
  switch (end) {
    case "cancelled":
      return null;
    case "time":
      return `${doing} stopped after 3 minutes. ${again} when you're ready.`;
    case "replaced":
      return `${doing} was started again on another screen.`;
    case "wrong":
      return `Too many wrong answers. ${again} when you're ready.`;
    case "stopped":
      return `${appName ?? "Its app"} stopped, so ${what} stopped. ${again}.`;
    case "removed":
      return "It was removed.";
    case "settled":
      return "It doesn't need repairing any more.";
  }
}

/**
 * Ends an attempt as its card or dialog goes. It is sent even as the window
 * closes, and what it answers no longer matters to anyone.
 */
export function cancelQuietly(
  path: "/api/devices/add/cancel" | "/api/devices/repair/cancel",
  json: Record<string, string>,
) {
  void coreFetch(path, { method: "POST", json, keepalive: true }).catch(
    () => undefined,
  );
}

/** The time now, again each second while something counts down. */
export function useNow(isCounting: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isCounting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isCounting]);
  return now;
}

/** Whether a question that lasts has run out of time. */
export const isLastsUp = (asking: Asking, now: number) =>
  asking.lastsUntil !== null && now >= asking.lastsUntil;

/** The question that lasts, of those asked, if one does. */
export const lastingOf = (asking: Asking) =>
  asking.asks.find((question) => question.lasts) ?? null;

/** Whether every question has an answer, a code all its digits. */
export function isComplete(
  asks: readonly DeviceQuestion[],
  answers: Readonly<Record<string, string>>,
) {
  return asks.every((question) => {
    const answer = Object.hasOwn(answers, question.id)
      ? answers[question.id]!
      : "";
    if (question.kind !== "code") return answer !== "";
    const length = question.length ?? null;
    return (
      /^[0-9]+$/.test(answer) && (length === null || answer.length === length)
    );
  });
}

/** Only the answers to what is asked now. */
export const answersFor = (
  asks: readonly DeviceQuestion[],
  answers: Readonly<Record<string, string>>,
) =>
  Object.fromEntries(
    asks.map((question) => [
      question.id,
      Object.hasOwn(answers, question.id) ? answers[question.id]! : "",
    ]),
  );

/**
 * The questions of the step on the screen. Each step's fields are new ones,
 * so the first takes focus as the press that asked for it brought it. A
 * screen reader hears the time a code has when its field takes focus, then
 * only when 10 seconds remain and when the time is up.
 */
export function AskingFields(props: {
  idPrefix: string;
  asking: Asking;
  answers: Readonly<Record<string, string>>;
  now: number;
  narrow?: boolean;
  disabled?: boolean;
  onChange: (question: string, value: string) => void;
}) {
  const { asking, now } = props;
  const lasting = lastingOf(asking);
  const isUp = isLastsUp(asking, now);
  const seconds =
    asking.lastsUntil === null
      ? null
      : Math.max(0, Math.ceil((asking.lastsUntil - now) / 1_000));
  return (
    <>
      {asking.refusedApart && (
        <FieldProblem>{asking.refusedApart}</FieldProblem>
      )}
      {asking.asks.map((question, index) => (
        <QuestionField
          key={`${asking.step}-${question.id}`}
          id={`${props.idPrefix}-${asking.step}-${question.id}`}
          question={question}
          value={
            Object.hasOwn(props.answers, question.id)
              ? props.answers[question.id]!
              : ""
          }
          refused={asking.refused}
          autoFocus={index === 0}
          narrow={props.narrow}
          disabled={props.disabled}
          remaining={
            question === lasting && seconds !== null
              ? isUp
                ? "up"
                : seconds
              : undefined
          }
          onChange={(value) => props.onChange(question.id, value)}
        />
      ))}
      <p role="status" className="sr-only">
        {isUp
          ? "Time to enter this code is up."
          : seconds !== null && seconds <= 10
            ? "10 seconds remaining."
            : ""}
      </p>
    </>
  );
}
