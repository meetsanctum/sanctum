import type { DeviceInfo, FoundDevice } from "@meetsanctum/app-sdk";
import { Button, Problem } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { useEffect, useId, useRef, type FormEvent } from "react";

import {
  CardFoot,
  CardLine,
  CardRound,
  DeviceCard,
  ReadyCardContent,
  TypeIcon,
  type CardWork,
} from "./add-devices-cards";
import { AskingFields, isComplete } from "./device-asking";
import { QuestionField } from "./device-questions";
import { useFoundAdding } from "./found-adding";

// Add devices' page of what drivers found, as on the home's network: a card
// for each, with Add, which asks in place what its driver needs, such as its
// key, a refused answer saying why under its field. A device added here
// stays, green, to be named and placed. While nothing is found, it says what
// to check; once something is, the overlay's footer asks after the rest.

export const foundKey = (found: { driver: string; key: string }) =>
  `${found.driver}\u0000${found.key}`;

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
  const {
    answers,
    answerTo,
    setAnswer,
    refused,
    failure,
    doing,
    asking,
    now,
    lastsUp,
    lasting,
    complete,
    isWorking,
    add,
    submit: send,
    cancel,
  } = useFoundAdding(found, props.appName, props.onAdded);
  const onWorkingChange = useRef(props.onWorkingChange);
  onWorkingChange.current = props.onWorkingChange;
  useEffect(() => {
    onWorkingChange.current(isWorking);
    // A card that goes while working, as once added, isn't any more.
    return () => {
      if (isWorking) onWorkingChange.current(false);
    };
  }, [isWorking]);

  const asks = found.asks.length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
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
            onChange={setAnswer}
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
              onChange={(value) => setAnswer(question.id, value)}
              beside={index === found.asks.length - 1 && start}
            />
          ))}
        </form>
      ) : (
        <CardFoot>{start}</CardFoot>
      )}
      {failure && (
        <Problem
          title={
            failure.stopping
              ? `Couldn't stop adding ${found.name}`
              : `Couldn't add ${found.name}`
          }
          className="mt-2"
        >
          {failure.reason}
        </Problem>
      )}
    </DeviceCard>
  );
}
