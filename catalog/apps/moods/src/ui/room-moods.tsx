import {
  Button,
  PageBar,
  icons,
  SectionTile,
  tileIconOf,
  useAppClient,
  type PageProps,
} from "@meetsanctum/ui-sdk";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { roomLights, type Mood } from "./mood-draft";
import { MotionSection } from "./motion-section";
import { ScheduleSection, TurnOnSection, useNow } from "./schedule-sections";
import { useMoodsApp } from "./state";

// Moods' page for a room, which Edit beside a room page's Moods heading
// opens, and Moods' main page, with { placeId }: the room's moods as tiles
// to drag into order (or move with the arrow keys) and to open in the mood
// editor, and New mood, which opens the editor on the lights as they are;
// then its schedule, how its lights turn on, and what motion does to them.
// Running a mood is the room page's, whose section the shell draws from
// Moods' mood entities. Moods are the household's, so the page is the same
// on every device.
// Everything is saved as it changes, so Done beside the title is the way
// out.

// How far a finger moves before a press becomes a drag, in px.
const dragAfter = 8;

type Drag = {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  active: boolean;
};

/** A room's moods, to order and edit, its schedule, how it turns on and what motion does. */
export function RoomMoodsPage(props: PageProps) {
  const client = useAppClient();
  const { devices, places, moods, schedules, motion } = useMoodsApp();
  const now = useNow();
  const { open, back } = props;
  const roomId = props.params.placeId ?? "";
  const room = places?.rooms.find((each) => each.id === roomId);
  // The mood a drag moves and the order so far, until the drag ends.
  const [moving, setMoving] = useState<{ id: string; ids: string[] } | null>(
    null,
  );
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);
  const tiles = useRef(new Map<string, HTMLButtonElement>());

  const own = (moods.moods ?? []).filter((mood) => mood.roomId === roomId);
  const byId = new Map(own.map((mood) => [mood.id, mood]));
  const shown = moving ? moving.ids.flatMap((id) => byId.get(id) ?? []) : own;
  const hasLights = roomLights(devices, roomId).length > 0;
  // A room removed meanwhile leaves its page.
  const gone = places !== undefined && !room;
  useEffect(() => {
    if (gone) back();
  }, [gone, back]);
  if (gone || !room || !places) return null;
  const schedule = schedules.of(roomId);
  const roomMotion = motion.of(roomId);
  const lightName = (light: { device: string }) =>
    devices.find((device) => device.id === light.device)?.name ?? "A light";
  const turnOn = (behaviour: "followSchedule" | "asTheyWere") =>
    void schedules.setTurnOn(roomId, behaviour).catch(() => undefined);

  const commit = (ids: string[]) => {
    if (ids.join() !== own.map((mood) => mood.id).join()) {
      void moods.order(roomId, ids).catch(() => undefined);
    }
  };
  const move = (id: string, by: number) => {
    const ids = own.map((mood) => mood.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + by));
    if (from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    commit(ids);
  };

  const editHandlers = (mood: Mood) => ({
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      dragged.current = false;
      if (event.isPrimary === false || event.button !== 0) return;
      drag.current = {
        id: mood.id,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        active: false,
      };
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const at = drag.current;
      if (!at || at.pointerId !== event.pointerId) return;
      if (!at.active) {
        if (
          Math.hypot(event.clientX - at.x, event.clientY - at.y) < dragAfter
        ) {
          return;
        }
        at.active = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setMoving({ id: at.id, ids: own.map((each) => each.id) });
      }
      // The tile under the finger makes room for the dragged one.
      for (const [id, element] of tiles.current) {
        if (id === at.id) continue;
        const box = element.getBoundingClientRect();
        if (
          event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom
        ) {
          setMoving((current) => {
            if (!current) return current;
            const ids = current.ids.filter((each) => each !== at.id);
            ids.splice(current.ids.indexOf(id), 0, at.id);
            return { ...current, ids };
          });
          break;
        }
      }
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const at = drag.current;
      if (!at || at.pointerId !== event.pointerId) return;
      drag.current = null;
      if (!at.active) return;
      dragged.current = true;
      if (moving) commit(moving.ids);
      setMoving(null);
    },
    onPointerCancel(event: PointerEvent<HTMLButtonElement>) {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      dragged.current = true;
      setMoving(null);
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      const by =
        event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : 0;
      if (by === 0) return;
      event.preventDefault();
      move(mood.id, by);
    },
  });

  return (
    <>
      <PageBar title={`${room.name} moods`}>
        <Button variant="outline" onClick={back}>
          Done
        </Button>
      </PageBar>
      <section
        aria-labelledby="moods-heading"
        className="flex shrink-0 flex-col gap-2"
      >
        <h2
          id="moods-heading"
          className="m-0 text-[15px] leading-[22px] font-medium"
        >
          Moods
        </h2>
        <div className="grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)">
          {shown.map((mood) => (
            <SectionTile
              key={mood.id}
              icon={tileIconOf[mood.icon]}
              name={mood.name}
              label={`Edit ${mood.name}`}
              editing
              dragging={moving?.id === mood.id}
              tileRef={(element) => {
                if (element) tiles.current.set(mood.id, element);
                else tiles.current.delete(mood.id);
              }}
              onClick={(event) => {
                // A drag that ends over the tile is not a tap. A click no
                // pointer made (detail 0), as from a key, always is.
                const moved = dragged.current;
                dragged.current = false;
                if (moved && event.detail > 0) return;
                open("mood", { room: roomId, id: mood.id });
              }}
              {...editHandlers(mood)}
            >
              <icons.GripVertical
                aria-hidden="true"
                className="relative size-4 shrink-0 opacity-65"
              />
            </SectionTile>
          ))}
          {hasLights && (
            <SectionTile
              icon={icons.Plus}
              name="New mood"
              onClick={() => open("mood", { room: roomId })}
            />
          )}
        </div>
        {own.length > 1 && (
          <p className="sr-only">
            Drag a mood, or use the arrow keys, to change its place.
          </p>
        )}
        {!hasLights && own.length === 0 && (
          <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            Moods set the room&apos;s lights, and it has none yet.
          </p>
        )}
      </section>
      {schedule && (
        <>
          <ScheduleSection
            schedule={schedule}
            moods={own}
            timeZone={places.home.timeZone}
            now={now}
            open={(id) =>
              open("scheduled", id ? { room: roomId, id } : { room: roomId })
            }
          />
          <TurnOnSection
            schedule={schedule}
            moods={own}
            lightName={lightName}
            timeZone={places.home.timeZone}
            now={now}
            onChoose={turnOn}
          />
          {roomMotion && (
            <MotionSection
              room={room}
              devices={devices}
              motion={roomMotion}
              unseen={{
                motion: !client.app.permissions.includes(
                  "devices.read:occupancy",
                ),
                light: !client.app.permissions.includes("devices.read:sensor"),
              }}
              ask={(permissions) => client.ask(permissions)}
              onChange={(change) =>
                void motion.change(roomId, change).catch(() => undefined)
              }
            />
          )}
        </>
      )}
    </>
  );
}
