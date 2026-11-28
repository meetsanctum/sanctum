import type {
  AttemptEnded,
  DeviceAsking,
  DeviceInfo,
  DeviceQuestion,
} from "@meetsanctum/app-sdk";
import { Button, Problem } from "@meetsanctum/ui-sdk";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import {
  answersFor,
  askingOf,
  AskingFields,
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
import { QuestionField, refusalWords, type Refused } from "./device-questions";

// Repair: what a device's driver asks to set it right, in the words it
// declares. The answers go to the core once, in the body of one request, and
// stay nowhere: the fields empty as the dialog closes, however it closes. A
// refused answer says why under its field, which keeps what was typed so it
// can be corrected. Where the repair asks once started, as a TV shows a code
// only once pairing begins, the dialog asks each step in turn, and closing it
// ends the attempt it named from the first press.

type RepairResult =
  { repaired: DeviceInfo } | { refused: Refused } | DeviceAsking | AttemptEnded;

const cancelPath = "/api/devices/repair/cancel";

function repairProblem(error: unknown, appName: string | null) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "unavailable":
        return `${appName ?? "Its app"} isn't running, so it can't repair it now.`;
      case "timeout":
        return `${appName ?? "Its app"} didn't answer in time. Try again in a moment.`;
      case "conflict":
        return "It doesn't need repairing any more.";
      case "app_failed":
        return `${appName ?? "Its app"} ran into a problem. Try again in a moment.`;
      case "limited":
        return "Too many devices are being added or repaired at once. Try again in a few minutes.";
    }
  }
  return problemReason(error);
}

export function RepairDevice(props: {
  // The device being repaired, while the dialog is open.
  device?: DeviceInfo;
  appName: string | null;
  onClose: () => void;
  onRepaired: (device: DeviceInfo) => void;
}) {
  const ids = useId();
  // What the dialog showed stays while it closes.
  const last = useRef<DeviceInfo>(undefined);
  if (props.device) last.current = props.device;
  const device = last.current;
  const repair = device?.problem?.repair ?? null;
  const asks = repair?.asks ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Refused>();
  const [failure, setFailure] = useState<string>();
  const [doing, setDoing] = useState<
    "repairing" | "checking" | "asking" | "stopping" | null
  >(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  // The attempt open from the first press until it ends.
  const attempt = useRef<{ id: string; device: string } | null>(null);
  const current = useRef(props.device);
  current.current = props.device;
  const request = useRef(0);

  // An attempt still open ends with the dialog, however it closes.
  const endAttempt = () => {
    if (attempt.current) {
      cancelQuietly(cancelPath, {
        id: attempt.current.device,
        attempt: attempt.current.id,
      });
      attempt.current = null;
    }
  };

  // Opening and closing both start afresh, so no answer outlives the dialog.
  useEffect(() => {
    request.current += 1;
    setAnswers({});
    setRefused(undefined);
    setFailure(undefined);
    setDoing(null);
    setAsking(null);
    return () => {
      request.current += 1;
      endAttempt();
    };
  }, [props.device?.id, !!props.device]);

  const now = useNow(asking !== null);
  // The attempt's time ran out: the core ended it.
  useEffect(() => {
    if (asking && now >= asking.until) {
      attempt.current = null;
      setAsking(null);
      setAnswers({});
      setFailure(endedWords("repairing", "time", props.appName) ?? undefined);
    }
  }, [asking, now, props.appName]);

  const answerTo = (id: string) =>
    Object.hasOwn(answers, id) ? answers[id]! : "";
  const complete = asking
    ? isComplete(asking.asks, answers)
    : isComplete(asks, answers);
  const lastsUp = asking !== null && isLastsUp(asking, now);
  const lasting = asking ? lastingOf(asking) : null;

  const send = async (
    what: "repairing" | "checking" | "asking" | "stopping",
    path: "/api/devices/repair" | typeof cancelPath,
    json: Record<string, unknown>,
    answered: readonly DeviceQuestion[],
  ) => {
    const repairing = props.device;
    if (!repairing || doing) return;
    const pending = ++request.current;
    setDoing(what);
    setRefused(undefined);
    setFailure(undefined);
    try {
      const result = await coreJson<RepairResult>(path, {
        method: "POST",
        json: { id: repairing.id, ...json },
      });
      if (current.current !== repairing || request.current !== pending) return;
      setDoing(null);
      if (isAsking(result)) {
        setAsking(askingOf(result, answered));
        setAnswers({});
        return;
      }
      attempt.current = null;
      setAsking(null);
      if (isEnded(result)) {
        setAnswers({});
        const words = endedWords("repairing", result.ended, props.appName);
        if (words) setFailure(words);
        return;
      }
      if ("refused" in result) {
        if (asking) {
          setAnswers({});
          setFailure(refusalWords(answered, result.refused));
        } else {
          setRefused(result.refused);
        }
        return;
      }
      props.onRepaired(result.repaired);
      props.onClose();
    } catch (error) {
      if (current.current !== repairing || request.current !== pending) return;
      setDoing(null);
      endAttempt();
      setAsking(null);
      setFailure(repairProblem(error, props.appName));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const repairing = props.device;
    if (!repairing || doing) return;
    if (asking) {
      if (lastsUp && lasting) {
        void send(
          "asking",
          "/api/devices/repair",
          { attempt: asking.attempt, step: asking.step, again: lasting.id },
          asking.asks,
        );
      } else if (complete) {
        void send(
          "checking",
          "/api/devices/repair",
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
    if (!complete) return;
    const id = newAttemptId();
    attempt.current = { id, device: repairing.id };
    void send(
      "repairing",
      "/api/devices/repair",
      { answers: answersFor(asks, answers), attempt: id },
      asks,
    );
  };

  // Cancel ends the attempt first, where one asks; the dialog closes either way.
  const cancel = () => {
    endAttempt();
    props.onClose();
  };

  return (
    <Dialog
      open={!!props.device}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Repair {device?.name}</DialogTitle>
            <DialogDescription>
              {repair?.help ?? device?.problem?.words}
            </DialogDescription>
          </DialogHeader>
          {asking ? (
            <AskingFields
              idPrefix={ids}
              asking={asking}
              answers={answers}
              now={now}
              disabled={doing !== null}
              onChange={(question, value) =>
                setAnswers((before) => ({ ...before, [question]: value }))
              }
            />
          ) : (
            asks.map((question, index) => (
              <QuestionField
                key={question.id}
                id={`${ids}-${question.id}`}
                question={question}
                value={answerTo(question.id)}
                refused={refused}
                autoFocus={index === 0}
                onChange={(value) =>
                  setAnswers((before) => ({ ...before, [question.id]: value }))
                }
              />
            ))
          )}
          {failure && (
            <Problem title={`${device?.name} wasn't repaired`}>
              {failure}
            </Problem>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={doing !== null || (!lastsUp && !complete)}
            >
              {doing === "repairing"
                ? "Repairing…"
                : doing === "checking"
                  ? "Checking…"
                  : doing === "asking"
                    ? "Asking…"
                    : asking
                      ? lastsUp && lasting?.lasts
                        ? lasting.lasts.again
                        : "Continue"
                      : "Repair"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
