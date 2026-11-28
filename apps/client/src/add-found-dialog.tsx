import type {
  DeviceInfo,
  DeviceType,
  FoundDevice,
  Room,
} from "@meetsanctum/app-sdk";
import { Button, Input, Problem, SegmentedControl } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { BlinkButton } from "./add-devices-cards";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { AskingFields, isComplete } from "./device-asking";
import { deviceGroupOf, deviceGroupTitle } from "./device-groups";
import { problemReason, RoomPicker, showAsOf } from "./device-parts";
import { QuestionField } from "./device-questions";
import { useFoundAdding } from "./found-adding";

// Adding a device found on the home's network from Settings → Devices: one
// dialog from Add to Done, opened by the press itself, so nothing opens on
// its own later. It asks what the device's app asks first, adds it, asks
// each step adding asks once started (a TV's codes), then names and places
// the device where it ended up. Short segments at the top fill as it goes;
// how many is planned from what its app declares, and never shrinks. Until
// the device is in, Cancel and Escape end the attempt and a click beside
// the dialog does nothing, so a pairing never ends by accident; once it's
// in, what is shown is saved as it changes, and Done, × and Escape close.

export type AddFoundWork = {
  rooms: readonly Room[];
  // The home's devices, live, so the one added shows its latest.
  devices: readonly DeviceInfo[];
  appName: (driver: string) => string | null;
  onAdded: (device: DeviceInfo) => void;
  // Answers whether it was saved.
  onSave: (
    device: DeviceInfo,
    changes: {
      name?: string | null;
      roomId?: string | null;
      shownAs?: DeviceType | null;
    },
  ) => Promise<boolean>;
  // Makes a room of this name, answering it.
  onAddRoom: (name: string) => Promise<Room>;
};

export function AddFoundDialog(props: {
  found: FoundDevice | undefined;
  work: AddFoundWork;
  onClose: () => void;
  // Where focus goes once it closes, as the row it opened from is gone.
  onCloseFocus: () => void;
}) {
  const { found } = props;
  return (
    <Dialog
      open={!!found}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {found && (
        <AddFlow
          key={`${found.driver}\u0000${found.key}`}
          found={found}
          work={props.work}
          onClose={props.onClose}
          onCloseFocus={props.onCloseFocus}
        />
      )}
    </Dialog>
  );
}

