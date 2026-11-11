import {
  Button,
  icons,
  PageBar,
  type PageProps,
  PageSection,
  tileIconOf,
} from "@meetsanctum/ui-sdk";

import { byStart, formatMinute, holds, minuteIn } from "../schedules/times.js";
import { roomLights } from "./mood-draft";
import { motionLine } from "./motion-words";
import { useNow } from "./schedule-sections";
import type { RoomSchedule } from "./schedules";
import { useMoodsApp } from "./state";

// Moods' own page, which the app overview opens on every device: every room
// with lights, what its schedule holds now or next, how many moods it has
// and what motion does, each opening Moods' page for the room. A room's
// schedule is reached from here, and from the room page's Edit. Rooms and
// their lights are the shell's, in the sidebar.

// The scheduled mood holding now, else the next to start, by name.
function scheduleWords(
  schedule: RoomSchedule | undefined,
  names: ReadonlyMap<string, string>,
  minute: number,
) {
  const scheduled = byStart(schedule?.scheduled ?? []);
  const now = scheduled.find((span) => holds(span, minute));
  if (now) {
    return {
      moodId: now.moodId,
      words: `${names.get(now.moodId) ?? "A mood"} until ${formatMinute(now.end)}`,
    };
  }
  const next = scheduled.find((span) => span.start > minute) ?? scheduled[0];
  if (!next) return null;
  return {
    moodId: next.moodId,
    words: `${names.get(next.moodId) ?? "A mood"} at ${formatMinute(next.start)}`,
  };
}

const count = (moods: number) =>
  moods === 0 ? "No moods yet" : moods === 1 ? "1 mood" : `${moods} moods`;

export function MainPage(props: PageProps) {
  const { devices, places, moods, schedules, motion } = useMoodsApp();
  const now = useNow();
  const rooms = (places?.rooms ?? []).filter(
    (room) => roomLights(devices, room.id).length > 0,
  );
  const minute = places ? minuteIn(now, places.home.timeZone) : 0;
  return (
    <>
      <PageBar title="Moods" />
      <PageSection
        id="rooms-heading"
        title="Rooms"
        hint="Their moods, schedules and how their lights turn on"
      >
        {rooms.length === 0 ? (
          <p className="m-0 px-2.5 py-2 text-[15px] leading-[22px] text-muted-foreground">
            Rooms with lights show here. Rooms and their lights are set up in
            Settings.
          </p>
        ) : (
          rooms.map((room) => {
            const own = (moods.moods ?? []).filter(
              (mood) => mood.roomId === room.id,
            );
            const schedule = schedules.of(room.id);
            const held = scheduleWords(
              schedule,
              new Map(own.map((mood) => [mood.id, mood.name])),
              minute,
            );
            const mood = held && own.find((each) => each.id === held.moodId);
            const Icon = mood ? tileIconOf[mood.icon] : null;
            const line = [
              held?.words ?? (own.length > 0 ? "No schedule" : null),
              count(own.length),
              schedule?.turnOn === "asTheyWere"
                ? "Turns on as they were"
                : null,
              motionLine(motion.of(room.id)),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Button
                variant="row"
                size="row"
                key={room.id}
                type="button"
                onClick={() => props.open("room", { placeId: room.id })}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-[6px] bg-foreground/8">
                  <icons.House aria-hidden="true" className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] leading-5 font-medium">
                    {room.name}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
                    {Icon && (
                      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{line}</span>
                  </span>
                </span>
                <icons.ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Button>
            );
          })
        )}
      </PageSection>
    </>
  );
}
