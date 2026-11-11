import type { Places } from "@meetsanctum/app-sdk";
import {
  Button,
  icons,
  type LiveFeed,
  type LucideIcon,
} from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { useEffect, useState } from "react";

import { coreJson } from "./core-fetch";
import { knotPath } from "./knot";
import type { Devices } from "./use-devices";

// Setting the home up, on the dashboard: while the home has no devices, the
// dashboard is a welcome and three steps, in any order: where it is, its
// rooms, and its lights, switches and remotes. The next step left is the one
// blue button; a step done says what it holds. Each opens Settings at its
// section, starting what it says. Once a device has joined, its tile takes
// the guide's place and the steps still left stay above the tiles until they
// are done. It is the same on every device, a shared one too: everyone may
// set the home up.

/** Where a step leads in Settings (its `open` param). */
export type SetupTarget = "add-room" | "add-devices" | "household";

type Step = {
  id: string;
  icon: LucideIcon;
  title: string;
  line: string;
  isDone: boolean;
  action: string;
  // An accessible name where the action alone says too little.
  label?: string;
  target: SetupTarget;
};

type Coordinates = { latitude: number; longitude: number };

// Where the home is: its coordinates, null while it has none, or undefined
// while that is not known, as when the core does not say.
function useHomeCoordinates(live: LiveFeed) {
  const [coordinates, setCoordinates] = useState<Coordinates | null>();
  useEffect(() => {
    let request = 0;
    const load = () => {
      const current = ++request;
      void coreJson<{ coordinates: Coordinates | null }>(
        "/api/places/home",
      ).then(
        (home) => current === request && setCoordinates(home.coordinates),
        () => current === request && setCoordinates(undefined),
      );
    };
    const unsubscribe = live.subscribe({
      refresh: load,
      message: (message) => {
        if (message.type === "places") load();
      },
    });
    load();
    return () => {
      request += 1;
      unsubscribe();
    };
  }, [live]);
  return coordinates;
}

/** Up to three names, then how many more: "Kitchen, Office, Hall and 2 more". */
export function someNames(names: string[]) {
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) {
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Coordinates as a place is written: "46.95° N, 7.45° E". */
export function placeOf({ latitude, longitude }: Coordinates) {
  const degrees = (value: number) => `${Math.abs(value).toFixed(2)}°`;
  return `${degrees(latitude)} ${latitude < 0 ? "S" : "N"}, ${degrees(longitude)} ${longitude < 0 ? "W" : "E"}`;
}

function stepsOf(
  places: Places,
  hasDevices: boolean,
  coordinates: Coordinates | null | undefined,
): Step[] {
  const rooms = places.rooms.map((room) => room.name);
  const steps: Step[] = [];
  // Where the home is comes first, the quickest step; it is left out while
  // it is not known whether the home has a location.
  if (coordinates !== undefined) {
    steps.push({
      id: "location",
      icon: icons.MapPin,
      title: "Set where the home is",
      line: coordinates
        ? placeOf(coordinates)
        : "For the weather, and lights that follow daylight",
      isDone: coordinates !== null,
      action: coordinates ? "Change" : "Set location",
      label: coordinates ? "Change where the home is" : undefined,
      target: "household",
    });
  }
  steps.push(
    {
      id: "rooms",
      icon: icons.DoorOpen,
      title: "Add your rooms",
      line:
        rooms.length > 0
          ? someNames(rooms)
          : "So each device is named after the room it’s in",
      isDone: rooms.length > 0,
      action: rooms.length > 0 ? "Add more" : "Add rooms",
      label: rooms.length > 0 ? "Add more rooms" : undefined,
      target: "add-room",
    },
    {
      id: "devices",
      icon: icons.Lightbulb,
      title: "Add lights, switches and remotes",
      line: "Set each to pairing mode, as its instructions say",
      isDone: hasDevices,
      action: "Add devices",
      target: "add-devices",
    },
  );
  return steps;
}

function StepRow(props: {
  step: Step;
  isNext: boolean;
  open: (target: SetupTarget) => void;
}) {
  const { step, open } = props;
  const Icon = step.isDone ? icons.Check : step.icon;
  return (
    <li className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-md py-3 ps-3 pe-3.5 max-[520px]:grid-cols-[40px_minmax(0,1fr)] max-[520px]:items-start">
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-full",
          step.isDone ? "bg-white text-(--carbon)" : "bg-white/12",
        )}
      >
        <Icon
          aria-hidden="true"
          className="size-5"
          strokeWidth={step.isDone ? 2.5 : 2}
        />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[15px] leading-[22px] font-medium">
          {step.title}
          {step.isDone && <span className="sr-only">, done</span>}
        </span>
        <span className="truncate text-[13px] leading-[18px] font-medium text-(--glass-secondary) max-[520px]:whitespace-normal">
          {step.line}
        </span>
      </span>
      <Button
        variant={props.isNext ? "default" : "glass"}
        size="chip"
        aria-label={step.label}
        onClick={() => open(step.target)}
        className="max-[520px]:col-start-2 max-[520px]:mt-2.5 max-[520px]:justify-self-start"
      >
        {step.action}
      </Button>
    </li>
  );
}

