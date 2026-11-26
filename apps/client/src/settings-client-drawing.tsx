import type {
  ClientInfo,
  DrawingChoice,
  SetClientDrawing,
} from "@meetsanctum/auth-protocol";
import { Button, SegmentedControl } from "@meetsanctum/ui-sdk";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { coreJson } from "./core-fetch";

// Settings → Clients → a client's Effects and motion: Reduce effects and
// Reduce motion for that client, each Automatic, On or Off, applied as
// chosen. Any client sets any client's, as with its name. Choosing On for
// Reduce effects turns Reduce motion on with it, in sight, and Reduce motion
// keeps its own choice from then on: turning it off leaves Reduce effects
// on, and turning Reduce effects off leaves it as it is.

const options = [
  { value: "automatic", label: "Automatic" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const satisfies { value: DrawingChoice; label: string }[];

const label = "text-[13px] leading-[18px] font-medium text-muted-foreground";

/** What a client's row says it draws with, where something is reduced. */
export function drawnText(client: ClientInfo) {
  const effects = client.drawn?.effects === "reduced";
  const motion = client.drawn?.motion === "reduced";
  if (effects && motion) return "Reduced effects and motion";
  if (effects) return "Reduced effects";
  if (motion) return "Reduced motion";
  return null;
}

// Why Automatic has one on now, by what the client said it draws with under
// its current choices: the reason in a status under its choices, after On,
// and nothing otherwise.
// The device's own reduced transparency or reduced motion is its
// accessibility settings' doing.
function onNow(
  client: ClientInfo,
  choice: DrawingChoice,
  part: "effects" | "motion",
) {
  const { drawn } = client;
  const saved = part === "effects" ? client.reduceEffects : client.reduceMotion;
  if (
    choice !== "automatic" ||
    saved !== "automatic" ||
    drawn?.[part] !== "reduced"
  ) {
    return null;
  }
  if (drawn.slowDevice) return "Low performance detected";
  const whose = client.current ? "This device's" : `${client.name}'s`;
  return `${whose} accessibility settings`;
}

type DrawingChange = Omit<SetClientDrawing, "id">;

export function ClientDrawing(props: {
  /** The client whose drawing is open, as Clients last read it. */
  client?: ClientInfo;
  onClose: () => void;
  onChanged: (saved: ClientInfo) => void;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<ClientInfo>(undefined);
  if (props.client) last.current = props.client;
  const client = last.current;
  const openId = props.client?.id;
  const opening = useRef<object>(undefined);
  const saving = useRef(false);
  const [pending, setPending] = useState<{
    opening: object;
    change: DrawingChange;
  }>();
  const [problem, setProblem] = useState<string>();
  const id = useId();

  useLayoutEffect(() => {
    if (!openId) return;
    opening.current = {};
    setProblem(undefined);
    return () => {
      opening.current = undefined;
    };
  }, [openId]);

  const draft = pending?.opening === opening.current ? pending : undefined;
  const effects =
    draft?.change.reduceEffects ?? client?.reduceEffects ?? "automatic";
  const motion =
    draft?.change.reduceMotion ?? client?.reduceMotion ?? "automatic";

  // One save at a time, so they reach the core in order; a pick while one
  // is on its way is let go. The choices stay enabled, so focus stays.
  const save = async (change: DrawingChange) => {
    const opened = opening.current;
    if (!openId || !opened || saving.current) return;
    saving.current = true;
    setPending({ opening: opened, change });
    setProblem(undefined);
    try {
      const saved = await coreJson<ClientInfo>("/api/auth/clients/drawing", {
        method: "POST",
        json: { id: openId, ...change } satisfies SetClientDrawing,
      });
      props.onChanged(saved);
    } catch {
      if (opening.current === opened) {
        setProblem("That did not work. Try again.");
      }
    } finally {
      saving.current = false;
      setPending(undefined);
    }
  };

  const chooseEffects = (next: DrawingChoice) => {
    const turnsMotionOn = next === "on" && motion !== "on";
    void save({
      reduceEffects: next,
      ...(turnsMotionOn && { reduceMotion: "on" }),
    });
  };

  const chooseMotion = (next: DrawingChoice) => {
    void save({ reduceMotion: next });
  };

  return (
    <Dialog
      open={!!props.client}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Effects and motion</DialogTitle>
          <DialogDescription>
            How {productName} is drawn on {client?.name}. Everything works the
            same either way.
          </DialogDescription>
        </DialogHeader>
        {client && (
          <div className="flex flex-col gap-7">
            <Group
              id={`${id}-effects`}
              title="Reduce effects"
              about="Without blur, fades or shadows, for a device that feels slow."
              value={effects}
              onChange={chooseEffects}
              status={onNow(client, effects, "effects")}
            />
            <Group
              id={`${id}-motion`}
              title="Reduce motion"
              about="Things appear and change in place, without sliding, zooming or flying in."
              value={motion}
              onChange={chooseMotion}
              status={onNow(client, motion, "motion")}
            />
          </div>
        )}
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button type="button" onClick={props.onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One setting: its name, what it does, its three choices, and under them
// why Automatic has it on now: a badge of two segments, On and the reason,
// which a screen reader hears after a comma.
function Group(props: {
  id: string;
  title: string;
  about: string;
  value: DrawingChoice;
  onChange: (value: DrawingChoice) => void;
  status: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-2 flex flex-col gap-0.5">
        <span id={`${props.id}-label`} className="text-sm font-medium">
          {props.title}
        </span>
        <span id={`${props.id}-about`} className={label}>
          {props.about}
        </span>
      </div>
      <SegmentedControl
        labelledBy={`${props.id}-label`}
        describedBy={
          props.status
            ? `${props.id}-about ${props.id}-status`
            : `${props.id}-about`
        }
        options={options}
        value={props.value}
        onValueChange={props.onChange}
        className="self-start"
      />
      <div
        id={`${props.id}-status`}
        aria-live="polite"
        aria-atomic="true"
        className="flex flex-col"
      >
        {props.status && (
          <span className="mt-2 flex w-fit max-w-full gap-px text-[13px] leading-[18px] font-medium">
            <span className="shrink-0 rounded-l-sm bg-foreground/5 px-2 py-1 text-green dark:bg-foreground/8">
              On<span className="sr-only">, </span>
            </span>
            <span className="rounded-r-sm bg-foreground/5 px-2 py-1 text-muted-foreground dark:bg-foreground/8">
              {props.status}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
