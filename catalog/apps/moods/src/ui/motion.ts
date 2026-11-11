import { useAppClient } from "@meetsanctum/ui-sdk";
import { useCallback, useRef, useState } from "react";

import type { listMotion, setMotion } from "../motion/actions.js";
import {
  stillRoom,
  type MotionChange,
  type RoomMotion,
} from "../motion/room-motion.js";

// What motion does to every room's lights, through Moods' actions, read
// again whenever the shell refreshes. A change shows the room as the core
// answered it. Once read, a room added since does nothing with motion, as
// every room starts.

export type { MotionChange, RoomMotion };

export function useMotion() {
  const client = useAppClient();
  const [rooms, setRooms] = useState<RoomMotion[]>();
  // Changes since a read began, which an older answer must not undo.
  const changes = useRef(0);

  const load = useCallback(async () => {
    const before = changes.current;
    const loaded = await client.call<typeof listMotion>("moods.motion", {});
    if (changes.current === before) setRooms(loaded);
  }, [client]);

  const change = useCallback(
    async (roomId: string, change: MotionChange) => {
      const motion = await client.call<typeof setMotion>("moods.setMotion", {
        roomId,
        ...change,
      });
      changes.current += 1;
      setRooms((current) =>
        current?.some((each) => each.roomId === motion.roomId)
          ? current.map((each) =>
              each.roomId === motion.roomId ? motion : each,
            )
          : [...(current ?? []), motion],
      );
      return motion;
    },
    [client],
  );

  const of = useCallback(
    (roomId: string): RoomMotion | undefined =>
      rooms &&
      (rooms.find((each) => each.roomId === roomId) ?? stillRoom(roomId)),
    [rooms],
  );

  return { rooms, load, change, of };
}

export type Motion = ReturnType<typeof useMotion>;
