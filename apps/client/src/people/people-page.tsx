import type { Me, PersonInfo } from "@meetsanctum/auth-protocol";
import { Button, useHomeClock } from "@meetsanctum/ui-sdk";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { productName } from "../brand";
import { Avatar, Section } from "../components";
import { AddPerson } from "./add-person";
import { signInOf, usePeople } from "./data";
import { signInLine } from "./words";

// Settings → People: everyone in the household, each with a line on how
// they sign in, opening their own page. Adding a person is the bar's one
// action. A shared tablet sees the same list; on a personal device, its
// person's row says You.

export function PeoplePage(props: {
  // The way back to Settings.
  page: ReactNode;
  me?: Me;
  onOpen: (personId: string) => void;
}) {
  const clock = useHomeClock();
  const { data, failed, refresh } = usePeople();
  const [adding, setAdding] = useState(false);
  const you = props.me?.client.kind === "personal" ? props.me.person?.id : null;
  const people = data?.people ?? [];

  return (
    <>
      <Section
        id="settings-people"
        title="People"
        page={props.page}
        hideBody={!data && !failed}
        action={<Button onClick={() => setAdding(true)}>Add a person</Button>}
      >
        {data ? (
          <ul className="m-0 -mx-2.5 -my-2 flex list-none flex-col p-0">
            {people.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                you={person.id === you}
                line={signInLine(clock, signInOf(data, person.id))}
                onOpen={() => props.onOpen(person.id)}
              />
            ))}
          </ul>
        ) : (
          <p role="alert" className="m-0 text-sm text-destructive">
            People can't be shown now. Try again in a moment.
          </p>
        )}
      </Section>
      {data && (
        <p className="m-0 shrink-0 px-1 text-[13px] leading-[18px] font-medium text-muted-foreground">
          {people.length <= 1
            ? "Add the people who live here. They can sign in on their own phone or computer."
            : `Everyone who lives here. People who sign in can use ${productName} on their own phone or computer.`}
        </p>
      )}
      <AddPerson
        open={adding}
        onOpenChange={setAdding}
        taken={people.map((person) => person.colour)}
        onAdded={(person) => {
          void refresh();
          props.onOpen(person.id);
        }}
      />
    </>
  );
}

function PersonRow(props: {
  person: PersonInfo;
  you: boolean;
  line: string;
  onOpen: () => void;
}) {
  const { person } = props;
  return (
    <li>
      <Button
        variant="row"
        size="row"
        type="button"
        onClick={props.onOpen}
        aria-label={`${person.name}${props.you ? ", you" : ""}: ${props.line}`}
      >
        <Avatar name={person.name} colour={person.colour} />
        <span className="flex min-w-0 flex-col gap-px leading-tight">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium">{person.name}</span>
            {props.you && (
              <span className="shrink-0 text-[13px] font-medium text-muted-foreground">
                You
              </span>
            )}
          </span>
          <span className="truncate text-[13px] font-medium text-muted-foreground">
            {props.line}
          </span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className="ms-auto size-4 shrink-0 text-muted-foreground"
        />
      </Button>
    </li>
  );
}
