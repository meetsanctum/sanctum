import { useAppClient } from "@meetsanctum/ui-sdk";
import { useCallback, useRef, useState } from "react";

import type {
  chooseTurnOn,
  listSchedules,
  RoomSchedule,
  scheduleMood,
  unscheduleMood,
} from "../schedules/actions.js";
import type { TurnOnBehaviour } from "../schedules/store.js";

// Every room's schedule and how its lights turn on, through Moods'
// actions, read again whenever the shell refreshes and after a mood is
// deleted, which takes it off its room's schedule. A change shows the
// room as the core answered it.

export type { RoomSchedule };

/** A mood to schedule, or one scheduled to change. */
export type ScheduledDraft = {
  id?: string;
  roomId: string;
  moodId: string;
  start: number;
  end: number;
};

export function useSchedules() {
  const client = useAppClient();
  const [schedules, setSchedules] = useState<RoomSchedule[]>();
  // Changes since a read began, which an older answer must not undo.
  const changes = useRef(0);

  const put = useCallback((schedule: RoomSchedule) => {
    changes.current += 1;
    setSchedules((current) =>
      current?.some((each) => each.roomId === schedule.roomId)
        ? current.map((each) =>
            each.roomId === schedule.roomId ? schedule : each,
          )
        : [...(current ?? []), schedule],
    );
    return schedule;
  }, []);

  const load = useCallback(async () => {
    const before = changes.current;
    const loaded = await client.call<typeof listSchedules>(
      "moods.schedules",
      {},
    );
    if (changes.current === before) setSchedules(loaded);
  }, [client]);

  const save = useCallback(
    async (draft: ScheduledDraft) =>
      put(await client.call<typeof scheduleMood>("moods.scheduleMood", draft)),
    [client, put],
  );

  const remove = useCallback(
    async (id: string) =>
      put(
        await client.call<typeof unscheduleMood>("moods.unscheduleMood", {
          id,
        }),
      ),
    [client, put],
  );

  const setTurnOn = useCallback(
    async (roomId: string, turnOn: TurnOnBehaviour) =>
      put(
        await client.call<typeof chooseTurnOn>("moods.setTurnOn", {
          roomId,
          turnOn,
        }),
      ),
    [client, put],
  );

  const of = useCallback(
    (roomId: string): RoomSchedule | undefined =>
      schedules?.find((each) => each.roomId === roomId),
    [schedules],
  );

  return { schedules, load, save, remove, setTurnOn, of };
}

export type Schedules = ReturnType<typeof useSchedules>;
