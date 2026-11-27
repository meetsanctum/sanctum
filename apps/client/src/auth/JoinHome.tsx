import {
  isUsername,
  normaliseUsername,
  pairingCodeAlphabet,
  pairingCodeLength,
  passwordProblem,
} from "@meetsanctum/auth-protocol";
import {
  Button,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@meetsanctum/ui-sdk";
import { useId, useRef, useState, type FormEvent } from "react";

import { Avatar } from "../components";
import { CoreError } from "../core-fetch";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { checkHost, type CheckedHost } from "./device";
import {
  checkInviteCode,
  finishJoin,
  JoinError,
  type CheckedCode,
} from "./join";
import { passwordProblemText, problemText } from "./messages";
import { rememberSignIn } from "./session";
import {
  Busy,
  Sheet,
  SheetActions,
  SheetField,
  SheetProblem,
  SheetStatus,
} from "./sheet";
import { StorageNotice, useSecureStorage } from "./SignIn";
import { useAuthAttempt } from "./use-auth-attempt";

// Joining a home with an invite code someone at home made: the code first,
// checked as its last character lands, then Welcome, where the person
// chooses how they'll sign in. Their password never leaves this device.
// After a reset, the same steps choose a new password, the username kept
// unless they change it.

const half = pairingCodeLength / 2;
const slots = Array.from({ length: pairingCodeLength }, (_, index) => index);

// A suggested username from a name: Maya Keller is maya.
export function suggestedUsername(name: string) {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const suggestion = normaliseUsername(
    first.normalize("NFKD").replace(/[^A-Za-z0-9_.]/g, ""),
  );
  return isUsername(suggestion) ? suggestion : "";
}

type Step =
  | { name: "code" }
  | { name: "welcome"; code: CheckedCode; checkedHost: CheckedHost };

export function JoinHome(props: {
  host: FoundHost;
  onBack: () => void;
  onJoined: (host: StoredHost) => void;
}) {
  const [step, setStep] = useState<Step>({ name: "code" });
  const [notice, setNotice] = useState<string>();
  if (step.name === "welcome") {
    return (
      <Welcome
        host={props.host}
        code={step.code}
        checkedHost={step.checkedHost}
        onBack={() => setStep({ name: "code" })}
        onExpired={() => {
          setNotice("That took too long. Enter the code again.");
          setStep({ name: "code" });
        }}
        onJoined={props.onJoined}
      />
    );
  }
  return (
    <EnterCode
      host={props.host}
      notice={notice}
      onBack={props.onBack}
      onChecked={(code, checkedHost) => {
        setNotice(undefined);
        setStep({ name: "welcome", code, checkedHost });
      }}
    />
  );
}

function codeProblemText(error: unknown) {
  if (error instanceof JoinError) {
    return error.code === "outdated"
      ? "Update this app to join this home."
      : "This code doesn’t work. Check each character, or try again in a few minutes.";
  }
  if (error instanceof CoreError) {
    if (error.code === "invite_ended") {
      return "This code has ended. Ask someone at home for a new one.";
    }
    if (error.code === "too_many_attempts") {
      return "Too many codes were tried. Try again in 15 minutes.";
    }
  }
  return problemText(error);
}

function EnterCode(props: {
  host: FoundHost;
  notice?: string;
  onBack: () => void;
  onChecked: (code: CheckedCode, checkedHost: CheckedHost) => void;
}) {
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | undefined>(props.notice);
  const [working, setWorking] = useState(false);
  const attempt = useAuthAttempt();
  const input = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const hintId = useId();

  const check = async (typed: string) => {
    if (working || typed.length < pairingCodeLength) return;
    setProblem(undefined);
    setWorking(true);
    const signal = attempt.start();
    try {
      const checkedHost = await checkHost(props.host, signal);
      const checked = await checkInviteCode({
        url: props.host.url,
        signal,
        host: {
          hostId: props.host.id,
          homeId: checkedHost.homeId,
          pin: checkedHost.pin,
        },
        code: typed,
      });
      signal.throwIfAborted();
      props.onChecked(checked, checkedHost);
    } catch (error) {
      if (signal.aborted) return;
      setProblem(codeProblemText(error));
      setWorking(false);
      // The characters stay, selected, so a typo is fixed in place.
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    }
  };

  return (
    <Sheet
      title={`Join ${props.host.name}`}
      subtitle="Enter the invite code someone at home gave you."
      back={{
        onBack: () => {
          attempt.cancel();
          props.onBack();
        },
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void check(code);
        }}
      >
        <div className="flex flex-col items-center gap-2">
          <InputOTP
            ref={input}
            aria-label="Invite code"
            aria-describedby={problem ? `${hintId} ${problemId}` : hintId}
            aria-invalid={problem ? true : undefined}
            maxLength={pairingCodeLength}
            value={code}
            readOnly={working}
            filter={(typed) =>
              [...typed.toUpperCase()]
                .filter((char) => pairingCodeAlphabet.includes(char))
                .join("")
            }
            onChange={(next) => {
              setCode(next);
              setProblem(undefined);
            }}
            onComplete={(full: string) => void check(full)}
            enterKeyHint="go"
            autoComplete="one-time-code"
            autoFocus
          >
            <InputOTPGroup>
              {slots.slice(0, half).map((index) => (
                <InputOTPSlot key={index} index={index} />
              ))}
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              {slots.slice(half).map((index) => (
                <InputOTPSlot key={index} index={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <p
            id={hintId}
            className="m-0 text-center text-[13px] leading-[18px] text-muted-foreground"
          >
            The code has 8 letters and digits, such as K7QX-M4PD.
          </p>
        </div>
        {working && <SheetStatus>Checking the code…</SheetStatus>}
        {problem && <SheetProblem id={problemId}>{problem}</SheetProblem>}
      </form>
    </Sheet>
  );
}

type Problem = {
  field?: "username" | "password" | "repeated";
  text: string;
};

function Welcome(props: {
  host: FoundHost;
  code: CheckedCode;
  checkedHost: CheckedHost;
  onBack: () => void;
  onExpired: () => void;
  onJoined: (host: StoredHost) => void;
}) {
  const { person, username: current } = props.code.checked;
  const [username, setUsername] = useState(
    current ?? suggestedUsername(person.name),
  );
  const [password, setPassword] = useState("");
  const [repeated, setRepeated] = useState("");
  const [problem, setProblem] = useState<Problem>();
  const [working, setWorking] = useState(false);
  const secure = useSecureStorage();
  const attempt = useAuthAttempt();
  const problemId = useId();
  const about = (field: Problem["field"]) =>
    problem?.field === field ? problemId : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isUsername(normaliseUsername(username))) {
      setProblem({
        field: "username",
        text: "Use 3 to 30 letters, digits, dots or underscores.",
      });
      return;
    }
    const tooWeak = passwordProblem(password);
    if (tooWeak) {
      setProblem({ field: "password", text: passwordProblemText(tooWeak) });
      return;
    }
    if (password !== repeated) {
      setProblem({ field: "repeated", text: "Enter the same password twice." });
      return;
    }
    setProblem(undefined);
    setWorking(true);
    const signal = attempt.start();
    try {
      const shell = getShell();
      const joined = await finishJoin({
        url: props.host.url,
        signal,
        code: props.code,
        username,
        password,
        client: { name: await shell.deviceName(), platform: shell.platform },
      });
      const stored = await rememberSignIn(
        props.host,
        joined,
        props.checkedHost,
        signal,
      );
      signal.throwIfAborted();
      props.onJoined(stored);
    } catch (error) {
      if (signal.aborted) return;
      setWorking(false);
      if (error instanceof CoreError && error.code === "username_taken") {
        setProblem({
          field: "username",
          text: "That username is taken. Try another.",
        });
        return;
      }
      if (error instanceof CoreError && error.code === "expired") {
        props.onExpired();
        return;
      }
      if (error instanceof CoreError && error.code === "invite_ended") {
        setProblem({
          text: "This code has ended. Ask someone at home for a new one.",
        });
        return;
      }
      setProblem({ text: problemText(error) });
    }
  };

  const problemLine = (field: Problem["field"]) =>
    problem && problem.field === field ? (
      <SheetProblem id={problemId}>{problem.text}</SheetProblem>
    ) : null;

  return (
    <Sheet
      title={`Welcome, ${person.name}`}
      subtitle={`Choose how you’ll sign in to ${props.host.name}. Your password never leaves this device.`}
      back={{
        onBack: () => {
          attempt.cancel();
          props.onBack();
        },
      }}
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="flex justify-center">
          <Avatar name={person.name} colour={person.colour} size="lg" />
        </div>
        <SheetField
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          hint="3 to 30 letters, digits, dots or underscores."
          problemId={about("username")}
          required
        />
        {problemLine("username")}
        <SheetField
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          hint="At least 8 characters."
          problemId={about("password")}
          required
          autoFocus
        />
        {problemLine("password")}
        <SheetField
          label="Repeat password"
          type="password"
          value={repeated}
          onChange={(event) => setRepeated(event.target.value)}
          autoComplete="new-password"
          problemId={about("repeated")}
          required
        />
        {problemLine("repeated")}
        {problemLine(undefined)}
        <StorageNotice secure={secure} />
        <SheetActions>
          <Button
            variant="default"
            size="lg"
            type="submit"
            className="mt-2 w-full"
            disabled={working}
          >
            {working ? <Busy>Joining…</Busy> : "Join"}
          </Button>
          <p className="m-0 text-center text-[13px] leading-[18px] text-muted-foreground">
            You’ll see {props.host.name}’s dashboard next.
          </p>
        </SheetActions>
      </form>
    </Sheet>
  );
}
