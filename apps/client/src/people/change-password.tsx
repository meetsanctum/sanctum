import { Button } from "@meetsanctum/ui-sdk";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";

import { problemText, newPasswordProblem } from "../auth/messages";
import { changePassword, PasswordChangeError } from "../auth/password";
import { Busy, SheetField, SheetProblem } from "../auth/sheet";
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

// Changing your own password, from your own page on your own device: the
// current one, then the new one once, with a way to show it. The current
// one is checked on this device before anything changes, and the other
// devices signed in as you stay signed in, which the dialog says, with where
// to sign one out. While it saves it can't be closed. If the final reply is
// lost, it says the change could not be confirmed.

type Field = "current" | "password";
type Problem = { field?: Field; text: string };

function changeProblem(error: unknown): Problem {
  if (
    (error instanceof PasswordChangeError && error.code === "wrong_password") ||
    (error instanceof CoreError && error.code === "sign_in_failed")
  ) {
    return {
      field: "current",
      text: "That password doesn’t match. Check it and try again.",
    };
  }
  if (error instanceof PasswordChangeError) {
    if (error.code === "unconfirmed") {
      return {
        text: "Couldn’t confirm the password change. Check whether your new password works before trying again.",
      };
    }
    if (error.code === "unchecked") {
      return {
        text: "This app can't check this home's security certificate.",
      };
    }
    return { text: `${productName} ran into a problem. Try again.` };
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { text: "That took too long. Try again." };
  }
  return { text: problemText(error) };
}

export function ChangePassword(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Given to password managers, so they update the right entry.
  username: string;
  trigger: RefObject<HTMLButtonElement | null>;
  onChanged: () => void;
}) {
  const ids = useId();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<Problem>();
  const [working, setWorking] = useState(false);
  const currentInput = useRef<HTMLInputElement>(null);
  const attempt = useAuthAttempt();
  const { open } = props;

  // Clear the attempt as soon as the dialog closes.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setCurrent("");
      setPassword("");
      setProblem(undefined);
      setWorking(false);
    }
  }

  const close = () => {
    if (working) return;
    attempt.cancel();
    props.onOpenChange(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (working) return;
    const invalid = newPasswordProblem(password);
    setProblem(invalid);
    if (invalid) return;
    setWorking(true);
    const signal = attempt.start();
    try {
      await changePassword({ current, next: password, signal });
      signal.throwIfAborted();
      setWorking(false);
      props.onOpenChange(false);
      props.onChanged();
    } catch (error) {
      if (signal.aborted) return;
      setWorking(false);
      const next = changeProblem(error);
      setProblem(next);
      // The current password stays, selected, so a typo is fixed in place.
      if (next.field === "current") {
        requestAnimationFrame(() => {
          currentInput.current?.focus();
          currentInput.current?.select();
        });
      }
    }
  };

  const problemId = `${ids}-problem`;
  const problemLine = (field: Field | undefined) =>
    problem && problem.field === field ? (
      <SheetProblem id={problemId}>{problem.text}</SheetProblem>
    ) : null;
  const field = (
    name: Field,
    text: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      hint?: string;
      autoComplete: string;
      autoFocus?: boolean;
      revealable?: boolean;
    },
  ) => {
    // A problem takes the hint's place, so the two never say the same twice.
    const hasProblem = problem?.field === name;
    return (
      <SheetField
        compact
        label={text}
        hint={hasProblem ? undefined : options.hint}
        problemId={hasProblem ? problemId : undefined}
        ref={name === "current" ? currentInput : undefined}
        type="password"
        revealable={options.revealable}
        value={value}
        autoComplete={options.autoComplete}
        autoFocus={options.autoFocus}
        readOnly={working}
        required
        onChange={(event) => {
          onChange(event.target.value);
          if (hasProblem) setProblem(undefined);
        }}
      >
        {problemLine(name)}
      </SheetField>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto supports-[height:100dvh]:max-h-[calc(100dvh-2rem)]"
        showCloseButton={!working}
        onEscapeKeyDown={(event) => {
          if (working) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (working) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (!props.trigger.current) return;
          event.preventDefault();
          props.trigger.current.focus();
        }}
      >
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Change your password</DialogTitle>
            <DialogDescription>
              Your password never leaves this device. Your other devices stay
              signed in. To sign one out, use Sign out under Linked Devices.
            </DialogDescription>
          </DialogHeader>
          <input
            type="text"
            autoComplete="username"
            value={props.username}
            readOnly
            hidden
          />
          <div className="flex flex-col gap-4">
            {field("current", "Current password", current, setCurrent, {
              autoComplete: "current-password",
              autoFocus: true,
            })}
            {field("password", "New password", password, setPassword, {
              hint: "At least 8 characters.",
              autoComplete: "new-password",
              revealable: true,
            })}
          </div>
          {problemLine(undefined)}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={working}
              onClick={close}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={working}>
              {working ? <Busy>Changing…</Busy> : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
