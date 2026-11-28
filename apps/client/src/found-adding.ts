import type {
  AddResult,
  DeviceInfo,
  DeviceQuestion,
  FoundDevice,
} from "@meetsanctum/app-sdk";
import { useEffect, useRef, useState } from "react";

import { CoreError, coreJson } from "./core-fetch";
import {
  answersFor,
  askingOf,
  cancelQuietly,
  endedWords,
  isAsking,
  isComplete,
  isEnded,
  isLastsUp,
  lastingOf,
  newAttemptId,
  useNow,
  type Asking,
} from "./device-asking";
import { problemReason } from "./device-parts";
import { refusalWords, type Refused } from "./device-questions";

// Adding a device a driver found, as Add devices' cards and Settings →
// Devices' dialog both do: the answers to what its driver asks first, the
// attempt it names from the first press, each step it asks once started,
// Cancel, and why it didn't add the device. Whatever is still open when the
// one adding goes away is cancelled, as when its card or dialog closes.

/** What pressing Add again would do after adding stopped, if anything can. */
export type Retry = "try" | "add" | null;

export type AddFailure = {
  reason: string;
  // Stopping it is what failed, not adding it.
  stopping?: true;
  retry: Retry;
};

function addProblem(error: unknown, appName: string | null) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "unavailable":
        return `${appName ?? "Its app"} isn't running, so it can't add it now.`;
      case "timeout":
        return `${appName ?? "Its app"} didn't answer in time. Try again in a moment.`;
      case "not_found":
        return "It's no longer on your network.";
      case "app_failed":
        return `${appName ?? "Its app"} ran into a problem. Try again in a moment.`;
    }
  }
  return problemReason(error);
}

// Trying again can't help a device that's gone or an app that isn't running.
const retryAfter = (error: unknown): Retry =>
  error instanceof CoreError &&
  (error.code === "not_found" || error.code === "unavailable")
    ? null
    : "try";

export type Doing = "adding" | "checking" | "asking" | "stopping";

