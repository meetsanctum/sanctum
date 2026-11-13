import {
  Button,
  icons,
  NativeSelect,
  NativeSelectOption,
  PageBar,
  PageSection,
  tileIconOf,
  type PageProps,
} from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  day,
  endsFrom,
  formatMinute,
  nextFreeWindow,
  spanAt,
  step,
  type Span,
} from "../schedules/times.js";
import type { Mood } from "./mood-draft";
import { lengthWords, spanWords } from "./schedule-words";
import type { RoomSchedule } from "./schedules";
import { useMoodsApp } from "./state";

// The editor of one of a room's scheduled moods, which a row of the room's
// schedule opens, with { room, id }, or Schedule a mood without an id: when,
// then which mood. A start another scheduled mood holds is dimmed and named
// in the From list, and To runs only up to the next one, past midnight, so
// two never overlap. A new one starts at the first free hour, with the
// first of the room's moods not yet scheduled. Cancel and Save are in the
// top bar; Remove from the schedule, at the foot, asks first.

const starts = Array.from({ length: day / step }, (_, index) => index * step);

// The end a span from a new start keeps: its length where it may, else
// the nearest it may.
function endFor(ends: readonly number[], start: number, length: number) {
  const wanted = (start + length) % day || day;
  return ends.includes(wanted)
    ? wanted
    : (ends[Math.min(ends.length, 4) - 1] ?? start);
}

function initial(
  schedule: RoomSchedule,
  moods: readonly Mood[],
  editing: RoomSchedule["scheduled"][number] | undefined,
) {
  if (editing) return editing;
  const free = nextFreeWindow(schedule.scheduled) ?? { start: 0, end: step };
  const scheduled = new Set(schedule.scheduled.map((each) => each.moodId));
  const mood = moods.find((each) => !scheduled.has(each.id)) ?? moods[0];
  return { ...free, moodId: mood?.id ?? "" };
}

export function ScheduledMoodPage(props: PageProps) {
  const { places, moods, schedules } = useMoodsApp();
  const { back } = props;
  const { room: roomId = "", id } = props.params;
  const room = places?.rooms.find((each) => each.id === roomId);
  const schedule = schedules.of(roomId);
  const editing = id
    ? schedule?.scheduled.find((each) => each.id === id)
    : undefined;
  const own = useMemo(
    () => (moods.moods ?? []).filter((mood) => mood.roomId === roomId),
    [moods.moods, roomId],
  );
  const left = useRef(false);
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    back();
  }, [back]);
  // A room, or a scheduled mood, removed meanwhile leaves the editor.
  const gone =
    (places !== undefined && !room) ||
    (id !== undefined && schedule !== undefined && !editing);
  useEffect(() => {
    if (gone) leave();
  }, [gone, leave]);
  if (gone || !room || !schedule || moods.moods === undefined) return null;
  if (id !== undefined && !editing) return null;
  return (
    <Editor
      key={id ?? "new"}
      roomName={room.name}
      schedule={schedule}
      moods={own}
      editing={editing}
      leave={leave}
    />
  );
}

