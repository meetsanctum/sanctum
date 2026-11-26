import type { ClientInfo, SetClientDrawing } from "@meetsanctum/auth-protocol";
import { Button, Switch } from "@meetsanctum/ui-sdk";
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
// Reduce motion for that client, each a switch of its own, applied as set.
// Any client sets any client's, as with its name.

const label = "text-[13px] leading-[18px] font-medium text-muted-foreground";

/** What a client's row says it draws with, where something is reduced. */
export function drawnText(client: ClientInfo) {
  if (client.reduceEffects && client.reduceMotion) {
    return "Reduced effects and motion";
  }
  if (client.reduceEffects) return "Reduced effects";
  if (client.reduceMotion) return "Reduced motion";
  return null;
}

type DrawingChange = Omit<SetClientDrawing, "id">;

export function ClientDrawing(props: {
  /** The client whose drawing is open, as Clients last read it. */
  client?: ClientInfo;
  onClose: () => void;
  /** Reads the clients again once a change is saved. */
  onChanged: (saved: SetClientDrawing) => Promise<void>;
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
  const effects = draft?.change.reduceEffects ?? client?.reduceEffects ?? false;
  const motion = draft?.change.reduceMotion ?? client?.reduceMotion ?? false;

  // One save at a time, so they reach the core in order; a press while one
  // is on its way is let go. The switches stay enabled, so focus stays.
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
      // Clients read afresh, since a read that ended while this was on its
      // way can already hold a newer change from another client.
      await props.onChanged({
        id: saved.id,
        reduceEffects:
          change.reduceEffects === undefined ? undefined : saved.reduceEffects,
        reduceMotion:
          change.reduceMotion === undefined ? undefined : saved.reduceMotion,
      });
    } catch {
      if (opening.current === opened) {
        setProblem("That did not work. Try again.");
      }
    } finally {
      saving.current = false;
      setPending(undefined);
    }
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
            <Setting
              id={`${id}-effects`}
              title="Reduce effects"
              about="Without blur, fades or shadows, for a device that feels slow."
              on={effects}
              onChange={(on) => void save({ reduceEffects: on })}
            />
            <Setting
              id={`${id}-motion`}
              title="Reduce motion"
              about="Things appear and change in place, without sliding, zooming or flying in."
              on={motion}
              onChange={(on) => void save({ reduceMotion: on })}
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

// One setting: its name and its switch, and under them what it does.
function Setting(props: {
  id: string;
  title: string;
  about: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={props.id} className="text-sm font-medium">
          {props.title}
        </label>
        <Switch
          id={props.id}
          aria-describedby={`${props.id}-about`}
          checked={props.on}
          onCheckedChange={props.onChange}
        />
      </div>
      <span id={`${props.id}-about`} className={label}>
        {props.about}
      </span>
    </div>
  );
}