export function useFoundAdding(
  found: FoundDevice,
  appName: string | null,
  onAdded: (device: DeviceInfo) => void,
) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Refused>();
  const [failure, setFailure] = useState<AddFailure>();
  // What the press under way does: start, answer, ask again or stop.
  const [doing, setDoing] = useState<Doing | null>(null);
  const request = useRef<{ what: Doing } | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  // The attempt open from the first press until it ends.
  const attempt = useRef<string | null>(null);
  // An answer that arrives once the one adding is gone goes nowhere, and an
  // attempt still open ends with it.
  const isShown = useRef(true);
  const device = { driver: found.driver, key: found.key };
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const added = useRef(onAdded);
  added.current = onAdded;
  useEffect(() => {
    isShown.current = true;
    return () => {
      isShown.current = false;
      if (attempt.current) {
        cancelQuietly("/api/devices/add/cancel", {
          ...deviceRef.current,
          attempt: attempt.current,
        });
        attempt.current = null;
      }
    };
  }, []);

  const now = useNow(asking !== null);
  // The attempt's time ran out: the core ended it.
  useEffect(() => {
    if (asking && doing === null && !failure?.stopping && now >= asking.until) {
      attempt.current = null;
      setAsking(null);
      setAnswers({});
      const reason = endedWords("adding", "time", appName);
      setFailure(reason ? { reason, retry: "add" } : undefined);
    }
  }, [asking, doing, failure?.stopping, now, appName]);

  const answerTo = (id: string) =>
    Object.hasOwn(answers, id) ? answers[id]! : "";
  const lastsUp = asking !== null && isLastsUp(asking, now);

  // Takes where adding got to.
  const took = (result: AddResult, answered: readonly DeviceQuestion[]) => {
    if (isAsking(result)) {
      setAsking(askingOf(result, answered));
      setAnswers({});
      return;
    }
    attempt.current = null;
    setAsking(null);
    // Only the first fields stay for someone to correct.
    if (asking || !("refused" in result)) setAnswers({});
    if ("added" in result) {
      added.current(result.added);
    } else if ("refused" in result) {
      // A refusal of adding it at all is said in its driver's words.
      const refusal = result.refused;
      if ("question" in refusal && !asking) {
        setRefused(refusal);
      } else {
        const reason =
          "question" in refusal
            ? refusalWords(answered, refusal)
            : found.refusals[refusal.refusal];
        setFailure(reason ? { reason, retry: "add" } : undefined);
      }
    } else if (isEnded(result)) {
      const reason = endedWords("adding", result.ended, appName);
      setFailure(
        reason
          ? {
              reason,
              retry:
                result.ended === "replaced" || result.ended === "removed"
                  ? null
                  : "add",
            }
          : undefined,
      );
    }
  };

  const send = async (
    what: Doing,
    path: "/api/devices/add" | "/api/devices/add/cancel",
    json: Record<string, unknown>,
    answered: readonly DeviceQuestion[],
  ) => {
    if (
      request.current &&
      (what !== "stopping" || request.current.what === "stopping")
    )
      return;
    // Cancel can overtake a step's reply. Only the latest request changes what shows.
    const current = { what };
    request.current = current;
    const stillCurrent = () => isShown.current && request.current === current;
    setDoing(what);
    setRefused(undefined);
    setFailure(undefined);
    try {
      const result = await coreJson<AddResult>(path, {
        method: "POST",
        json: { ...device, ...json },
      });
      if (!stillCurrent()) return;
      took(result, answered);
      return result;
    } catch (error) {
      if (!stillCurrent()) return;
      if (what === "stopping") {
        // Keep the attempt so Cancel can check its outcome again.
        setFailure({
          reason: problemReason(error),
          stopping: true,
          retry: null,
        });
        return;
      }
      if (attempt.current) {
        cancelQuietly("/api/devices/add/cancel", {
          ...device,
          attempt: attempt.current,
        });
      }
      attempt.current = null;
      setAsking(null);
      setFailure({
        reason: addProblem(error, appName),
        retry: retryAfter(error),
      });
    } finally {
      if (stillCurrent()) {
        request.current = null;
        setDoing(null);
      }
    }
  };

  /** Starts adding, with the answers to what its driver asks first. */
  const add = () => {
    if (request.current || failure?.stopping) return;
    const id = newAttemptId();
    attempt.current = id;
    void send(
      "adding",
      "/api/devices/add",
      {
        answers: Object.fromEntries(
          found.asks.map((question) => [question.id, answerTo(question.id)]),
        ),
        attempt: id,
      },
      found.asks,
    );
  };

  /** Answers the step asked, asks for a new code once its time is up, or starts. */
  const submit = () => {
    if (failure?.stopping) return;
    if (asking) {
      const lasting = lastingOf(asking);
      if (lastsUp && lasting) {
        void send(
          "asking",
          "/api/devices/add",
          { attempt: asking.attempt, step: asking.step, again: lasting.id },
          asking.asks,
        );
      } else if (isComplete(asking.asks, answers)) {
        void send(
          "checking",
          "/api/devices/add",
          {
            attempt: asking.attempt,
            step: asking.step,
            answers: answersFor(asking.asks, answers),
          },
          asking.asks,
        );
      }
      return;
    }
    if (isComplete(found.asks, answers)) add();
  };

  /**
   * Stops the attempt its driver is asking in, answering whether it
   * stopped. With nothing asked, there's nothing to wait for: what's under
   * way ends quietly as the one adding goes.
   */
  const cancel = async () => {
    if (request.current?.what === "stopping") return false;
    if (!asking) return true;
    const result = await send(
      "stopping",
      "/api/devices/add/cancel",
      { attempt: asking.attempt },
      asking.asks,
    );
    return (
      result !== undefined && isEnded(result) && result.ended === "cancelled"
    );
  };

  return {
    answers,
    answerTo,
    setAnswer: (question: string, value: string) =>
      setAnswers((before) => ({ ...before, [question]: value })),
    refused,
    failure,
    doing,
    asking,
    now,
    lastsUp,
    lasting: asking ? lastingOf(asking) : null,
    // Whether what its driver asks first is all answered.
    complete: isComplete(found.asks, answers),
    isWorking: doing !== null || asking !== null,
    add,
    submit,
    cancel,
  };
}
