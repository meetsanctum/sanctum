import { Button } from "@meetsanctum/ui-sdk";
import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { problemText, newPasswordProblem } from "../auth/messages";
import {
  changePassword,
  choosePassword,
  PasswordChangeError,
} from "../auth/password";
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
// current one, then the new one twice. The current one is checked on this
// device before anything changes, and the other devices signed in as you
// stay signed in, which the dialog says, with where to sign one out. While
// it saves it can't be closed. If the final reply is lost, it says the
// change could not be confirmed. Forgot your password? turns it into
// Choose a new password, without the current one: this device is signed in
// as you, which is proof enough.

type Field = "current" | "password" | "repeated";
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
  const [repeated, setRepeated] = useState("");
  const [problem, setProblem] = useState<Problem>();
  const [working, setWorking] = useState(false);
  const [forgot, setForgot] = useState(false);
  const currentInput = useRef<HTMLInputElement>(null);
  const newInput = useRef<HTMLInputElement>(null);
  const attempt = useAuthAttempt();
  const { open } = props;

  // Clear the attempt as soon as the dialog closes.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setCurrent("");
      setPassword("");
      setRepeated("");
      setProblem(undefined);
      setWorking(false);
      setForgot(false);
    }
  }

  const forget = () => {
    setForgot(true);
    setCurrent("");
    setProblem(undefined);
    requestAnimationFrame(() => newInput.current?.focus());
  };

  const close = () => {
    if (working) return;
    attempt.cancel();
    props.onOpenChange(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (working) return;
    const invalid = newPasswordProblem(password, repeated);
    setProblem(invalid);
    if (invalid) return;
    setWorking(true);
    const signal = attempt.start();
    try {
      await (forgot
        ? choosePassword({ next: password, signal })
        : changePassword({ current, next: password, signal }));
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
      after?: ReactNode;
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
        ref={
          name === "current"
            ? currentInput
            : name === "password"
              ? newInput
              : undefined
        }
        type="password"
        value={value}
        autoComplete={options.autoComplete}
        autoFocus={options.autoFocus}
        readOnly={working}
        required
        onChange={(event) => {
          onChange(event.target.value);
          if (
            hasProblem ||
            (name === "password" && problem?.field === "repeated")
          ) {
            setProblem(undefined);
          }
        }}
      >
        {problemLine(name)}
        {options.after}
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
            <DialogTitle>
              {forgot ? "Choose a new password" : "Change your password"}
            </DialogTitle>
            <DialogDescription>
              {forgot
                ? "This device is signed in as you, so you don’t need your old password. Your new one never leaves this device. Your other devices stay signed in."
                : "Your password never leaves this device. Your other devices stay signed in. To sign one out, use Sign out under Linked Devices."}
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
            {!forgot &&
              field("current", "Current password", current, setCurrent, {
                autoComplete: "current-password",
                autoFocus: true,
                after: (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="-ms-2.5 self-start"
                    disabled={working}
                    onClick={forget}
                  >
                    Forgot your password?
                  </Button>
                ),
              })}
            {field("password", "New password", password, setPassword, {
              hint: "At least 8 characters.",
              autoComplete: "new-password",
            })}
            {field("repeated", "Repeat new password", repeated, setRepeated, {
              autoComplete: "new-password",
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
