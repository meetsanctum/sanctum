import {
  formatInviteCode,
  type InviteInfo,
  type PersonInfo,
} from "@meetsanctum/auth-protocol";
import { Button, useHomeClock } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import { PairingCode } from "../auth/pairing-code";
import { Busy } from "../auth/sheet";
import { useAuthAttempt } from "../auth/use-auth-attempt";
import { useCopyCode } from "../auth/use-copy-code";
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
import { printRecoveryCode } from "./print-recovery";
import { firstName, untilText } from "./words";

// Inviting a person to sign in, making a code for a new password, or your
// own recovery code: this device makes the code and shows it once, in the
// boxes every code uses, with the steps on the person's own device and when
// it ends. Its text is for screen readers and Copy code, and shows only if
// copying fails. Nothing can show it again: New invite code makes another.
// Right after a person is added, it first asks whether they will sign in,
// since a child or a guest may not. A recovery code can also be printed.

export type Inviting = {
  person: PersonInfo;
  kind: InviteInfo["kind"];
  ask?: boolean;
  replacesInviteId?: string;
  // For the printed recovery code.
  username?: string;
};

type OpeningStage = "ask" | "replace" | "making";
type Stage =
  | { name: OpeningStage }
  | {
      name: "shown";
      code: string;
      endsAt: string;
      madeAt: string;
      signal: AbortSignal;
    }
  | { name: "failed"; problem: string; retry: boolean };

function openingStage(inviting: Inviting | undefined): OpeningStage {
  if (inviting?.ask) return "ask";
  if (inviting?.replacesInviteId) return "replace";
  return "making";
}

