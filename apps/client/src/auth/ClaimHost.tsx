import {
  isUsername,
  normaliseUsername,
  passwordProblem,
} from "@meetsanctum/auth-protocol";
import { useState, type FormEvent } from "react";

import { Field, Sheet } from "../components";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { checkHost, claimHost } from "./device";
import { passwordProblemText, problemText } from "./messages";
import { rememberSignIn } from "./session";
import { StorageNotice, useSecureStorage } from "./SignIn";
import { useAuthAttempt } from "./use-auth-attempt";
import { Button } from "@meetsanctum/ui-sdk";

// Identity colours from the avatar set.
const colours = [
  { name: "Sage", value: "#c5cdac" },
  { name: "Blue", value: "#b9defc" },
  { name: "Peach", value: "#fcd2b3" },
  { name: "Lavender", value: "#dbcaf5" },
];

// Setting up a new host: the first person joins its household. The password
// is registered on this device and never sent.
export function ClaimHost(props: {
  host: FoundHost;
  onBack: () => void;
  onClaimed: (host: StoredHost) => void;
}) {
  const [name, setName] = useState("");
  const [colour, setColour] = useState(colours[0]!.value);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeated, setRepeated] = useState("");
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const secure = useSecureStorage();
  const attempt = useAuthAttempt();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const tooWeak = passwordProblem(password);
    if (!isUsername(normaliseUsername(username))) {
      setProblem(
        "Usernames have 3 to 30 letters, digits, dots or underscores.",
      );
      return;
    }
    if (tooWeak) {
      setProblem(passwordProblemText(tooWeak));
      return;
    }
    if (password !== repeated) {
      setProblem("The passwords do not match.");
      return;
    }
    setProblem(undefined);
    setWorking(true);
    const signal = attempt.start();
    try {
      const shell = getShell();
      // Nothing has checked the host before a claim: the app pins what it
      // saw.
      const checked = await checkHost(props.host, signal);
      const signedIn = await claimHost({
        url: props.host.url,
        signal,
        username,
        password,
        person: { name: name.trim(), colour },
        client: { name: await shell.deviceName(), platform: shell.platform },
      });
      const stored = await rememberSignIn(
        props.host,
        signedIn,
        checked,
        signal,
      );
      signal.throwIfAborted();
      props.onClaimed(stored);
    } catch (error) {
      if (signal.aborted) return;
      setProblem(problemText(error));
      setWorking(false);
    }
  };

  return (
    <Sheet
      title="Set up your home"
      onBack={() => {
        attempt.cancel();
        props.onBack();
      }}
      intro={
        <>
          <p className="muted">
            You are the first person in this home. Your password stays on this
            device and is never sent.
          </p>
          <StorageNotice secure={secure} />
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <Field
          label="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          maxLength={60}
          required
        />
        <fieldset className="field">
          <legend className="field-label">Your colour</legend>
          <div className="swatches">
            {colours.map((option) => (
              <label key={option.value} className="swatch">
                <input
                  type="radio"
                  name="colour"
                  value={option.value}
                  checked={colour === option.value}
                  onChange={() => setColour(option.value)}
                />
                <span style={{ background: option.value }} />
                <span className="visually-hidden">{option.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
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
          autoComplete="new-password"
          hint="At least 8 characters."
          required
        />
        <Field
          label="Repeat password"
          type="password"
          value={repeated}
          onChange={(event) => setRepeated(event.target.value)}
          autoComplete="new-password"
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
          {working ? "Setting up…" : "Set up"}
        </Button>
      </form>
    </Sheet>
  );
}
