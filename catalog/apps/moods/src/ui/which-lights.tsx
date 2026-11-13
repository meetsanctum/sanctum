import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { useState } from "react";

import type { PressPlace } from "../presses/presses.js";
import { Heading, Note, OptionRow, PageHeader } from "./press-choice";
import {
  chosenLights,
  lightGroups,
  lightKey,
  lightOptions,
  lightsOf,
  type ChosenLight,
} from "./press-lights";
import { Button } from "@meetsanctum/ui-sdk";

// Which lights a press is for: the remote's room, a zone with it, all
// lights, or some lights, chosen from a list of the home's lights by room.
// A choice applies at once, as the press's own page does.

export function WhichLightsPage(props: {
  device: DeviceInfo;
  // The press's title, which Back goes to.
  back: string;
  place: PressPlace;
  places: Places | undefined;
  devices: readonly DeviceInfo[];
  // What the press does with the lights, as a sentence, and whether it
  // brightens or dims them.
  doing: string;
  dims: boolean;
  isSaving: boolean;
  problem: string | null;
  onBack: () => void;
  onPlace: (place: PressPlace) => Promise<boolean>;
}) {
  const { device, places, place } = props;
  const room = places?.rooms.find((each) => each.id === device.roomId);
  const zones = (places?.zones ?? []).filter(
    (zone) => room && zone.roomIds.includes(room.id),
  );
  // Some lights stays open with none chosen yet, which saves nothing.
  const [isPicking, setIsPicking] = useState(place.kind === "lights");
  const [picked, setPicked] = useState<ChosenLight[]>(() =>
    lightsOf(place, props.devices, places),
  );
  const [savedPlace, setSavedPlace] = useState(place);
  // A refresh can bring a choice made elsewhere. Reset the local picker
  // only when that choice changes, preserving an empty draft otherwise.
  if (JSON.stringify(savedPlace) !== JSON.stringify(place)) {
    setSavedPlace(place);
    setIsPicking(place.kind === "lights");
    setPicked(lightsOf(place, props.devices, places));
  }
  const isSome = isPicking || place.kind === "lights";
  const chosen = new Set(picked.map(lightKey));
  const groups = lightGroups(props.devices, places, device.roomId);

  const options: { key: string; label: string; place: PressPlace }[] = [
    ...(room
      ? [
          {
            key: `room:${room.id}`,
            label: room.name,
            place: { kind: "room", id: room.id } as const,
          },
        ]
      : []),
    ...zones.map((zone) => ({
      key: `zone:${zone.id}`,
      label: zone.name,
      place: { kind: "zone", id: zone.id } as const,
    })),
    { key: "home", label: "All lights", place: { kind: "home" } },
  ];
  // A saved room or zone stays visible if the remote has moved since.
  if (
    (place.kind === "room" || place.kind === "zone") &&
    !options.some((option) => option.key === `${place.kind}:${place.id}`)
  ) {
    const list = place.kind === "room" ? places?.rooms : places?.zones;
    options.push({
      key: `${place.kind}:${place.id}`,
      label: list?.find((each) => each.id === place.id)?.name ?? "Its room",
      place,
    });
  }
  const isChecked = (option: PressPlace) =>
    !isSome && JSON.stringify(option) === JSON.stringify(place);

  const choosePlace = async (next: PressPlace) => {
    if (!(await props.onPlace(next))) return;
    setIsPicking(next.kind === "lights");
    setPicked(lightsOf(next, props.devices, places));
  };
  const pick = (lights: ChosenLight[]) => {
    const next = chosenLights(lights);
    if (next.length === 0) setPicked(next);
    else void choosePlace({ kind: "lights", lights: next });
  };
  // Whether every light the press is for can dim.
  const covered = new Set(
    (isSome ? picked : lightsOf(place, props.devices, places)).map(lightKey),
  );
  const allDim = lightOptions(props.devices)
    .filter((light) => covered.has(lightKey(light)))
    .every((light) => light.canDim);

  return (
    <section aria-labelledby="which-heading" className="flex flex-col gap-5">
      <PageHeader
        back={props.back}
        title="Which lights"
        id="which-heading"
        onBack={props.onBack}
      />
      <div
        role="radiogroup"
        aria-labelledby="which-heading"
        className="flex flex-col gap-1"
      >
        {options.map((option) => (
          <OptionRow
            key={option.key}
            label={option.label}
            checked={isChecked(option.place)}
            disabled={props.isSaving}
            onClick={() => choosePlace(option.place)}
          />
        ))}
        <OptionRow
          label="Some lights"
          checked={isSome}
          disabled={props.isSaving}
          onClick={() => {
            if (picked.length > 0 && place.kind !== "lights") pick(picked);
            else setIsPicking(true);
          }}
        />
      </div>
      {isSome &&
        groups.map((group) => {
          const keys = group.lights.map(lightKey);
          const all = keys.every((key) => chosen.has(key));
          return (
            <section
              key={group.id}
              aria-labelledby={`lights-${group.id}`}
              className="flex flex-col gap-1.5"
            >
              <div className="flex items-center justify-between gap-3 text-[15px]">
                <Heading id={`lights-${group.id}`}>{group.name}</Heading>
                <Button
                  variant="link"
                  size="inline"
                  type="button"
                  disabled={props.isSaving}
                  onClick={() =>
                    pick(
                      all
                        ? picked.filter(
                            (light) => !keys.includes(lightKey(light)),
                          )
                        : [...picked, ...group.lights],
                    )
                  }
                >
                  {all ? "Deselect all" : "Select all"}
                </Button>
              </div>
              <div
                role="group"
                aria-labelledby={`lights-${group.id}`}
                className="flex flex-col gap-1"
              >
                {group.lights.map((light) => {
                  const key = lightKey(light);
                  return (
                    <OptionRow
                      key={key}
                      role="checkbox"
                      label={light.name}
                      detail={light.detail}
                      checked={chosen.has(key)}
                      disabled={props.isSaving}
                      onClick={() =>
                        pick(
                          chosen.has(key)
                            ? picked.filter((each) => lightKey(each) !== key)
                            : [...picked, light],
                        )
                      }
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      <Note>
        {isSome && picked.length === 0
          ? "Choose at least one light."
          : `${props.doing}.`}
        {props.dims && !allDim
          ? " Lights that can't dim are left alone when a press brightens or dims them."
          : ""}
      </Note>
      {props.problem && (
        <p className="m-0 px-1 text-[13px] font-medium text-(--danger)">
          {props.problem}
        </p>
      )}
    </section>
  );
}