export function InviteDialog(props: {
  inviting: Inviting | undefined;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const clock = useHomeClock();
  // What it said stays while it closes.
  const last = useRef<Inviting>(undefined);
  if (props.inviting) last.current = props.inviting;
  const inviting = last.current;
  const [stage, setStage] = useState<Stage>({
    name: openingStage(props.inviting),
  });
  const clipboard = useCopyCode();
  const attempt = useAuthAttempt();

  const make = async (target: Inviting) => {
    const signal = attempt.start();
    setStage({ name: "making" });
    clipboard.reset();
    try {
      const made = await makeInvite(
        {
          personId: target.person.id,
          kind: target.kind,
          replacesInviteId: target.replacesInviteId,
        },
        signal,
      );
      signal.throwIfAborted();
      setStage({
        name: "shown",
        code: made.code,
        endsAt: made.info.endsAt,
        madeAt: made.info.createdAt,
        signal,
      });
      props.onRefresh();
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof CoreError ? error.code : undefined;
      if (code === "invite_changed" || code === "invite_kind_changed") {
        setStage({
          name: "failed",
          problem:
            code === "invite_changed"
              ? "The active code has changed. Close this to see the current details."
              : `${target.person.name}’s sign-in has changed. Close this to see the current details.`,
          retry: false,
        });
        props.onRefresh();
      } else {
        setStage({
          name: "failed",
          problem:
            code === "not_found"
              ? `${target.person.name} is no longer in People.`
              : "The code couldn't be made. Try again.",
          retry: code !== "not_found",
        });
      }
    }
  };

  // Each time it opens, it starts afresh: with its question, or straight
  // to making the code.
  const [shown, setShown] = useState(props.inviting);
  if (shown !== props.inviting) {
    setShown(props.inviting);
    if (props.inviting) {
      clipboard.reset();
      setStage({ name: openingStage(props.inviting) });
    }
  }
  const opened = props.inviting;
  useEffect(() => {
    if (opened && openingStage(opened) === "making") void make(opened);
    // Only when it opens: make is new on every render.
  }, [opened]);

  const close = () => {
    if (stage.name === "making") return;
    attempt.cancel();
    props.onClose();
  };

  if (!inviting) return null;
  const { person, kind } = inviting;
  const name = firstName(person.name);
  const reset = kind === "reset";
  const recovery = kind === "recovery";
  const replacing = !!inviting.replacesInviteId;
  const formatted = stage.name === "shown" ? formatInviteCode(stage.code) : "";
  const making = stage.name === "making";

  return (
    <Dialog
      open={!!props.inviting}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        showCloseButton={!making}
        onEscapeKeyDown={(event) => {
          if (making) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (making) event.preventDefault();
        }}
      >
        {stage.name === "ask" ? (
          <>
            <DialogHeader>
              <DialogTitle>Will {person.name} sign in?</DialogTitle>
              <DialogDescription>
                Signing in lets {name} use {productName} on their own Mac, with
                a password only {name} knows. Anyone can use the home’s shared
                devices without signing in.
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
        ) : stage.name === "replace" ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {recovery
                  ? "Replace your recovery code?"
                  : `Replace ${name}’s invite code?`}
              </DialogTitle>
              <DialogDescription>
                The previous code will stop working as soon as the new one is
                made.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" autoFocus onClick={close}>
                Cancel
              </Button>
              <Button onClick={() => void make(inviting)}>Make new code</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {recovery
                  ? replacing
                    ? "Your new recovery code"
                    : "Your recovery code"
                  : reset
                    ? `Reset ${person.name}’s password`
                    : `Invite ${person.name} to sign in`}
              </DialogTitle>
              <DialogDescription>
                {recovery
                  ? stage.name === "shown"
                    ? [
                        replacing ? "Your earlier code no longer works." : "",
                        "If you forget your password, this code lets you choose a new one.",
                        "It works once, even with no device signed in as you.",
                        "You can’t see it again after you close this.",
                      ]
                        .filter(Boolean)
                        .join(" ")
                    : "A recovery code lets you choose a new password if you forget it."
                  : stage.name === "shown"
                    ? [
                        reset
                          ? `Give ${name} this code to choose a new password. ${name}’s current password works until then.`
                          : `Give ${name} this code.`,
                        `It works once, until ${untilText(clock, stage.endsAt)}.`,
                        "You can’t see it again after you close this.",
                      ].join(" ")
                    : reset
                      ? `A code lets ${name} choose a new password.`
                      : `A code lets ${name} join from the ${productName} Mac app.`}
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
                  {/* The boxes show it; the text is for screen readers, and
                      for copying by hand if Copy code fails. */}
                  <p
                    className={
                      clipboard.status === "failed"
                        ? "m-0 text-sm tracking-wider select-all"
                        : "sr-only"
                    }
                  >
                    <span className="sr-only">The code is </span>
                    <span ref={clipboard.codeText}>{formatted}</span>
                  </p>
                </div>
                {recovery ? (
                  <p className="m-0 text-sm text-muted-foreground">
                    Save it in a password manager, or print it and keep it with
                    your important papers.
                  </p>
                ) : (
                  <ol className="m-0 flex list-decimal flex-col gap-2 ps-5 text-sm">
                    <li>
                      On {name}’s Mac, open {productName} and choose your home.
                    </li>
                    <li>
                      {reset
                        ? "Choose Just me, then Forgot your password?"
                        : "Choose Just me, then I have an invite code."}
                    </li>
                    <li>
                      {reset
                        ? "Enter this code, then choose a new password."
                        : "Enter this code, then choose a username and password."}
                    </li>
                  </ol>
                )}
                <p
                  role="status"
                  className={
                    clipboard.status === "failed"
                      ? "m-0 text-sm text-muted-foreground"
                      : "sr-only"
                  }
                >
                  {clipboard.message}
                </p>
              </>
            )}
            {!making && (
              <DialogFooter>
                {stage.name === "failed" ? (
                  <>
                    <Button
                      variant={stage.retry ? "outline" : "default"}
                      onClick={close}
                    >
                      {stage.retry ? "Cancel" : "Done"}
                    </Button>
                    {stage.retry && (
                      <Button onClick={() => void make(inviting)}>
                        Try again
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (stage.name === "shown")
                          void clipboard.copy(formatted, stage.signal);
                      }}
                    >
                      {clipboard.status === "copied" ? "Copied" : "Copy code"}
                    </Button>
                    {recovery && stage.name === "shown" && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          printRecoveryCode({
                            clock,
                            person: person.name,
                            username: inviting.username ?? "",
                            code: formatted,
                            madeAt: stage.madeAt,
                          })
                        }
                      >
                        Print
                      </Button>
                    )}
                    <Button onClick={close}>Done</Button>
                  </>
                )}
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
