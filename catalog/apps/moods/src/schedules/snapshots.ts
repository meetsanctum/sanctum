import {
  captureLight,
  keyOf,
  type MoodLight,
  type MoodLightState,
} from "../moods/light-states.js";
import type { Light } from "../targets.js";

// The snapshot of a room's lights as they were when it went dark, which
// turning it on brings back. The core switches the lights off, as a
// remote, a workflow or a wall switch may, so Moods takes one from the
// lights themselves, which it follows anyway: the last light to go off and
// those switched off together with it, a few seconds apart at most, each
// with the look it had, and the room's other lights off.

/** How far apart lights may go off and still have gone off together. */
export const togetherMs = 5_000;

type Seen = { look: MoodLightState; offAt: number | null };

/** Follows rooms' lights, to take each room's snapshot as it goes dark. */
export function createSnapshots() {
  const rooms = new Map<string, Map<string, Seen>>();

  return {
    /**
     * Follows a room's lights as they are now, those a command can reach,
     * and gives the snapshot to keep when they have just all gone off;
     * null otherwise.
     */
    follow(
      roomId: string,
      lights: readonly Light[],
      now: number,
    ): MoodLight[] | null {
      const seen = rooms.get(roomId) ?? new Map<string, Seen>();
      rooms.set(roomId, seen);
      const present = new Set(lights.map(keyOf));
      for (const key of seen.keys()) {
        if (!present.has(key)) seen.delete(key);
      }
      let wentOff = false;
      for (const light of lights) {
        const key = keyOf(light);
        if (light.capability.state?.on === true) {
          seen.set(key, { look: captureLight(light.capability), offAt: null });
          continue;
        }
        const was = seen.get(key);
        if (was && was.offAt === null) {
          was.offAt = now;
          wentOff = true;
        }
      }
      if (!wentOff || lights.some((light) => light.capability.state?.on)) {
        return null;
      }
      const last = Math.max(
        ...[...seen.values()].map((each) => each.offAt ?? -Infinity),
      );
      return lights.map((light) => {
        const was = seen.get(keyOf(light));
        const together =
          was !== undefined &&
          was.offAt !== null &&
          last - was.offAt <= togetherMs;
        return {
          device: light.device.id,
          capability: light.capability.id,
          state: together ? was.look : { on: false },
        };
      });
    },

    /** Forgets a room, as when it is deleted. */
    forget(roomId: string) {
      rooms.delete(roomId);
    },
  };
}

export type Snapshots = ReturnType<typeof createSnapshots>;
