import { Button } from "@meetsanctum/ui-sdk";
import { useId, useState, type FormEvent } from "react";

import { ColourPicker, identityColours } from "../colour-picker";
import { Avatar } from "../components";
import { getShell, type FoundHost, type StoredHost } from "../shell";
import { checkHost, claimHost } from "./device";
import {
  credentialProblem,
  problemText,
  type CredentialProblem,
} from "./messages";
import { SaveRecovery } from "./SaveRecovery";
import { rememberSignIn, selectHost } from "./session";
import { Busy, Sheet, SheetActions, SheetField, SheetProblem } from "./sheet";
import { StorageNotice, useSecureStorage } from "./SignIn";
import { useAuthAttempt } from "./use-auth-attempt";

// Setting up a new host: the first person joins its household. The password
// is registered on this device and never sent. Then they save a recovery
// code, for if they forget it.
export function ClaimHost(props: {
  host: FoundHost;
  onBack: () => void;
  onClaimed: (host: StoredHost) => void;
}) {
  const [name, setName] = useState("");
  const [colour, setColour] = useState<string>(identityColours[0].value);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeated, setRepeated] = useState("");
  const [problem, setProblem] = useState<CredentialProblem>();
  const [working, setWorking] = useState(false);
  const [claimed, setClaimed] = useState<{
    stored: StoredHost;
    personId: string;
  }>();
  const secure = useSecureStorage();
  const attempt = useAuthAttempt();
  const problemId = useId();
  const about = (field: CredentialProblem["field"]) =>
    problem?.field === field ? problemId : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = credentialProblem(username, password, repeated);
    setProblem(invalid);
    if (invalid) return;
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
      // The recovery code is made as this device, signed in now.
      selectHost(stored);
      setClaimed({ stored, personId: signedIn.person.id });
    } catch (error) {
      if (signal.aborted) return;
      setProblem({ text: problemText(error) });
      setWorking(false);
    }
  };

  if (claimed) {
    return (
      <SaveRecovery
        personId={claimed.personId}
        person={name.trim()}
        username={username}
        onContinue={() => props.onClaimed(claimed.stored)}
      />
    );
  }

  const problemLine = (field: CredentialProblem["field"]) =>
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
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="flex items-end gap-4">
          <span className="mb-0.5">
            <Avatar name={name} colour={colour} size="lg" />
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
        <ColourPicker
          legend="Your colour"
          name="colour"
          value={colour}
          onChange={setColour}
          surface="var(--carbon)"
        />
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
            className="mt-3 w-full"
            disabled={working}
          >
            {working ? <Busy>Setting up…</Busy> : "Set up"}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
