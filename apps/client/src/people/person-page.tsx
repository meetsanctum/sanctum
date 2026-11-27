import type {
  ChangePerson,
  ClientInfo,
  PersonInfo,
  RemoveLogin,
  RemovePerson,
} from "@meetsanctum/auth-protocol";
import {
  Button,
  Input,
  PageBar,
  useHomeClock,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import { useEffect, useId, useState, type FormEvent } from "react";

import { ColourPicker } from "../colour-picker";
import { Avatar, BackButton, Row, Section } from "../components";
import { CoreError, coreJson } from "../core-fetch";
import { Confirm, type Asking } from "./confirm";
import {
  devicesOf,
  holdsLastSignIn,
  signInOf,
  usePeople,
  type SignIn,
} from "./data";
import {
  agentsGoText,
  firstName,
  signsOutText,
  untilText,
  usedText,
} from "./words";

// A person's page in Settings → People: their name and colour, how they
// sign in, the devices signed in as them, and at its foot removing them.
// Removing a sign-in or a person signs their devices out at once, so each
// asks first, naming what ends. The core keeps someone who signs in, and
// the page says so before anyone presses.

const label = "text-[13px] leading-[18px] font-medium text-muted-foreground";

const tryAgain = "That didn't work. Try again.";

export function PersonPage(props: {
  live: LiveFeed;
  personId: string;
  back: () => void;
  backTo?: string;
}) {
  const { data, failed, refresh } = usePeople(props.live, true);
  const [asking, setAsking] = useState<Asking>();
  const [saving, setSaving] = useState(false);
  const person = data?.people.find((each) => each.id === props.personId);
  const { back } = props;

  // Removed here or elsewhere: the page has nothing left to show.
  const gone = !!data && !person;
  useEffect(() => {
    if (gone) back();
  }, [gone, back]);

  const bar = (
    <PageBar
      title={person?.name ?? ""}
      leading={<BackButton to={props.backTo} onBack={back} />}
    />
  );
  const loadError = failed && (
    <div className="flex shrink-0 flex-col items-start gap-2">
      <p role="alert" className="m-0 text-sm text-destructive">
        {data
          ? "The details shown here may be out of date."
          : "This page can't be shown now."}
      </p>
      <Button variant="outline" onClick={() => void refresh()}>
        Retry
      </Button>
    </div>
  );
  if (!data || !person)
    return (
      <>
        {bar}
        {loadError}
      </>
    );

  const signIn = signInOf(data, person.id);
  const devices = devicesOf(data.clients, person.id);
  const isLast = holdsLastSignIn(data, person.id);
  const done = async () => {
    await refresh();
  };

  function askRemoval(
    snapshot: NonNullable<typeof data>,
    target: PersonInfo,
    kind: "sign-in" | "person",
    trigger: HTMLButtonElement,
  ) {
    const signIn = signInOf(snapshot, target.id);
    const devices = devicesOf(snapshot.clients, target.id);
    const name = firstName(target.name);
    const removePerson = kind === "person";
    const codeEnds =
      signIn.state === "signs-in" && signIn.resetEndsAt
        ? "The password code stops working."
        : signIn.state === "invited" && removePerson
          ? "The invite code stops working."
          : null;
    setAsking({
      title: removePerson
        ? `Remove ${target.name}?`
        : `Remove ${target.name}’s sign-in?`,
      description: [
        removePerson
          ? signIn.state === "signs-in" && `${name}’s sign-in ends.`
          : `${name} stays in People.`,
        signsOutText(devices),
        codeEnds,
        removePerson && agentsGoText(snapshot.agents, target),
        removePerson && `To add ${name} again, use Add a person.`,
      ]
        .filter(Boolean)
        .join(" "),
      confirm: removePerson ? "Remove" : "Remove sign-in",
      trigger,
      run: async () => {
        if (removePerson) {
          await coreJson("/api/people/remove", {
            method: "POST",
            json: { id: target.id } satisfies RemovePerson,
          });
        } else {
          await coreJson("/api/auth/logins/remove", {
            method: "POST",
            json: { personId: target.id } satisfies RemoveLogin,
          });
        }
        await done();
      },
      problem: (error) => lastSignInProblem(target, error),
    });
  }

  return (
    <>
      {bar}
      {loadError}
      <NameAndColour
        // A change saved elsewhere starts the fields afresh.
        key={`${person.name}|${person.colour}`}
        person={person}
        working={saving}
        onWorkingChange={setSaving}
        onSaved={done}
      />
      <SignInCard
        person={person}
        signIn={signIn}
        isLast={isLast}
        stale={failed}
        onRemove={(trigger) => askRemoval(data, person, "sign-in", trigger)}
      />
      {(signIn.state === "signs-in" || devices.length > 0) && (
        <Devices
          person={person}
          devices={devices}
          stale={failed}
          onSignOut={(client, trigger) =>
            setAsking({
              title: `Sign out ${client.name}?`,
              description: `${firstName(person.name)} signs in again to use it.`,
              confirm: "Sign out",
              trigger,
              run: async () => {
                await coreJson("/api/auth/clients/revoke", {
                  method: "POST",
                  json: { id: client.id },
                });
                await done();
              },
              problem: () => tryAgain,
            })
          }
        />
      )}
      <div className="flex shrink-0 flex-col items-start gap-2">
        <Button
          variant="destructive"
          disabled={isLast || failed}
          aria-describedby={isLast ? `${person.id}-last` : undefined}
          onClick={(event) =>
            askRemoval(data, person, "person", event.currentTarget)
          }
        >
          Remove {person.name}
        </Button>
      </div>
      <Confirm asking={asking} onClose={() => setAsking(undefined)} />
    </>
  );
}

function lastSignInProblem(person: PersonInfo, error: unknown) {
  return error instanceof CoreError && error.code === "last_login"
    ? `${person.name} is the only person who signs in, so this sign-in stays.`
    : tryAgain;
}

function NameAndColour(props: {
  person: PersonInfo;
  working: boolean;
  onWorkingChange: (working: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const ids = useId();
  const { person, working } = props;
  const [name, setName] = useState(person.name);
  const [colour, setColour] = useState(person.colour);
  const [problem, setProblem] = useState<string>();
  const trimmed = name.trim();
  const changes: Omit<ChangePerson, "id"> = {
    ...(trimmed !== person.name && { name: trimmed }),
    ...(colour !== person.colour && { colour }),
  };
  const unchanged = Object.keys(changes).length === 0;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (working || !trimmed || unchanged) return;
    props.onWorkingChange(true);
    setProblem(undefined);
    try {
      await coreJson<PersonInfo>("/api/people/update", {
        method: "POST",
        json: { id: person.id, ...changes } satisfies ChangePerson,
      });
      await props.onSaved();
    } catch {
      setProblem(tryAgain);
    } finally {
      props.onWorkingChange(false);
    }
  };

  return (
    <Section id={`${ids}-name-and-colour`} title="Name and Colour">
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="flex items-end gap-4">
          <span className="mb-0.5">
            <Avatar name={name} colour={colour} size="lg" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <label htmlFor={`${ids}-name`} className={label}>
              Name
            </label>
            <Input
              id={`${ids}-name`}
              value={name}
              maxLength={60}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setProblem(undefined);
              }}
              className="bg-background"
              disabled={working}
              required
            />
          </div>
        </div>
        <ColourPicker
          legend="Colour"
          name={`${ids}-colour`}
          value={colour}
          onChange={(value) => {
            setColour(value);
            setProblem(undefined);
          }}
          surface="var(--card)"
          disabled={working}
        />
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
        <Button
          type="submit"
          className="self-start"
          disabled={working || !trimmed || unchanged}
        >
          Save
        </Button>
      </form>
    </Section>
  );
}

