import { Button, icons, PageSection, tileIconOf } from "@meetsanctum/ui-sdk";
import { useEffect, useState, type ReactNode } from "react";

import {
  byStart,
  day,
  formatMinute,
  holds,
  minuteIn,
  nextFreeWindow,
  windowsOf,
} from "../schedules/times.js";
import type { TurnOnBehaviour } from "../schedules/store.js";
import type { Mood } from "./mood-draft";
import { spanWords, turnOnWords } from "./schedule-words";
import type { RoomSchedule } from "./schedules";

// The Schedule and Turning the lights on sections of Moods' page for a
// room: the room's day as a bar, with a row for each scheduled mood and one
// to schedule another, and the two ways its lights may turn on, with what
// turning them on brings now. They are the household's, so they are the same
// on every device.

/** The time, kept to the minute while a page shows it. */
export function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A row's icon in a rounded square, as Moods' rows start. */
export function Squircle(props: { children: ReactNode }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-[6px] bg-foreground/8 [&_svg]:size-4">
      {props.children}
    </span>
  );
}

function RowText(props: { name: string; line: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-[15px] leading-5 font-medium">
        {props.name}
      </span>
      <span className="truncate text-[13px] leading-[18px] text-muted-foreground">
        {props.line}
      </span>
    </span>
  );
}

const percent = (minute: number) => `${(minute / day) * 100}%`;

/**
 * The room's day from midnight to midnight: each scheduled mood where it
 * holds, the one holding now in the ink, and where it is now. The rows
 * under it say the same in words, for a screen reader too.
 */
export function DayBar(props: {
  scheduled: RoomSchedule["scheduled"];
  moods: ReadonlyMap<string, Mood>;
  minute: number;
}) {
  const { scheduled, moods, minute } = props;
  const summary = scheduled.length
    ? scheduled
        .map(
          (span) =>
            `${moods.get(span.moodId)?.name ?? "A mood"} ${spanWords(span)}`,
        )
        .join(", ")
    : "Nothing scheduled";
  return (
    <div className="flex flex-col gap-1.5 px-2.5 pt-2.5 pb-3">
      <div
        role="img"
        aria-label={`${summary}. Now ${formatMinute(minute)}.`}
        className="relative h-11 overflow-hidden rounded-sm bg-foreground/5"
      >
        {scheduled.flatMap((span) => {
          const mood = moods.get(span.moodId);
          const Icon = mood ? tileIconOf[mood.icon] : icons.Sparkles;
          const now = holds(span, minute);
          return windowsOf(span).map((part) => (
            <span
              key={`${span.id}-${part.start}`}
              style={{
                left: `calc(${percent(part.start)} + 1px)`,
                width: `calc(${percent(part.end - part.start)} - 2px)`,
              }}
              className={`absolute inset-y-0 flex items-center gap-1.5 overflow-hidden rounded-[6px] px-2 text-[13px] leading-[18px] font-medium whitespace-nowrap ${
                now
                  ? "bg-foreground text-background"
                  : "bg-foreground/12 text-foreground"
              }`}
            >
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              {mood?.name}
            </span>
          ));
        })}
        <span
          aria-hidden="true"
          style={{ left: percent(minute) }}
          className="absolute inset-y-0 -ms-px w-0.5 bg-background"
        />
      </div>
      <div
        aria-hidden="true"
        className="relative h-[18px] text-[13px] leading-[18px] text-muted-foreground tabular-nums"
      >
        <span className="absolute start-0">00:00</span>
        <span className="absolute start-1/4 -translate-x-1/2 max-sm:hidden">
          06:00
        </span>
        <span className="absolute start-1/2 -translate-x-1/2">12:00</span>
        <span className="absolute start-3/4 -translate-x-1/2 max-sm:hidden">
          18:00
        </span>
        <span className="absolute end-0">24:00</span>
      </div>
    </div>
  );
}

