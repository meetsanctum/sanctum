import type {
  AddResult,
  DeviceInfo,
  DeviceQuestion,
  FoundDevice,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  CardFoot,
  CardLine,
  CardRound,
  DeviceCard,
  ReadyCardContent,
  TypeIcon,
  type CardWork,
} from "./add-devices-cards";
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
import { deviceProblem } from "./device-parts";
import { QuestionField, refusalWords, type Refused } from "./device-questions";

// Add devices' page of what drivers found, as on the home's network: a card
// for each, with Add, which asks in place what its driver needs, such as its
// key, a refused answer saying why under its field. A device added here
// stays, green, to be named and placed. While nothing is found, it says what
// to check; once something is, the overlay's footer asks after the rest.

export const foundKey = (found: { driver: string; key: string }) =>
  `${found.driver}\u0000${found.key}`;

function addProblem(error: unknown, appName: string | null) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "unavailable":
        return `${appName ?? "Its app"} isn't running, so it can't add it now.`;
      case "timeout":
        return "It didn't answer in time. Check it's switched on, then try again.";
      case "not_found":
        return "It's no longer on your network.";
      case "app_failed":
        return `${appName ?? "Its app"} couldn't add it. Try again.`;
    }
  }
  return deviceProblem(error);
}

export function FoundPage(props: {
  shown: readonly FoundDevice[];
  added: Record<string, DeviceInfo>;
  devices: readonly DeviceInfo[];
  appName: (id: string) => string | null;
  onWorkingChange: (key: string, isWorking: boolean) => void;
  onAdded: (key: string, device: DeviceInfo) => void;
  work: CardWork;
}) {
  const isEmpty = props.shown.length === 0;
  return (
    // With nothing found, what it says sits in the middle of the window, as
    // a radio's page waits there.
    <div
      className={cn("flex flex-col", isEmpty && "flex-1 justify-center pb-16")}
    >
      {isEmpty ? (
        <p className="m-0 text-center text-sm text-(--silver)">
          Nothing found yet. Check your device is switched on and connected to
          your Wi‑Fi.
        </p>
      ) : (
        <ul
          aria-label="Devices found"
          className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4 sm:gap-4"
        >
          {props.shown.map((each, index) => {
            const key = foundKey(each);
            const device = Object.hasOwn(props.added, key)
              ? (props.devices.find(
                  (device) => device.id === props.added[key]!.id,
                ) ?? props.added[key])
              : undefined;
            return device ? (
              <DeviceCard key={key} tone="success" index={index}>
                <ReadyCardContent
                  device={device}
                  line={each.description}
                  done="Added"
                  isNew
                  work={props.work}
                />
              </DeviceCard>
            ) : (
              <FoundCard
                key={key}
                found={each}
                index={index}
                appName={props.appName(each.driver)}
                onWorkingChange={(isWorking) =>
                  props.onWorkingChange(key, isWorking)
                }
                onAdded={(device) => props.onAdded(key, device)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

// A device someone could add. Add sends at once what needs nothing asked;
// otherwise the card asks its driver's questions, and the answers go once,
// in the body of one request. Where adding asks once started, as a TV shows
// a code, the card asks each step in place, with Cancel beside its one
// primary action, and names the attempt from the first press, so closing
// the overlay ends it. The fields empty once it's added or the overlay
// closes.
function FoundCard(props: {
  found: FoundDevice;
  index: number;
  appName: string | null;
  onWorkingChange: (isWorking: boolean) => void;
  onAdded: (device: DeviceInfo) => void;
}) {
  const ids = useId();
  const { found } = props;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Refused>();
  const [failure, setFailure] = useState<string>();
  // What the press under way does: start, answer, ask again or stop.
  const [doing, setDoing] = useState<
    "adding" | "checking" | "asking" | "stopping" | null
  >(null);
  const request = useRef<{ what: NonNullable<typeof doing> } | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  // The attempt open from the first press until it ends.
  const attempt = useRef<string | null>(null);
  // An answer that arrives once the card is gone goes nowhere, and an
  // attempt still open ends with it.
  const isShown = useRef(true);
  const device = { driver: found.driver, key: found.key };
  const deviceRef = useRef(device);
  deviceRef.current = device;
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
  const isWorking = doing !== null || asking !== null;
  const onWorkingChange = useRef(props.onWorkingChange);
  onWorkingChange.current = props.onWorkingChange;
  useEffect(() => {
    onWorkingChange.current(isWorking);
    // A card that goes while working, as once added, isn't any more.
    return () => {
      if (isWorking) onWorkingChange.current(false);
    };
  }, [isWorking]);

  const now = useNow(asking !== null);
  // The attempt's time ran out: the core ended it.
  useEffect(() => {
    if (asking && doing !== "stopping" && now >= asking.until) {
      attempt.current = null;
      setAsking(null);
      setAnswers({});
      setFailure(endedWords("adding", "time", props.appName) ?? undefined);
    }
  }, [asking, doing, now, props.appName]);

  const answerTo = (id: string) =>
    Object.hasOwn(answers, id) ? answers[id]! : "";
  const asks = found.asks.length > 0;
  const complete = isComplete(found.asks, answers);
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
    // Only the initial fields stay on the card for someone to correct.
    if (asking || !("refused" in result)) setAnswers({});
    if ("added" in result) {
      props.onAdded(result.added);
    } else if ("refused" in result) {
      // A refusal of adding it at all is said under its card, in its words.
      const refusal = result.refused;
      if ("question" in refusal) {
        if (asking) setFailure(refusalWords(answered, refusal));
        else setRefused(refusal);
      } else {
        setFailure(found.refusals[refusal.refusal]);
      }
    } else if (isEnded(result)) {
      setFailure(
        endedWords("adding", result.ended, props.appName) ?? undefined,
      );
    }
  };

  const send = async (
    what: NonNullable<typeof doing>,
    path: "/api/devices/add" | "/api/devices/add/cancel",
    json: Record<string, unknown>,
    answered: readonly DeviceQuestion[],
  ) => {
    if (
      request.current &&
      (what !== "stopping" || request.current.what === "stopping")
    )
      return;
    // Cancel can overtake a step's reply. Only the latest request changes the card.
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
    } catch (error) {
      if (!stillCurrent()) return;
      if (attempt.current) {
        cancelQuietly("/api/devices/add/cancel", {
          ...device,
          attempt: attempt.current,
        });
      }
      attempt.current = null;
      setAsking(null);
      setFailure(addProblem(error, props.appName));
    } finally {
      if (stillCurrent()) {
        request.current = null;
        setDoing(null);
      }
    }
  };

  const add = () => {
    if (request.current) return;
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
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
    if (complete) add();
  };

  const cancel = () => {
    if (!asking) return;
    void send(
      "stopping",
      "/api/devices/add/cancel",
      { attempt: asking.attempt },
      asking.asks,
    );
  };

  const label = `Add ${found.name}`;
  const start = (
    <Button
      type={asks ? "submit" : "button"}
      className={asks ? "shrink-0" : "w-full"}
      disabled={doing !== null || (asks && !complete)}
      aria-label={label}
      onClick={asks ? undefined : add}
    >
      {doing === "adding" ? "Adding…" : "Add"}
    </Button>
  );
  const lasting = asking ? lastingOf(asking) : null;
  return (
    <DeviceCard index={props.index}>
      <CardRound>
        <TypeIcon type={found.type} />
      </CardRound>
      <span className="mt-3.5 text-[15.5px] font-semibold">{found.name}</span>
      {found.description && !asking && <CardLine>{found.description}</CardLine>}
      {asking ? (
        <form
          onSubmit={submit}
          className="mt-auto flex w-full flex-col gap-2 pt-3 text-start"
        >
          <AskingFields
            idPrefix={ids}
            asking={asking}
            answers={answers}
            now={now}
            narrow
            disabled={doing !== null}
            onChange={(question, value) =>
              setAnswers((before) => ({ ...before, [question]: value }))
            }
          />
          {/* Stacked where the card is narrow, the primary action on top. */}
          <div className="mt-1 flex flex-wrap-reverse gap-1.5">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={doing === "stopping"}
              onClick={cancel}
            >
              {doing === "stopping" ? "Stopping…" : "Cancel"}
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={
                doing !== null ||
                (!lastsUp && !isComplete(asking.asks, answers))
              }
            >
              {doing === "checking"
                ? "Checking…"
                : doing === "asking"
                  ? "Asking…"
                  : lastsUp && lasting?.lasts
                    ? lasting.lasts.again
                    : "Continue"}
            </Button>
          </div>
        </form>
      ) : asks ? (
        <form
          onSubmit={submit}
          className="mt-auto flex w-full flex-col gap-2 pt-3 text-start"
        >
          {found.asks.map((question, index) => (
            <QuestionField
              key={question.id}
              id={`${ids}-${question.id}`}
              question={question}
              value={answerTo(question.id)}
              refused={refused}
              narrow
              onChange={(value) =>
                setAnswers((before) => ({ ...before, [question.id]: value }))
              }
              beside={index === found.asks.length - 1 && start}
            />
          ))}
        </form>
      ) : (
        <CardFoot>{start}</CardFoot>
      )}
      {failure && (
        <p role="alert" className="m-0 mt-2 text-sm text-(--ruby-on-carbon)">
          {failure}
        </p>
      )}
    </DeviceCard>
  );
}
