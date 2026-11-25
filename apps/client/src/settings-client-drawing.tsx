import type {
  ClientInfo,
  DrawingChoice,
  SetClientDrawing,
} from "@meetsanctum/auth-protocol";
import { Button, SegmentedControl } from "@meetsanctum/ui-sdk";
import { Gauge } from "lucide-react";
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
// its current choices: a status under its choices, and nothing otherwise.
// The device's own reduced transparency or reduced motion is its
// accessibility settings' doing.
function onNow(
  client: ClientInfo,
  choice: DrawingChoice,
  part: "effects" | "motion",
) {
  const { drawn } = client;
  if (choice !== "automatic" || drawn?.[part] !== "reduced") return null;
  if (drawn.slowDevice) return "On, low performance detected";
  const whose = client.current ? "this device's" : `${client.name}'s`;
  return `On, by ${whose} accessibility settings`;
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
// why Automatic has it on now.
function Group(props: {
  id: string;
  title: string;
  about: string;
  value: DrawingChoice;
  onChange: (value: DrawingChoice) => void;
  status: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-col gap-0.5">
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
      {/* A status, in green with the menu item's symbol. */}
      {props.status && (
        <span
          id={`${props.id}-status`}
          className="flex w-fit max-w-full items-start gap-1.5 rounded-sm bg-green/6 px-2 py-1 text-[13px] leading-[18px] font-medium text-green dark:bg-green/12"
        >
          <Gauge
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0"
            strokeWidth={2.25}
          />
          {props.status}
        </span>
      )}
    </div>
  );
}