function SignInCard(props: {
  person: PersonInfo;
  signIn: SignIn;
  isLast: boolean;
  stale: boolean;
  onRemove: (trigger: HTMLButtonElement) => void;
}) {
  const clock = useHomeClock();
  const { signIn, person } = props;
  const noteId = `${person.id}-last`;
  return (
    <Section id={`${person.id}-sign-in`} title="Sign-In">
      {signIn.state === "signs-in" ? (
        <div className="flex flex-col gap-3">
          {signIn.resetEndsAt ? (
            <Row
              title={`Signs in as ${signIn.username}`}
              detail={`Password code works until ${untilText(clock, signIn.resetEndsAt)}`}
            />
          ) : (
            <p className="m-0 text-sm">Signs in as {signIn.username}</p>
          )}
          <Button
            variant="outline"
            className="self-start"
            disabled={props.isLast || props.stale}
            aria-describedby={props.isLast ? noteId : undefined}
            onClick={(event) => props.onRemove(event.currentTarget)}
          >
            Remove sign-in
          </Button>
          {props.isLast && (
            <p id={noteId} className={`m-0 ${label}`}>
              {person.name} is the only person who signs in, so this sign-in
              stays.
            </p>
          )}
        </div>
      ) : (
        <p className="m-0 text-sm">{signInText(clock, signIn)}</p>
      )}
    </Section>
  );
}

function signInText(
  clock: ReturnType<typeof useHomeClock>,
  signIn: Exclude<SignIn, { state: "signs-in" }>,
) {
  switch (signIn.state) {
    case "invited":
      return `Invite works until ${untilText(clock, signIn.endsAt)}`;
    case "invite-ended":
      return signIn.ended === "cancelled"
        ? "The code was cancelled."
        : "The code ran out.";
    case "none":
      return "Doesn't sign in";
  }
}

function Devices(props: {
  person: PersonInfo;
  devices: ClientInfo[];
  stale: boolean;
  onSignOut: (client: ClientInfo, trigger: HTMLButtonElement) => void;
}) {
  const clock = useHomeClock();
  return (
    <Section id={`${props.person.id}-devices`} title="Devices">
      {props.devices.length === 0 ? (
        <p className={`m-0 ${label}`}>
          No device is signed in as {firstName(props.person.name)}.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {props.devices.map((client) => (
            <li key={client.id} className="flex items-center gap-3">
              <Row title={client.name} detail={usedText(clock, client)} />
              {/* Signing out of this device is in the account menu. */}
              {!client.current && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ms-auto"
                  aria-label={`Sign out ${client.name}`}
                  disabled={props.stale}
                  onClick={(event) =>
                    props.onSignOut(client, event.currentTarget)
                  }
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
