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
  type RefObject,
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
// the total follows the driver's plan when it has one. Cancel and Escape
// check whether adding stopped or finished. Once added, Done, × and
// Escape save any focused name edit and close.

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
    found && (
      <AddFlow
        key={`${found.driver}\u0000${found.key}`}
        found={found}
        work={props.work}
        onClose={props.onClose}
        onCloseFocus={props.onCloseFocus}
      />
    )
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
  const [namingRoom, setNamingRoom] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
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

  // A driver can declare a fixed sequence of single-question steps. Retrying
  // a code within that sequence leaves it on the same segment.
  const plan = found.addLaterInOrder ? found.later : undefined;
  const step =
    asking?.asks.length === 1 ? (plan?.indexOf(asking.asks[0]!.id) ?? -1) : -1;
  const prompts = useRef<number | null>(found.later?.length === 0 ? 0 : null);
  if (asking) prompts.current = step < 0 ? null : (plan?.length ?? null);
  const first = asksFirst ? 1 : 0;
  const total =
    prompts.current === null ? null : Math.max(1, first + prompts.current) + 1;
  const reached = device ? (total ?? 1) : Math.max(1, first + step + 1);

  const groupTitle = device ? deviceGroupTitle(deviceGroupOf(device)) : null;
  const title = device ? `Added to ${groupTitle}` : `Add ${found.name}`;
  const description = device
    ? "Name it and choose its room."
    : failure
      ? null
      : asking || asksFirst
        ? found.description
        : "This takes a few seconds.";

  const close = async () => {
    if (device) {
      nameInput.current?.blur();
      props.onClose();
    } else if (await adding.cancel()) {
      props.onClose();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (device) void close();
    else if (failure && failure.retry && !asksFirst) adding.add();
    else adding.submit();
  };

  const lastsUp = adding.lastsUp;
  const primary = device
    ? { label: "Done", disabled: false }
    : asking && !failure?.stopping
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

  const content = (
    <DialogContent
      showCloseButton={!!device}
      aria-describedby={`${ids}-step ${ids}-description`}
      onEscapeKeyDown={(event) => {
        if (namingRoom) {
          event.preventDefault();
          setNamingRoom(false);
        }
      }}
      onInteractOutside={(event) => {
        if (!device) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        props.onCloseFocus();
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <StepSegments
          total={total}
          reached={reached}
          status={
            device
              ? "Adding complete"
              : asking
                ? "Pairing in progress"
                : doing === "adding"
                  ? "Adding in progress"
                  : undefined
          }
          id={`${ids}-step`}
        />
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
          <Placing
            device={device}
            work={work}
            nameInput={nameInput}
            namingRoom={namingRoom}
            setNamingRoom={setNamingRoom}
          />
        ) : asking ? (
          <AskingFields
            idPrefix={ids}
            asking={asking}
            answers={adding.answers}
            now={adding.now}
            disabled={doing !== null || failure?.stopping}
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
              onClick={() => void close()}
            >
              {doing === "stopping" ? "Stopping…" : "Cancel"}
            </Button>
          )}
          {primary && (
            <Button
              type="submit"
              disabled={primary.disabled}
              // Busy, it keeps focus, so Try again has it if adding fails.
              aria-busy={"busy" in primary && primary.busy ? true : undefined}
              aria-disabled={
                "busy" in primary && primary.busy ? true : undefined
              }
            >
              {primary.label}
            </Button>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      {content}
    </Dialog>
  );
}

// How far adding has come: short segments centred at the top, filled up to
// the step on show, in the ink, since nothing on them can be pressed. They
// change in place, never moving. A screen reader hears the step with the
// dialog's description instead.
function StepSegments(props: {
  total: number | null;
  reached: number;
  status?: string;
  id: string;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        data-slot="step-segments"
        className="-mt-2.5 mb-2 flex justify-center gap-1.5"
      >
        {Array.from({ length: props.total ?? 1 }, (_, index) => (
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
        {props.total === null
          ? props.status
          : `Step ${props.reached} of ${props.total}`}
      </span>
    </>
  );
}

// The device just added, named and placed: its name saved when someone
// leaves the field, what it's shown as and its room as they're chosen, with
// New room… at the end of the room's menu, and Blink where it can.
function Placing(props: {
  device: DeviceInfo;
  work: AddFoundWork;
  nameInput: RefObject<HTMLInputElement | null>;
  namingRoom: boolean;
  setNamingRoom: (naming: boolean) => void;
}) {
  const { device, work, namingRoom, setNamingRoom } = props;
  const ids = useId();
  const [madeRooms, setMadeRooms] = useState<Room[]>([]);
  const [problem, setProblem] = useState<string>();
  const roomTrigger = useRef<HTMLButtonElement>(null);
  const namedRoom = useRef(false);
  useLayoutEffect(() => {
    if (!namingRoom && namedRoom.current) roomTrigger.current?.focus();
    namedRoom.current = namingRoom;
  }, [namingRoom]);
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
        input={props.nameInput}
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
        {namingRoom ? (
          <NewRoom
            onClose={() => setNamingRoom(false)}
            onAdd={async (name) => {
              const room = await work.onAddRoom(name);
              setMadeRooms((before) => [...before, room]);
              return room;
            }}
            onMove={(roomId) => save({ roomId })}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <RoomPicker
              triggerRef={roomTrigger}
              device={device}
              rooms={rooms}
              onChange={(roomId) => void save({ roomId })}
              onNewRoom={() => setNamingRoom(true)}
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
  input: RefObject<HTMLInputElement | null>;
  onSave: (name: string | null) => void;
}) {
  const { device } = props;
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-[13px] font-medium">
        Name
      </label>
      <Input
        id={props.id}
        ref={props.input}
        value={draft ?? device.name}
        maxLength={120}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft === null) return;
          setDraft(null);
          const name = draft.trim();
          if (name !== device.name) props.onSave(name || null);
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
  onClose: () => void;
  onAdd: (name: string) => Promise<Room>;
  onMove: (roomId: string) => Promise<boolean>;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<{ room: string; reason: string }>();
  const open = useRef(false);
  const made = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    open.current = true;
    field.current?.focus();
    return () => {
      open.current = false;
    };
  }, []);
  const close = () => {
    open.current = false;
    props.onClose();
  };
  const add = async () => {
    const wanted = name.trim();
    if (!wanted || working) return;
    setWorking(true);
    setProblem(undefined);
    try {
      const roomId = made.current.get(wanted) ?? (await props.onAdd(wanted)).id;
      if (!open.current) return;
      made.current.set(wanted, roomId);
      const moved = await props.onMove(roomId);
      if (open.current && moved) close();
    } catch (error) {
      if (open.current)
        setProblem({ room: wanted, reason: problemReason(error) });
    } finally {
      if (open.current) setWorking(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
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
        <Button type="button" variant="outline" size="sm" onClick={close}>
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