/** A room's schedule: its day, its scheduled moods and a way to add one. */
export function ScheduleSection(props: {
  schedule: RoomSchedule;
  moods: readonly Mood[];
  timeZone: string;
  now: Date;
  open: (id?: string) => void;
}) {
  const { schedule, now } = props;
  const minute = minuteIn(now, props.timeZone);
  const moods = new Map(props.moods.map((mood) => [mood.id, mood]));
  const scheduled = byStart(schedule.scheduled);
  const free = nextFreeWindow(scheduled);
  return (
    <div className="flex flex-col gap-2">
      <PageSection id="schedule-heading" title="Schedule" hint="Every day">
        <DayBar scheduled={scheduled} moods={moods} minute={minute} />
        {scheduled.map((span) => {
          const mood = moods.get(span.moodId);
          const Icon = mood ? tileIconOf[mood.icon] : icons.Sparkles;
          return (
            <Button
              variant="row"
              size="row"
              key={span.id}
              type="button"

              onClick={() => props.open(span.id)}
            >
              <Squircle>
                <Icon aria-hidden="true" />
              </Squircle>
              <RowText name={mood?.name ?? "A mood"} line={spanWords(span)} />
              {holds(span, minute) && (
                <span className="shrink-0 text-[13px] leading-[18px] font-medium">
                  Now
                </span>
              )}
              <icons.ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Button>
          );
        })}
        <Button
          variant="row"
          size="row"
          type="button"

          disabled={!free || props.moods.length === 0}
          onClick={() => props.open()}
        >
          <Squircle>
            <icons.Plus aria-hidden="true" />
          </Squircle>
          <RowText
            name="Schedule a mood"
            line={
              props.moods.length === 0
                ? "Make a mood first"
                : free
                  ? `${spanWords(free)} is free`
                  : "The day is full"
            }
          />
        </Button>
      </PageSection>
      <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
        Each comes on at its start if one of the room&apos;s lights is on.
        Between them, the lights are left as they are.
      </p>
    </div>
  );
}

const choices: {
  value: TurnOnBehaviour;
  name: string;
  line: string;
  icon: typeof icons.CalendarClock;
}[] = [
  {
    value: "followSchedule",
    name: "Follow the schedule",
    line: "Or the lights that were on",
    icon: icons.CalendarClock,
  },
  {
    value: "asTheyWere",
    name: "Exactly as they were",
    line: "Even during a scheduled mood",
    icon: icons.RotateCcw,
  },
];

/** How the room's lights turn on, and what that brings now. */
export function TurnOnSection(props: {
  schedule: RoomSchedule;
  moods: readonly Mood[];
  lightName: (light: { device: string; capability: string }) => string;
  timeZone: string;
  now: Date;
  onChoose: (turnOn: TurnOnBehaviour) => void;
}) {
  const { schedule, now, timeZone } = props;
  const words = turnOnWords({
    schedule,
    moodNames: new Map(props.moods.map((mood) => [mood.id, mood.name])),
    lightName: props.lightName,
    minute: minuteIn(now, timeZone),
    now,
    timeZone,
  });
  return (
    <div className="flex flex-col gap-2">
      <PageSection id="turn-on-heading" title="Turning the lights on">
        <div
          role="radiogroup"
          aria-labelledby="turn-on-heading"
          className="flex flex-col gap-0.5"
        >
          {choices.map((choice) => {
            const chosen = schedule.turnOn === choice.value;
            return (
              <Button
                variant="row"
                size="row"
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={chosen}

                onClick={() => {
                  if (!chosen) props.onChoose(choice.value);
                }}
              >
                <Squircle>
                  <choice.icon aria-hidden="true" />
                </Squircle>
                <RowText name={choice.name} line={choice.line} />
                {chosen && (
                  <icons.Check
                    aria-hidden="true"
                    className="size-5 shrink-0 text-(--action)"
                  />
                )}
              </Button>
            );
          })}
        </div>
      </PageSection>
      <p
        aria-live="polite"
        className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground"
      >
        {words}
      </p>
    </div>
  );
}
