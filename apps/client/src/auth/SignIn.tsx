import { Button } from "@meetsanctum/ui-sdk";
import { useEffect, useState, type FormEvent } from "react";

import { Field, Sheet } from "../components";
import { ChooseAnotherHome } from "../connection-veil";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { checkHost, signIn, SignInError } from "./device";
import { problemText } from "./messages";
import { rememberSignIn } from "./session";
import { useAuthAttempt } from "./use-auth-attempt";

// Whether the shell stores the token securely; undefined while asking.
export function useSecureStorage() {
  const [secure, setSecure] = useState<boolean>();
  useEffect(() => {
    void getShell().credentials.isSecure().then(setSecure);
  }, []);
  return secure;
}

// Says when the token will be saved unencrypted. The shell answers after the
// screen shows, so the notice is in a polite live region that is there from
// the start; it takes no room in the sheet until it has something to say.
export function StorageNotice(props: { secure: boolean | undefined }) {
  return (
    <div role="status" className="contents">
      {props.secure === false && (
        <p className="notice">
          This computer has no secure storage, so your sign-in will be saved
          unencrypted.
        </p>
      )}
    </div>
  );
}

// Signing in on a personal device. The password is checked on this device,
// and the sign-in proves the host.
export function SignIn(props: {
  host: FoundHost;
  onBack: () => void;
  onSignedIn: (host: StoredHost) => void;
  // Nobody signs in on a shared device: another device approves it.
  onShared: () => void;
  // The stored host whose certificate changed, when this checks it again,
  // and what follows once it is forgotten.
  recheck?: StoredHost;
  onForgotten?: () => void;
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
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
      setIsAnotherHome(
        error instanceof SignInError && error.code === "another_host",
      );
      setWorking(false);
    }
  };

  return (
    <Sheet
      title={`Sign in to ${props.host.name}`}
      onBack={() => {
        attempt.cancel();
        props.onBack();
      }}
      intro={<StorageNotice secure={secure} />}
    >
      <form className="form" onSubmit={submit}>
        <Field
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
        {problem && (
          <p className="problem" role="alert">
            {problem}
          </p>
        )}
        <Button
          variant="default"
          size="lg"
          type="submit"
          className="mt-1"
          disabled={working}
        >
          {working ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      {props.recheck && props.onForgotten && isAnotherHome && (
        <ChooseAnotherHome
          host={props.recheck}
          onForgotten={props.onForgotten}
          variant="link"
        />
      )}
      <Button
        type="button"
        variant="link"
        size="inline"
        className="self-start"
        onClick={() => {
          attempt.cancel();
          props.onShared();
        }}
      >
        This is a shared device
      </Button>
    </Sheet>
  );
}