function Steps(props: { steps: Step[]; open: (target: SetupTarget) => void }) {
  const next = props.steps.find((step) => !step.isDone);
  return (
    <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
      {props.steps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          isNext={step === next}
          open={props.open}
        />
      ))}
    </ol>
  );
}

const glass =
  "rounded-lg bg-(--glass) p-1.5 text-(--glass-ink) shadow-[inset_0_0_0_1px_var(--glass-line)] backdrop-blur-[24px]";

// How many steps the guide shows, in words: two while it is not known whether
// the home has a location.
const counted = ["No", "One", "Two", "Three"];

/** The welcome and the steps, the dashboard's content while the home has no devices. */
export function SetupGuide(props: {
  devices: Devices;
  live: LiveFeed;
  /** The signed-in person's name; none on a shared device. */
  person: string | null;
  /** Opens a step in Settings. */
  open: (target: SetupTarget) => void;
}) {
  const coordinates = useHomeCoordinates(props.live);
  const { places } = props.devices;
  if (!places) return null;
  const steps = stepsOf(places, false, coordinates);
  return (
    <section
      aria-labelledby="setup-title"
      className="mx-auto my-auto flex w-full max-w-[560px] shrink-0 flex-col items-center gap-8 py-6 text-white"
    >
      <div className="flex flex-col items-center gap-5 text-center">
        <svg viewBox="0 0 14 14" aria-hidden="true" className="size-14">
          <path fill="currentColor" d={knotPath} />
        </svg>
        <div className="flex flex-col gap-1">
          <p className="m-0 text-[20px] leading-[26px] font-light text-white/80 max-[520px]:text-[17px] max-[520px]:leading-[22px]">
            {props.person ? `Welcome, ${props.person}` : "Welcome"}
          </p>
          <h1
            id="setup-title"
            className="m-0 text-[44px] leading-[50px] font-light tracking-[-0.02em] max-[520px]:text-[34px] max-[520px]:leading-[40px]"
          >
            Set up your home
          </h1>
        </div>
        <p className="m-0 max-w-[460px] text-[17px] leading-[27px] text-white/75 max-[520px]:text-[15px] max-[520px]:leading-[22px]">
          {`${counted[steps.length]} steps, in any order. Lights, switches and remotes then show here, room by room.`}
        </p>
      </div>
      <div className={cn(glass, "w-full")}>
        <Steps steps={steps} open={props.open} />
      </div>
    </section>
  );
}

/** The steps still left once a device has joined, above the dashboard's tiles; nothing once all are done. */
export function SetupLeft(props: {
  devices: Devices;
  live: LiveFeed;
  open: (target: SetupTarget) => void;
}) {
  const coordinates = useHomeCoordinates(props.live);
  const { places } = props.devices;
  if (!places) return null;
  const left = stepsOf(places, true, coordinates).filter(
    (step) => !step.isDone,
  );
  if (left.length === 0) return null;
  return (
    <section
      aria-labelledby="setup-left-title"
      className={cn(glass, "w-full max-w-[596px] shrink-0")}
    >
      <h2
        id="setup-left-title"
        className="m-0 px-3 pt-2 pb-0.5 text-[15px] leading-[22px] font-medium"
      >
        Finish setting up
      </h2>
      <Steps steps={left} open={props.open} />
    </section>
  );
}
