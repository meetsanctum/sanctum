import { formatInviteCode, type PersonInfo } from "@meetsanctum/auth-protocol";
import { Button, useHomeClock } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import { PairingCode } from "../auth/pairing-code";
import { Busy } from "../auth/sheet";
import { useAuthAttempt } from "../auth/use-auth-attempt";
import { productName } from "../brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { CoreError } from "../core-fetch";
import { makeInvite } from "./invites";
import { firstName, untilText } from "./words";

// Inviting a person to sign in, or making a code for a new password: this
// device makes the code and shows it once, in the boxes every code uses and
// as text to copy, with the steps on the person's own device and when it
// ends. Nothing can show it again: New invite code makes another. Right
// after a person is added, it first asks whether they will sign in, since a
// child or a guest may not.

export type Inviting = {
  person: PersonInfo;
  kind: "invite" | "reset";
  // Asks "Will they sign in?" before making the code.
  ask?: boolean;
};

type Stage =
  | { name: "ask" }
  | { name: "making" }
  | { name: "shown"; code: string; endsAt: string }
  | { name: "failed"; problem: string };

export function InviteDialog(props: {
  inviting: Inviting | undefined;
  onClose: () => void;
  // A code was made, so the page reads its person again.
  onMade: () => void;
}) {
  const clock = useHomeClock();
  // What it said stays while it closes.
  const last = useRef<Inviting>(undefined);
  if (props.inviting) last.current = props.inviting;
  const inviting = last.current;
  const [stage, setStage] = useState<Stage>({ name: "ask" });
  const [copied, setCopied] = useState(false);
  const attempt = useAuthAttempt();

  const make = async (target: Inviting) => {
    const signal = attempt.start();
    setStage({ name: "making" });
    setCopied(false);
    try {
      const made = await makeInvite(target.person.id, signal);
      signal.throwIfAborted();
      setStage({ name: "shown", code: made.code, endsAt: made.info.endsAt });
      props.onMade();
    } catch (error) {
      if (signal.aborted) return;
      setStage({
        name: "failed",
        problem:
          error instanceof CoreError && error.code === "not_found"
            ? `${target.person.name} is no longer in People.`
            : "The code couldn't be made. Try again.",
      });
    }
  };

  // Each time it opens, it starts afresh: with its question, or straight
  // to making the code.
  const [shown, setShown] = useState(props.inviting);
  if (shown !== props.inviting) {
    setShown(props.inviting);
    if (props.inviting) {
      setCopied(false);
      setStage(props.inviting.ask ? { name: "ask" } : { name: "making" });
    }
  }
  const opened = props.inviting;
  useEffect(() => {
    if (opened && !opened.ask) void make(opened);
    // Only when it opens: make is new on every render.
  }, [opened]);

  const close = () => {
    attempt.cancel();
    props.onClose();
  };

  if (!inviting) return null;
  const { person, kind } = inviting;
  const name = firstName(person.name);
  const reset = kind === "reset";
  const formatted = stage.name === "shown" ? formatInviteCode(stage.code) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      open={!!props.inviting}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {stage.name === "ask" ? (
          <>
            <DialogHeader>
              <DialogTitle>Will {person.name} sign in?</DialogTitle>
              <DialogDescription>
                Signing in lets {name} use {productName} on their own phone or
                computer, with a password only {name} knows. Anyone can use the
                home’s shared devices without signing in.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Not now
              </Button>
              <Button onClick={() => void make(inviting)}>
                Invite to sign in
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {reset
                  ? `Reset ${person.name}’s password`
                  : `Invite ${person.name} to sign in`}
              </DialogTitle>
              <DialogDescription>
                {stage.name === "shown"
                  ? [
                      reset
                        ? `Give ${name} this code to choose a new password. ${name}’s current password works until then.`
                        : `Give ${name} this code.`,
                      `It works once, until ${untilText(clock, stage.endsAt)}.`,
                      "You can’t see it again after you close this.",
                    ].join(" ")
                  : reset
                    ? `A code lets ${name} choose a new password.`
                    : `A code lets ${name} join on their own phone or computer.`}
              </DialogDescription>
            </DialogHeader>
            {stage.name === "making" && (
              <p
                role="status"
                className="m-0 flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Busy>Making a code…</Busy>
              </p>
            )}
            {stage.name === "failed" && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {stage.problem}
              </p>
            )}
            {stage.name === "shown" && (
              <>
                <div className="flex flex-col items-center gap-2">
                  <PairingCode code={stage.code} />
                  <p className="m-0 font-mono text-sm tracking-wider select-all">
                    <span className="sr-only">The code is </span>
                    {formatted}
                  </p>
                </div>
                <ol className="m-0 flex list-decimal flex-col gap-2 ps-5 text-sm">
                  <li>
                    On {name}’s phone or computer, open {productName} and choose
                    your home.
                  </li>
                  <li>Choose Just me, then I have an invite code.</li>
                  <li>
                    {reset
                      ? "Enter this code, then choose a new password."
                      : "Enter this code, then choose a username and password."}
                  </li>
                </ol>
                <p role="status" className="sr-only">
                  {copied ? "Copied" : ""}
                </p>
              </>
            )}
            <DialogFooter>
              {stage.name === "failed" ? (
                <>
                  <Button variant="outline" onClick={close}>
                    Cancel
                  </Button>
                  <Button onClick={() => void make(inviting)}>Try again</Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={stage.name !== "shown"}
                    onClick={() => void copy()}
                  >
                    {copied ? "Copied" : "Copy code"}
                  </Button>
                  <Button onClick={close}>Done</Button>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
