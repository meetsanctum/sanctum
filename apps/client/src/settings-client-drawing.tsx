import type {
  ClientInfo,
  DrawingChoice,
  SetClientDrawing,
} from "@meetsanctum/auth-protocol";
import { Button, SegmentedControl } from "@meetsanctum/ui-sdk";
import { useEffect, useId, useRef, useState } from "react";

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

// What a choice means on this client, Automatic by what it said it draws
// with: why it is on now, or where it would turn on.
function effectsHint(client: ClientInfo, choice: DrawingChoice) {
  const { name, drawn } = client;
  if (choice === "on") return `Always drawn plainly on ${name}.`;
  if (choice === "off") return `Every effect, even where ${name} feels slow.`;
  if (!drawn) {
    return `On where ${name} is known to be slow or asks for reduced transparency.`;
  }
  if (drawn.effects === "regular") {
    return `Off now. It turns on where ${name} asks for reduced transparency.`;
  }
  return drawn.slowDevice
    ? `On now, since ${name} is known to be slow.`
    : `On now, since ${name} asks for reduced transparency.`;
}

function motionHint(client: ClientInfo, choice: DrawingChoice) {
  const { name, drawn } = client;
  if (choice === "on") return `Nothing moves on ${name}.`;
  if (choice === "off")
    return `Every movement, even where ${name} asks for less.`;
  if (!drawn) {
    return `On where ${name} is known to be slow or asks for reduced motion.`;
  }
  if (drawn.motion === "regular") {
    return `Off now. It turns on where ${name} asks for reduced motion.`;
  }
  return drawn.slowDevice
    ? `On now, since ${name} is known to be slow.`
    : `On now, since ${name} asks for reduced motion.`;
}

export function ClientDrawing(props: {
  /** The client whose drawing is open, as Clients last read it. */
  client?: ClientInfo;
  onClose: () => void;
  onChanged: () => void;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<ClientInfo>(undefined);
  if (props.client) last.current = props.client;
  const client = last.current;
  const openId = props.client?.id;
  const [effects, setEffects] = useState<DrawingChoice>("automatic");
  const [motion, setMotion] = useState<DrawingChoice>("automatic");
  // Reduce motion turned on with Reduce effects, until it is chosen itself.
  const [isLinked, setLinked] = useState(false);
  const [problem, setProblem] = useState<string>();
  const id = useId();

  // Each opening starts from the client's choices, read as it opens: a
  // later read of Clients changes only what Automatic says now.
  const opening = useRef(props.client);
  opening.current = props.client;
  useEffect(() => {
    const opened = opening.current;
    if (!openId || !opened) return;
    setEffects(opened.reduceEffects);
    setMotion(opened.reduceMotion);
    setLinked(false);
    setProblem(undefined);
  }, [openId]);

  const save = (change: Omit<SetClientDrawing, "id">, undo: () => void) => {
    if (!client) return;
    setProblem(undefined);
    coreJson<ClientInfo>("/api/auth/clients/drawing", {
      method: "POST",
      json: { id: client.id, ...change } satisfies SetClientDrawing,
    })
      .then(props.onChanged)
      .catch(() => {
        undo();
        setProblem("That did not work. Try again.");
      });
  };

  const chooseEffects = (next: DrawingChoice) => {
    const before = { effects, motion, isLinked };
    const turnsMotionOn = next === "on" && motion !== "on";
    setEffects(next);
    if (turnsMotionOn) setMotion("on");
    setLinked(next === "on" && (turnsMotionOn || isLinked));
    save(
      { reduceEffects: next, ...(turnsMotionOn && { reduceMotion: "on" }) },
      () => {
        setEffects(before.effects);
        setMotion(before.motion);
        setLinked(before.isLinked);
      },
    );
  };

  const chooseMotion = (next: DrawingChoice) => {
    const before = { motion, isLinked };
    setMotion(next);
    setLinked(false);
    save({ reduceMotion: next }, () => {
      setMotion(before.motion);
      setLinked(before.isLinked);
    });
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
          <div className="flex flex-col gap-5">
            <Group
              id={`${id}-effects`}
              title="Reduce effects"
              about="Without blur, fades or shadows, for a device that feels slow."
              value={effects}
              onChange={chooseEffects}
              hint={effectsHint(client, effects)}
            />
            <Group
              id={`${id}-motion`}
              title="Reduce motion"
              about="Things appear and change in place, without sliding, zooming or flying in."
              value={motion}
              onChange={chooseMotion}
              hint={
                isLinked
                  ? "On with Reduce effects. You can turn it off on its own."
                  : motionHint(client, motion)
              }
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

// One setting: its name, what it does, its three choices and what the
// chosen one means here.
function Group(props: {
  id: string;
  title: string;
  about: string;
  value: DrawingChoice;
  onChange: (value: DrawingChoice) => void;
  hint: string;
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
        describedBy={`${props.id}-about ${props.id}-hint`}
        options={options}
        value={props.value}
        onValueChange={props.onChange}
        className="self-start"
      />
      <span id={`${props.id}-hint`} aria-live="polite" className={label}>
        {props.hint}
      </span>
    </div>
  );
}
