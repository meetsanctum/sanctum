import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import {
  Button,
  icons,
  tileIconOf,
  type LucideIcon,
} from "@meetsanctum/ui-sdk";
import type { ReactNode } from "react";

import type { PressChoice, PressPlace } from "../presses/presses.js";
import type { Mood } from "./mood-draft";
import { placeLabel, pressVerbs, verbsFor, verbsNote } from "./press-words";

// A press's own page in a remote's detail: what it does, from lists with one
// checkmark, each applying at once: nothing, something to lights, or a mood.
// Which lights opens a page of its own; the verbs below it do their thing to
// those lights, and a hold's brighten and dim while it lasts.

export const sameChoice = (a: PressChoice | null, b: PressChoice | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** A header with Back, as the pages within a remote's detail have. */
export function PageHeader(props: {
  back: string;
  title: string;
  id: string;
  onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" onClick={props.onBack}>
        <icons.ChevronLeft aria-hidden="true" />
        <span className="max-w-40 truncate">{props.back}</span>
      </Button>
      <h2
        id={props.id}
        className="m-0 min-w-0 truncate text-xl leading-7 font-normal"
      >
        {props.title}
      </h2>
    </div>
  );
}

export function Heading(props: { children: ReactNode; id?: string }) {
  return (
    <h3
      id={props.id}
      className="m-0 px-1 text-[13px] leading-[18px] font-medium text-(--silver)"
    >
      {props.children}
    </h3>
  );
}

export function Note(props: { children: ReactNode }) {
  return (
    <p className="m-0 px-1 text-[15px] leading-5 text-(--silver)">
      {props.children}
    </p>
  );
}

/** One option of a list with one checkmark, or a checkbox among several. */
export function OptionRow(props: {
  label: string;
  detail?: string;
  icon?: LucideIcon;
  checked: boolean;
  role?: "radio" | "checkbox";
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <Button
      variant="option"
      size="option"
      type="button"
      role={props.role ?? "radio"}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{props.label}</span>
        {props.detail && (
          <span className="truncate text-[15px] leading-5 text-(--silver)">
            {props.detail}
          </span>
        )}
      </span>
      {props.checked && (
        <icons.Check
          aria-hidden="true"
          className="size-5 shrink-0 text-(--light-blue)"
        />
      )}
    </Button>
  );
}

export function ChoicePage(props: {
  device: DeviceInfo;
  title: string;
  hold: boolean;
  // What the press does now, by choice or by default.
  choice: PressChoice;
  // Which lights the verbs are for.
  place: PressPlace;
  places: Places | undefined;
  devices: readonly DeviceInfo[];
  moods: readonly Mood[];
  problem: string | null;
  isSaving: boolean;
  onBack: () => void;
  onChoose: (choice: PressChoice) => void;
  onWhichLights: () => void;
}) {
  const { device, places, choice } = props;
  const room = places?.rooms.find((each) => each.id === device.roomId);
  // The remote's room's moods first, then the other rooms'.
  const rooms = [...(places?.rooms ?? [])].sort(
    (a, b) => Number(b.id === room?.id) - Number(a.id === room?.id),
  );
  const moodGroups = rooms.flatMap((each) => {
    const moods = props.moods.filter((mood) => mood.roomId === each.id);
    return moods.length > 0 ? [{ room: each, moods }] : [];
  });
  const option = (key: string, label: string, chosen: PressChoice) => (
    <OptionRow
      key={key}
      label={label}
      checked={sameChoice(chosen, choice)}
      disabled={props.isSaving}
      onClick={() => props.onChoose(chosen)}
    />
  );

  return (
    <section aria-labelledby="press-heading" className="flex flex-col gap-5">
      <PageHeader
        back="Presses"
        title={props.title}
        id="press-heading"
        onBack={props.onBack}
      />
      <div role="radiogroup" aria-labelledby="press-heading">
        {option("nothing", "Nothing", { kind: "nothing" })}
      </div>
      <section
        aria-labelledby="lights-heading"
        className="flex flex-col gap-1.5"
      >
        <Heading id="lights-heading">Lights</Heading>
        <Button
          variant="option"
          size="option"
          type="button"
          onClick={props.onWhichLights}
        >
          <span className="shrink-0">Which lights</span>
          <span className="ms-auto min-w-0 truncate text-(--silver)">
            {placeLabel(props.place, places, props.devices)}
          </span>
          <icons.ChevronRight
            aria-hidden="true"
            className="size-[18px] shrink-0 text-(--pewter)"
          />
        </Button>
        <div
          role="radiogroup"
          aria-labelledby="lights-heading"
          className="mt-1.5 flex flex-col gap-1"
        >
          {verbsFor(props.hold).map((to) =>
            option(to, pressVerbs[to], {
              kind: "lights",
              place: props.place,
              to,
            }),
          )}
        </div>
        <div className="mt-1">
          <Note>{verbsNote(props.hold)}</Note>
        </div>
      </section>
      {moodGroups.length > 0 && (
        <section
          aria-labelledby="moods-heading"
          className="flex flex-col gap-3"
        >
          <Heading id="moods-heading">Moods</Heading>
          {moodGroups.map(({ room: where, moods }) => (
            <div
              key={where.id}
              role="radiogroup"
              aria-label={`${where.name}'s moods`}
              className="flex flex-col gap-1.5"
            >
              <p className="m-0 px-1 text-[13px] leading-[18px] text-(--pewter)">
                {where.name}
              </p>
              {moods.map((mood) => (
                <OptionRow
                  key={mood.id}
                  label={mood.name}
                  icon={tileIconOf[mood.icon]}
                  checked={sameChoice(
                    { kind: "mood", moodId: mood.id },
                    choice,
                  )}
                  disabled={props.isSaving}
                  onClick={() =>
                    props.onChoose({ kind: "mood", moodId: mood.id })
                  }
                />
              ))}
            </div>
          ))}
        </section>
      )}
      {props.problem && (
        <p className="m-0 px-1 text-[13px] font-medium text-(--danger)">
          {props.problem}
        </p>
      )}
    </section>
  );
}
