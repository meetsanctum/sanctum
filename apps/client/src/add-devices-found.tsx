import type { AddResult, DeviceInfo, FoundDevice } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  CardFoot,
  CardLine,
  CardRound,
  DeviceCard,
  ReadyCard,
  TypeIcon,
  type CardWork,
} from "./add-devices-cards";
import { CoreError, coreJson } from "./core-fetch";
import { deviceProblem } from "./device-parts";
import { QuestionField, type Refused } from "./device-questions";

// Add devices' page of what drivers found, as on the home's network: a card
// for each, with Add, which asks in place what its driver needs, such as its
// key, a refused answer saying why under its field. A device added here
// stays, green, to be named and placed. While nothing is found, it says what
// to check.

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
      className={cn(
        "flex flex-col gap-6",
        isEmpty && "flex-1 justify-center pb-16",
      )}
    >
      {!isEmpty && (
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
              <ReadyCard
                key={key}
                device={device}
                line={each.description}
                done="Added"
                isNew
                work={props.work}
                index={index}
              />
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
      <p className="m-0 text-center text-sm text-(--silver)">
        {!isEmpty
          ? "Don't see yours? Check it's switched on and connected to your Wi‑Fi."
          : "Nothing found yet. Check your device is switched on and connected to your Wi‑Fi."}
      </p>
    </div>
  );
}

// A device someone could add. Add sends at once what needs nothing asked;
// otherwise the card asks its driver's questions, and the answers go once,
// in the body of one request. The fields empty once it's added or the
// overlay closes.
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
  const [working, setWorking] = useState(false);
  // An answer that arrives once the card is gone goes nowhere.
  const isShown = useRef(true);
  useEffect(() => {
    isShown.current = true;
    return () => {
      isShown.current = false;
    };
  }, []);

  const answerTo = (id: string) =>
    Object.hasOwn(answers, id) ? answers[id]! : "";
  const asks = found.asks.length > 0;
  const complete = found.asks.every((question) => answerTo(question.id) !== "");

  const add = async () => {
    if (working) return;
    setWorking(true);
    props.onWorkingChange(true);
    setRefused(undefined);
    setFailure(undefined);
    try {
      const result = await coreJson<AddResult>("/api/devices/add", {
        method: "POST",
        json: {
          driver: found.driver,
          key: found.key,
          answers: Object.fromEntries(
            found.asks.map((question) => [question.id, answerTo(question.id)]),
          ),
        },
      });
      if (!isShown.current) return;
      if ("refused" in result) {
        // A refusal of adding it at all is said under its card, in its words.
        const refused = result.refused;
        if ("question" in refused) setRefused(refused);
        else setFailure(found.refusals[refused.refusal]);
        return;
      }
      setAnswers({});
      props.onAdded(result.added);
    } catch (error) {
      if (!isShown.current) return;
      setFailure(addProblem(error, props.appName));
    } finally {
      if (isShown.current) {
        setWorking(false);
        props.onWorkingChange(false);
      }
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete) void add();
  };

  const label = `Add ${found.name}`;
  const send = (
    <Button
      type={asks ? "submit" : "button"}
      className={asks ? "shrink-0" : "w-full"}
      disabled={working || (asks && !complete)}
      aria-label={label}
      onClick={asks ? undefined : () => void add()}
    >
      {working ? "Adding…" : "Add"}
    </Button>
  );
  return (
    <DeviceCard index={props.index}>
      <CardRound>
        <TypeIcon type={found.type} />
      </CardRound>
      <span className="mt-3.5 text-[15.5px] font-semibold">{found.name}</span>
      {found.description && <CardLine>{found.description}</CardLine>}
      {asks ? (
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
              beside={index === found.asks.length - 1 && send}
            />
          ))}
        </form>
      ) : (
        <CardFoot>{send}</CardFoot>
      )}
      {failure && (
        <p role="alert" className="m-0 mt-2 text-sm text-(--ruby-on-carbon)">
          {failure}
        </p>
      )}
    </DeviceCard>
  );
}
