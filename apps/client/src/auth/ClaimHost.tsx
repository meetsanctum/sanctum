import { normaliseUsername } from "@meetsanctum/auth-protocol";
import { Button } from "@meetsanctum/ui-sdk";
import { useId, useRef, useState, type FormEvent } from "react";

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
import { rememberSignIn } from "./session";
import { Busy, Sheet, SheetActions, SheetField, SheetProblem } from "./sheet";
import { StorageNotice, useSecureStorage } from "./SignIn";
import { useAuthAttempt } from "./use-auth-attempt";

// Setting up a new host: the first person joins its household, in two
// steps. The first takes how they sign in, the second their name and
// colour; the home is set up once both are given, and going back to the
// first keeps what the second holds. The password is registered on this
// device and never sent. Then they save a recovery code, for if they forget
// it.
export function ClaimHost(props: {
  host: FoundHost;
  onBack: () => void;
  onClaimed: (host: StoredHost) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [colour, setColour] = useState<string>(identityColours[0].value);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<CredentialProblem>();
  const [pending, setPending] = useState<"claim" | "save">();
  const working = pending !== undefined;
  const saving = useRef(false);
  const [claimed, setClaimed] = useState<{
    stored: StoredHost;
    personId: string;
  }>();
  const secure = useSecureStorage();
  const attempt = useAuthAttempt();
  const problemId = useId();
  const about = (field: CredentialProblem["field"]) =>
    problem?.field === field ? problemId : undefined;

  const next = (event: FormEvent) => {
    event.preventDefault();
    const invalid = credentialProblem(username, password);
    setProblem(invalid);
    if (!invalid) setStep(2);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (working) return;
    setProblem(undefined);
    setPending("claim");
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
      signal.throwIfAborted();
      // The home has been set up. Keep its new credentials while they save.
      saving.current = true;
      setPending("save");
      const stored = await rememberSignIn(
        props.host,
        signedIn,
        checked,
        signal,
      );
      signal.throwIfAborted();
      setPassword("");
      setClaimed({ stored, personId: signedIn.person.id });
    } catch (error) {
      if (signal.aborted) return;
      saving.current = false;
      setProblem({ text: problemText(error) });
      setPending(undefined);
    }
  };

  if (claimed) {
    return (
      <SaveRecovery
        personId={claimed.personId}
        person={name.trim()}
        username={normaliseUsername(username)}
        onContinue={() => props.onClaimed(claimed.stored)}
      />
    );
  }

  const problemLine = (field: CredentialProblem["field"]) =>
    problem && problem.field === field ? (
      <SheetProblem id={problemId}>{problem.text}</SheetProblem>
    ) : null;

  if (step === 1) {
    return (
      <Sheet
        key="sign-in"
        step={{ at: 1, of: 2 }}
        title="Set up your home"
        subtitle="You’re the first person in this home. Your password never leaves this device."
        back={{ to: "Homes", onBack: props.onBack }}
      >
        <form className="flex flex-col gap-5" onSubmit={next}>
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
            revealable
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            hint="At least 8 characters."
            problemId={about("password")}
            required
          />
          {problemLine("password")}
          <SheetActions>
            <Button
              variant="default"
              size="lg"
              type="submit"
              className="mt-3 w-full"
            >
              Continue
            </Button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  return (
    <Sheet
      key="person"
      step={{ at: 2, of: 2 }}
      title="Your name and colour"
      subtitle="People at home know you by your name and colour."
      back={{
        disabled: pending === "save",
        onBack: () => {
          if (saving.current) return;
          attempt.cancel();
          setPending(undefined);
          setProblem(undefined);
          setStep(1);
        },
      }}
    >
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="flex justify-center">
          <Avatar name={name} colour={colour} size="xl" />
        </div>
        <SheetField
          label="Your name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          maxLength={60}
          readOnly={working}
          required
          ref={focusVisibleName}
        />
        <ColourPicker
          legend="Your colour"
          name="colour"
          value={colour}
          onChange={setColour}
          disabled={working}
          surface="var(--carbon)"
        />
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

// On a short screen, leave focus to the sheet's heading so the logo and
// heading stay in place when this step opens.
function focusVisibleName(field: HTMLInputElement | null) {
  const scroll = field?.closest(".sheet-scroll");
  if (!field || !scroll) return;
  const { top, bottom } = field.getBoundingClientRect();
  const bounds = scroll.getBoundingClientRect();
  if (top >= bounds.top && bottom <= bounds.bottom) {
    field.focus({ preventScroll: true });
  }
}
