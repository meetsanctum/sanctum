import { Button } from "@meetsanctum/ui-sdk";
import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";

import { ChooseAnotherHome } from "../connection-veil";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { checkHost, signIn, SignInError } from "./device";
import { problemText } from "./messages";
import { rememberSignIn } from "./session";
import {
  Busy,
  Sheet,
  SheetActions,
  SheetField,
  SheetNote,
  SheetProblem,
} from "./sheet";
import { useAuthAttempt } from "./use-auth-attempt";

// Whether the shell stores the token securely; undefined while asking.
export function useSecureStorage() {
  const [secure, setSecure] = useState<boolean>();
  useEffect(() => {
    void getShell().credentials.isSecure().then(setSecure);
  }, []);
  return secure;
}

// Says when the token will be saved unencrypted, before anyone types. The
// shell answers after the screen shows, so the note is in a polite live
// region that is there from the start; it takes no room until it has
// something to say.
export function StorageNotice(props: { secure: boolean | undefined }) {
  return (
    <div role="status" className="contents">
      {props.secure === false && (
        <SheetNote icon={TriangleAlert}>
          This device can’t store your sign-in securely, so it’s saved
          unencrypted.
        </SheetNote>
      )}
    </div>
  );
}

// Signing in on a personal device. The password never leaves the device,
// and the sign-in proves the host.
export function SignIn(props: {
  host: FoundHost;
  onBack: () => void;
  onSignedIn: (host: StoredHost) => void;
  // The stored host whose certificate changed, when this checks it again,
  // and what follows once it is forgotten.
  recheck?: StoredHost;
  onForgotten?: () => void;
  // Joining with an invite code instead, for someone who doesn't sign in
  // yet or chooses a new password.
  onJoin?: () => void;
  // A recovery code or a password code, for a forgotten password.
  onForgot?: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string>();
  // Another home answers at the address: replaced hardware has a new id, so
  // this one can only be forgotten and the new one chosen.
  const [isAnotherHome, setIsAnotherHome] = useState(false);
  const [working, setWorking] = useState(false);
  const secure = useSecureStorage();
  const attempt = useAuthAttempt();
  const problemId = useId();
  // A wrong username or password is about both fields, which then say so.
  const [fieldsWrong, setFieldsWrong] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setFieldsWrong(false);
    setIsAnotherHome(false);
    setWorking(true);
    const signal = attempt.start();
    try {
      const shell = getShell();
      const checked = await checkHost(props.host, signal);
      const signedIn = await signIn({
        url: props.host.url,
        signal,
        hostId: props.host.id,
        ...checked,
        username,
        password,
        client: { name: await shell.deviceName(), platform: shell.platform },
      });
      const stored = await rememberSignIn(
        props.host,
        signedIn,
        checked,
        signal,
      );
      signal.throwIfAborted();
      props.onSignedIn(stored);
    } catch (error) {
      if (signal.aborted) return;
      setProblem(problemText(error));
      setFieldsWrong(
        error instanceof SignInError &&
          error.code === "wrong_username_or_password",
      );
      setIsAnotherHome(
        error instanceof SignInError && error.code === "another_host",
      );
      setWorking(false);
    }
  };

  return (
    <Sheet
      title={`Sign in to ${props.host.name}`}
      subtitle="Your password never leaves this device."
      back={{
        onBack: () => {
          attempt.cancel();
          props.onBack();
        },
      }}
    >
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <SheetField
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          problemId={fieldsWrong ? problemId : undefined}
          required
        />
        <SheetField
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          problemId={fieldsWrong ? problemId : undefined}
          required
        >
          {props.onForgot && (
            <Button
              variant="link"
              size="sm"
              type="button"
              className="-ms-2.5 self-start"
              onClick={() => {
                attempt.cancel();
                props.onForgot?.();
              }}
            >
              Forgot your password?
            </Button>
          )}
        </SheetField>
        {problem && <SheetProblem id={problemId}>{problem}</SheetProblem>}
        <StorageNotice secure={secure} />
        <SheetActions>
          <Button
            variant="default"
            size="lg"
            type="submit"
            className="mt-3 w-full"
            disabled={working}
          >
            {working ? <Busy>Signing in…</Busy> : "Sign in"}
          </Button>
          {props.onJoin && (
            <Button
              variant="link"
              size="lg"
              type="button"
              onClick={() => {
                attempt.cancel();
                props.onJoin?.();
              }}
            >
              I have an invite code
            </Button>
          )}
          {props.recheck && props.onForgotten && isAnotherHome && (
            <ChooseAnotherHome
              host={props.recheck}
              onForgotten={props.onForgotten}
              variant="link"
            />
          )}
        </SheetActions>
      </form>
    </Sheet>
  );
}
