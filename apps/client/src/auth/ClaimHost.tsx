import {
  isUsername,
  normaliseUsername,
  passwordProblem,
} from "@meetsanctum/auth-protocol";
import { Button } from "@meetsanctum/ui-sdk";
import { useId, useState, type FormEvent } from "react";

import { Avatar } from "../components";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { checkHost, claimHost } from "./device";
import { passwordProblemText, problemText } from "./messages";
import { rememberSignIn } from "./session";
import { Busy, Sheet, SheetActions, SheetField, SheetProblem } from "./sheet";
import { StorageNotice, useSecureStorage } from "./SignIn";
import { useAuthAttempt } from "./use-auth-attempt";

// Identity colours from the avatar set.
const colours = [
  { name: "Sage", value: "#c5cdac" },
  { name: "Blue", value: "#b9defc" },
  { name: "Peach", value: "#fcd2b3" },
  { name: "Lavender", value: "#dbcaf5" },
];

// What a problem is about: one of the fields, which then names it, or the
// set-up as a whole.
type Problem = {
  field?: "username" | "password" | "repeated";
  text: string;
};

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
  const [problem, setProblem] = useState<Problem>();
  const [working, setWorking] = useState(false);
  const secure = useSecureStorage();
  const attempt = useAuthAttempt();
  const problemId = useId();
  const about = (field: Problem["field"]) =>
    problem?.field === field ? problemId : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const tooWeak = passwordProblem(password);
    if (!isUsername(normaliseUsername(username))) {
      setProblem({
        field: "username",
        text: "Use 3 to 30 letters, digits, dots or underscores.",
      });
      return;
    }
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
      setProblem({ text: problemText(error) });
      setWorking(false);
    }
  };

  const problemLine = (field: Problem["field"]) =>
    problem && problem.field === field ? (
      <SheetProblem id={problemId}>{problem.text}</SheetProblem>
    ) : null;

  return (
    <Sheet
      title="Set up your home"
      subtitle="You’re the first person in this home. Your password never leaves this device."
      back={{
        to: "Homes",
        onBack: () => {
          attempt.cancel();
          props.onBack();
        },
      }}
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="flex items-end gap-4">
          <span className="mb-0.5">
            <Avatar name={name || " "} colour={colour} size="lg" />
          </span>
          <div className="flex-1">
            <SheetField
              label="Your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              maxLength={60}
              required
            />
          </div>
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            Your colour
          </legend>
          <div className="flex gap-3">
            {colours.map((option) => (
              <label
                key={option.value}
                className="relative flex size-11 cursor-pointer items-center justify-center"
              >
                <input
                  type="radio"
                  name="colour"
                  value={option.value}
                  checked={colour === option.value}
                  onChange={() => setColour(option.value)}
                  aria-label={option.name}
                  className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
                />
                <span
                  aria-hidden="true"
                  className="size-8 rounded-full peer-checked:ring-2 peer-checked:ring-(--action) peer-checked:ring-offset-2 peer-checked:ring-offset-(--carbon) peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-(--action)"
                  style={{ background: option.value }}
                />
              </label>
            ))}
          </div>
        </fieldset>
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
            {working ? <Busy>Setting up…</Busy> : "Set up"}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