function AddFlow(props: {
  found: FoundDevice;
  work: AddFoundWork;
  onClose: () => void;
  onCloseFocus: () => void;
}) {
  const ids = useId();
  const { found, work } = props;
  const appName = work.appName(found.driver);
  const [addedId, setAddedId] = useState<string>();
  const [justAdded, setJustAdded] = useState<DeviceInfo>();
  const adding = useFoundAdding(found, appName, (device) => {
    setAddedId(device.id);
    setJustAdded(device);
    work.onAdded(device);
  });
  const { asking, doing, failure } = adding;
  const device = addedId
    ? (work.devices.find((each) => each.id === addedId) ?? justAdded)
    : undefined;
  const asksFirst = found.asks.length > 0;

  // A device that asks nothing first is added from the press that opened
  // it, once the dialog is really there: a mount React tries out and drops
  // would otherwise start an attempt and cancel it as it goes.
  const add = useRef(adding.add);
  add.current = adding.add;
  useEffect(() => {
    if (asksFirst) return;
    const timer = window.setTimeout(() => add.current(), 0);
    return () => window.clearTimeout(timer);
  }, [asksFirst]);

  // One segment for what it asks first, or for adding where it asks
  // nothing, and one to name it. An app declares what adding may ask once
  // started for all its devices, not each, so those steps are planned once
  // this device's app asks the first of them, as a TV shows its first code.
  const asksLater = useRef(false);
  if (asking?.asks.some((question) => found.later.includes(question.id)))
    asksLater.current = true;
  const asksAhead = Math.max(
    1,
    (asksFirst ? 1 : 0) + (asksLater.current ? found.later.length : 0),
  );
  const reached = device
    ? asksAhead + 1
    : asking
      ? (asksFirst ? 1 : 0) +
        1 +
        Math.max(
          0,
          ...asking.asks.map((question) => found.later.indexOf(question.id)),
        )
      : 1;
  // A step its app didn't plan for adds a segment; none ever empties.
  const most = useRef(asksAhead + 1);
  most.current = Math.max(
    most.current,
    reached + (device ? 0 : 1),
    asksAhead + 1,
  );
  const total = most.current;
  const shown = device ? total : Math.min(reached, total - 1);

  const groupTitle = device ? deviceGroupTitle(deviceGroupOf(device)) : null;
  const title = device ? `Added to ${groupTitle}` : `Add ${found.name}`;
  const description = device
    ? "Name it and choose its room."
    : failure
      ? null
      : asking || asksFirst
        ? found.description
        : "This takes a few seconds.";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (device) props.onClose();
    else if (failure && failure.retry && !asksFirst) adding.add();
    else adding.submit();
  };

  const lastsUp = adding.lastsUp;
  const primary = device
    ? { label: "Done", disabled: false }
    : asking
      ? {
          label:
            doing === "checking"
              ? "Checking…"
              : doing === "asking"
                ? "Asking…"
                : lastsUp && adding.lasting?.lasts
                  ? adding.lasting.lasts.again
                  : "Continue",
          disabled:
            doing !== null ||
            (!lastsUp && !isComplete(asking.asks, adding.answers)),
        }
      : failure
        ? failure.retry
          ? {
              label: failure.retry === "add" ? "Add again" : "Try again",
              disabled: asksFirst && !adding.complete,
            }
          : null
        : {
            label: doing === "adding" ? "Adding…" : "Add",
            disabled: asksFirst && !adding.complete,
            busy: doing !== null,
          };

  return (
    <DialogContent
      showCloseButton={!!device}
      aria-describedby={`${ids}-step ${ids}-description`}
      onInteractOutside={(event) => {
        if (!device) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        props.onCloseFocus();
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <StepSegments total={total} reached={shown} id={`${ids}-step`} />
        <DialogHeader>
          <DialogTitle>
            {title}
            {/* What it is, so a device named after a room isn't heard as
                one, where the line under the title doesn't say it already. */}
            {!device &&
              found.description &&
              description !== found.description && (
                <span className="sr-only">{`, ${found.description}`}</span>
              )}
          </DialogTitle>
          {description && (
            <DialogDescription id={`${ids}-description`}>
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {device ? (
          <Placing device={device} work={work} />
        ) : asking ? (
          <AskingFields
            idPrefix={ids}
            asking={asking}
            answers={adding.answers}
            now={adding.now}
            disabled={doing !== null}
            onChange={adding.setAnswer}
          />
        ) : (
          asksFirst &&
          found.asks.map((question, index) => (
            <QuestionField
              key={question.id}
              id={`${ids}-${question.id}`}
              question={question}
              value={adding.answerTo(question.id)}
              refused={adding.refused}
              autoFocus={index === 0}
              disabled={doing !== null}
              onChange={(value) => adding.setAnswer(question.id, value)}
            />
          ))
        )}
        {failure && (
          <Problem
            title={
              failure.stopping
                ? `Couldn't stop adding ${found.name}`
                : `Couldn't add ${found.name}`
            }
          >
            {failure.reason}
          </Problem>
        )}
        <DialogFooter>
          {!device && (
            <Button
              type="button"
              variant="outline"
              disabled={doing === "stopping"}
              onClick={props.onClose}
            >
              {doing === "stopping" ? "Stopping…" : "Cancel"}
            </Button>
          )}
          {primary && (
            <Button
              type="submit"
              disabled={primary.disabled}
              // Busy, it keeps focus, so Try again has it if adding fails.
              aria-disabled={
                "busy" in primary && primary.busy ? true : undefined
              }
              className={cn(
                "busy" in primary && primary.busy && "pointer-events-none",
              )}
            >
              {primary.label}
            </Button>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

// How far adding has come: short segments centred at the top, filled up to
// the step on show, in the ink, since nothing on them can be pressed. They
// change in place, never moving. A screen reader hears the step with the
// dialog's description instead.
function StepSegments(props: { total: number; reached: number; id: string }) {
  return (
    <>
      <div
        aria-hidden="true"
        data-slot="step-segments"
        className="-mt-2.5 mb-2 flex justify-center gap-1.5"
      >
        {Array.from({ length: props.total }, (_, index) => (
          <span
            key={index}
            data-reached={index < props.reached ? "" : undefined}
            className={cn(
              "h-1 w-10 rounded-full",
              index < props.reached ? "bg-foreground" : "bg-foreground/50",
            )}
          />
        ))}
      </div>
      <span id={props.id} className="sr-only">
        {`Step ${props.reached} of ${props.total}`}
      </span>
    </>
  );
}

// The device just added, named and placed: its name saved when someone
// leaves the field, what it's shown as and its room as they're chosen, with
// New room… at the end of the room's menu, and Blink where it can.
function Placing(props: { device: DeviceInfo; work: AddFoundWork }) {
  const { device, work } = props;
  const ids = useId();
  const [madeRooms, setMadeRooms] = useState<Room[]>([]);
  const [naming, setNaming] = useState(false);
  const [problem, setProblem] = useState<string>();
  const rooms = [
    ...work.rooms,
    ...madeRooms.filter(
      (made) => !work.rooms.some((room) => room.id === made.id),
    ),
  ];
  const save = async (changes: Parameters<AddFoundWork["onSave"]>[1]) => {
    setProblem(undefined);
    const saved = await work.onSave(device, changes);
    if (!saved) setProblem(`${device.name}'s changes weren't saved`);
    return saved;
  };
  const showAs = showAsOf(device);

  return (
    <div className="flex flex-col gap-4">
      <NameField
        id={`${ids}-name`}
        device={device}
        onSave={(name) => void save({ name })}
      />
      {showAs && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium" id={`${ids}-show-as`}>
            Show as
          </span>
          <SegmentedControl
            fill
            label={`${device.name}: show as`}
            options={showAs.options.map((option) => ({
              value: option.id,
              label: option.title,
            }))}
            value={showAs.current}
            wraps
            onValueChange={(value) =>
              void save({ shownAs: showAs.choice(value) })
            }
          />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Room</span>
        {naming ? (
          <NewRoom
            onCancel={() => setNaming(false)}
            onAdd={async (name) => {
              const room = await work.onAddRoom(name);
              setMadeRooms((before) => [...before, room]);
              const moved = await save({ roomId: room.id });
              if (moved) setNaming(false);
              return moved;
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <RoomPicker
              device={device}
              rooms={rooms}
              onChange={(roomId) => void save({ roomId })}
              onNewRoom={() => setNaming(true)}
            />
            {device.identify && <BlinkButton device={device} />}
          </div>
        )}
      </div>
      {problem && <Problem title={problem}>Try again in a moment.</Problem>}
    </div>
  );
}

function NameField(props: {
  id: string;
  device: DeviceInfo;
  onSave: (name: string | null) => void;
}) {
  const { device } = props;
  const [draft, setDraft] = useState(device.name);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setDraft(device.name);
  }, [device.name, typing]);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-[13px] font-medium">
        Name
      </label>
      <Input
        id={props.id}
        value={draft}
        maxLength={120}
        autoFocus
        onFocus={() => setTyping(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setTyping(false);
          const name = draft.trim();
          if (name !== device.name) props.onSave(name || null);
          if (!name) setDraft(device.name);
        }}
        onKeyDown={(event) => {
          // Enter saves the name, rather than closing the dialog.
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

// A room made right here: its name, then Add room puts the device in it.
// Cancel or Escape goes back to the room's menu.
function NewRoom(props: {
  onCancel: () => void;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<{ room: string; reason: string }>();
  useLayoutEffect(() => field.current?.focus(), []);
  const add = async () => {
    const wanted = name.trim();
    if (!wanted || working) return;
    setWorking(true);
    setProblem(undefined);
    try {
      await props.onAdd(wanted);
    } catch (error) {
      setProblem({ room: wanted, reason: problemReason(error) });
    } finally {
      setWorking(false);
    }
  };
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <label htmlFor={id} className="sr-only">
        New room
      </label>
      <Input
        id={id}
        ref={field}
        value={name}
        placeholder="New room"
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void add();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={working || !name.trim()}
          onClick={() => void add()}
        >
          {working ? "Adding…" : "Add room"}
        </Button>
      </div>
      {problem && (
        <Problem title={`Couldn't add ${problem.room}`}>
          {problem.reason}
        </Problem>
      )}
    </div>
  );
}