function Editor(props: {
  roomName: string;
  schedule: RoomSchedule;
  moods: readonly Mood[];
  editing?: RoomSchedule["scheduled"][number];
  leave: () => void;
}) {
  const { schedule, moods, editing, leave } = props;
  const { schedules } = useMoodsApp();
  const [draft, setDraft] = useState(() => initial(schedule, moods, editing));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const others = schedule.scheduled.filter((each) => each.id !== editing?.id);
  const ends = endsFrom(others, draft.start);
  const mood = moods.find((each) => each.id === draft.moodId);
  const span: Span = { start: draft.start, end: draft.end };

  const pickStart = (start: number) => {
    const fits = endsFrom(others, start);
    const length = (draft.end - draft.start + day) % day || day;
    setDraft({ ...draft, start, end: endFor(fits, start, length) });
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await schedules.save({
        ...(editing && { id: editing.id }),
        roomId: schedule.roomId,
        ...draft,
      });
      leave();
    } catch {
      setError("It could not be saved. Try again.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    setBusy(true);
    setError(undefined);
    try {
      await schedules.remove(editing.id);
      leave();
    } catch {
      setError("It could not be taken off the schedule. Try again.");
      setBusy(false);
    }
  };

  // Where else each mood is scheduled, as its row says.
  const timesOf = (moodId: string) => {
    const times = others.filter((each) => each.moodId === moodId);
    return times.length
      ? times.map((each) => spanWords(each)).join(", ")
      : moodId === editing?.moodId
        ? "Scheduled here only"
        : "Not scheduled";
  };

  return (
    <>
      <PageBar title={editing ? "Scheduled mood" : "Schedule a mood"}>
        <Button variant="outline" onClick={leave} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => void save()}
          disabled={busy || !mood || !ends.includes(draft.end)}
        >
          Save
        </Button>
      </PageBar>
      <PageSection
        id="when-heading"
        title="When"
        hint={`Every day, in ${props.roomName}`}
      >
        <div className="flex flex-wrap gap-3 px-2.5 pt-1.5 pb-1">
          <label className="flex min-w-48 flex-1 flex-col gap-1.5">
            <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
              From
            </span>
            <NativeSelect
              className="w-full"
              value={String(draft.start)}
              onChange={(event) => pickStart(Number(event.target.value))}
            >
              {starts.map((start) => {
                const taken = spanAt(others, start);
                const by =
                  taken && moods.find((each) => each.id === taken.moodId);
                return (
                  <NativeSelectOption
                    key={start}
                    value={String(start)}
                    disabled={taken !== undefined}
                  >
                    {taken
                      ? `${formatMinute(start)} · ${by?.name ?? "Taken"}`
                      : formatMinute(start)}
                  </NativeSelectOption>
                );
              })}
            </NativeSelect>
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1.5">
            <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
              To
            </span>
            <NativeSelect
              className="w-full"
              value={String(draft.end)}
              onChange={(event) =>
                setDraft({ ...draft, end: Number(event.target.value) })
              }
            >
              {ends.map((end) => (
                <NativeSelectOption key={end} value={String(end)}>
                  {end <= draft.start && end !== day
                    ? `${formatMinute(end)}, next day`
                    : formatMinute(end)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        </div>
        <p className="m-0 px-2.5 pt-1 pb-2.5 text-[13px] leading-[18px] text-muted-foreground">
          {lengthWords(span)}
        </p>
      </PageSection>
      <PageSection
        id="mood-heading"
        title="Mood"
        hint={`${props.roomName}'s moods`}
      >
        <div
          role="radiogroup"
          aria-labelledby="mood-heading"
          className="flex flex-col gap-0.5"
        >
          {moods.map((each) => {
            const Icon = tileIconOf[each.icon];
            const chosen = each.id === draft.moodId;
            return (
              <Button
                variant="row"
                size="row"
                key={each.id}
                type="button"
                role="radio"
                aria-checked={chosen}
                onClick={() => setDraft({ ...draft, moodId: each.id })}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-[6px] bg-foreground/8">
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] leading-5 font-medium">
                    {each.name}
                  </span>
                  <span className="truncate text-[13px] leading-[18px] text-muted-foreground">
                    {timesOf(each.id)}
                  </span>
                </span>
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
      {mood && (
        <p className="m-0 shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
          At {formatMinute(draft.start)} {mood.name} comes on if one of the
          room&apos;s lights is on.
          {schedule.turnOn === "followSchedule" &&
            ` Until ${formatMinute(draft.end)}, turning the room's lights on brings ${mood.name}.`}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] font-medium text-(--danger)">
          {error}
        </p>
      )}
      {editing && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <span className="text-[13px] font-medium text-muted-foreground">
                Take {mood?.name ?? "it"} off the schedule?
              </span>
              <Button
                variant="destructive"
                onClick={() => void remove()}
                disabled={busy}
              >
                Remove
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Keep it
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setConfirming(true)}
              disabled={busy}
              className="-ms-2.5"
            >
              Remove from the schedule
            </Button>
          )}
        </div>
      )}
    </>
  );
}
