import type {
  ChangePerson,
  ClientInfo,
  InviteInfo,
  Me,
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
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ColourPicker } from "../colour-picker";
import { Avatar, BackButton, Row, Section } from "../components";
import { CoreError, coreJson } from "../core-fetch";
import { platformNames } from "../platforms";
import { ChangePassword } from "./change-password";
import { Confirm, type Asking } from "./confirm";
import { InviteDialog, type Inviting } from "./invite-dialog";
import { cancelInvite } from "./invites";
import { SignInCard } from "./sign-in-card";
import { devicesOf, holdsLastSignIn, signInOf, usePeople } from "./data";
import { agentsGoText, firstName, signsOutText, usedText } from "./words";

// A person's page in Settings → People: their name and colour, how they
// sign in, the devices signed in as them, and at its foot removing their
// sign-in or them, each with a line on what it does. Removing either signs
// their devices out at once, so each asks first, naming what ends. The core
// keeps the home's last sign-in, and the page says so before anyone
// presses. On your own page, on a device signed in as you, Change password
// takes Reset password's place.

const label = "text-[13px] leading-[18px] font-medium text-muted-foreground";

const tryAgain = "That didn't work. Try again.";

export function PersonPage(props: {
  live: LiveFeed;
  personId: string;
  // Who this device is signed in as, if anyone.
  me?: Me;
  // Just added: asks whether they will sign in, once.
  ask?: boolean;
  back: () => void;
  backTo?: string;
}) {
  const { data, failed, refresh } = usePeople(props.live, true);
  const [asking, setAsking] = useState<Asking>();
  const [inviting, setInviting] = useState<Inviting>();
  const [saving, setSaving] = useState(false);
  const [changing, setChanging] = useState(false);
  // Shown beside Password until the page is left.
  const [changed, setChanged] = useState(false);
  const changeTrigger = useRef<HTMLButtonElement>(null);
  const person = data?.people.find((each) => each.id === props.personId);
  const { back } = props;

  // A person just added: whether they will sign in, asked once.
  const asked = useRef(false);
  useEffect(() => {
    if (!props.ask || asked.current || !person) return;
    asked.current = true;
    setInviting({ person, kind: "invite", ask: true });
  }, [props.ask, person]);

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
  const own =
    props.me?.client.kind === "personal" && props.me.person?.id === person.id;
  const done = async () => {
    await refresh();
  };
  const askCancelCode = (code: InviteInfo, trigger: HTMLButtonElement) => {
    const reset = code.kind === "reset";
    setAsking({
      title: reset ? "Cancel password code?" : "Cancel invite?",
      description: `The ${reset ? "password" : "invite"} code stops working.`,
      confirm: reset ? "Cancel code" : "Cancel invite",
      trigger,
      run: async () => {
        try {
          await cancelInvite(code.personId, code.id);
        } finally {
          await done();
        }
      },
      problem: (error) =>
        error instanceof CoreError &&
        (error.code === "invite_changed" || error.code === "not_found")
          ? "This code is no longer active. Close this to see the current details."
          : tryAgain,
    });
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
      signIn.state === "signs-in" && signIn.reset
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
        own={own}
        changed={changed}
        stale={failed}
        changeTrigger={changeTrigger}
        onChangePassword={() => setChanging(true)}
        onInvite={(kind) =>
          setInviting({
            person,
            kind,
            replacesInviteId:
              kind === "invite" && signIn.state === "invited"
                ? signIn.invite.id
                : undefined,
          })
        }
        onCancelCode={askCancelCode}
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
      <Removals
        person={person}
        own={own}
        signsIn={signIn.state === "signs-in"}
        hasDevices={devices.length > 0}
        isLast={isLast}
        stale={failed}
        onRemove={(kind, trigger) => askRemoval(data, person, kind, trigger)}
      />
      <Confirm asking={asking} onClose={() => setAsking(undefined)} />
      {own && signIn.state === "signs-in" && (
        <ChangePassword
          open={changing}
          onOpenChange={setChanging}
          username={signIn.username}
          trigger={changeTrigger}
          onChanged={() => setChanged(true)}
        />
      )}
      <InviteDialog
        inviting={inviting}
        onClose={() => setInviting(undefined)}
        onRefresh={() => void refresh()}
      />
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

// At the page's foot, what removes: the sign-in, while there is one, and
// the person. Each says what it does under it; the home's last sign-in
// keeps both dimmed in place, with why.
function Removals(props: {
  person: PersonInfo;
  own: boolean;
  signsIn: boolean;
  hasDevices: boolean;
  isLast: boolean;
  stale: boolean;
  onRemove: (kind: "sign-in" | "person", trigger: HTMLButtonElement) => void;
}) {
  const { person, own, isLast } = props;
  const name = firstName(person.name);
  const noteId = `${person.id}-last`;
  const signOut = own
    ? "Your devices sign out at once."
    : `${name}’s devices sign out at once.`;
  const removal = (
    kind: "sign-in" | "person",
    action: string,
    description: string,
  ) => (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="destructive"
        disabled={isLast || props.stale}
        aria-describedby={isLast ? noteId : `${person.id}-remove-${kind}`}
        onClick={(event) => props.onRemove(kind, event.currentTarget)}
      >
        {action}
      </Button>
      {!isLast && (
        <p id={`${person.id}-remove-${kind}`} className={`m-0 ${label}`}>
          {description}
        </p>
      )}
    </div>
  );
  return (
    <div className="flex shrink-0 flex-col items-start gap-6">
      {props.signsIn &&
        removal(
          "sign-in",
          "Remove sign-in",
          [
            own
              ? "You stay in People but can’t sign in."
              : `${name} stays in People but can’t sign in.`,
            props.hasDevices && signOut,
          ]
            .filter(Boolean)
            .join(" "),
        )}
      {removal(
        "person",
        `Remove ${person.name}`,
        props.hasDevices
          ? `${own ? "You leave" : `${name} leaves`} People, and ${own ? "your" : `${name}’s`} devices sign out at once.`
          : `${own ? "You leave" : `${name} leaves`} People.`,
      )}
      {isLast && (
        <p id={noteId} className={`m-0 ${label}`}>
          {person.name} is the only person who signs in, so this sign-in stays.
        </p>
      )}
    </div>
  );
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
              <Row
                title={client.name}
                detail={`${platformNames[client.platform]} · ${usedText(clock, client)}`}
              />
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
