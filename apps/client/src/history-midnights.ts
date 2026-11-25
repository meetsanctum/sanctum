import type { DeviceHistory, DeviceStatistics } from "@meetsanctum/app-sdk";
import { startOfDay } from "@meetsanctum/app-sdk/clock";

import { coreJson } from "./core-fetch";
import { hourMs, type MidnightStates } from "./device-history-data";

/** Recorded changes for the rolled-up hours that the home's midnight splits. */
export async function loadMidnightStates(
  timeZone: string,
  statistics: DeviceStatistics,
  recent?: DeviceHistory,
): Promise<MidnightStates> {
  if (!statistics.kept) return new Map();
  const to = Date.parse(statistics.to);
  const splitHours = new Set<number>();
  for (let back = 6; back >= 0; back--) {
    const midnight = startOfDay(to, timeZone, back);
    if (midnight % hourMs !== 0) {
      splitHours.add(Math.floor(midnight / hourMs) * hourMs);
    }
  }
  if (splitHours.size === 0) return new Map();
  const recorded = new Set(
    Object.values(statistics.fields).flatMap((hours) =>
      hours.map((hour) => Date.parse(hour.start)),
    ),
  );
  const entries = await Promise.all(
    [...splitHours]
      .filter((start) => recorded.has(start))
      .map(async (start) => {
        const end = start + hourMs;
        if (
          recent &&
          Date.parse(recent.from) <= start &&
          Date.parse(recent.to) >= end
        ) {
          // Keep the state in effect at the start, as the history route does.
          const { states, kind } = recent;
          let last = states.length;
          while (last > 0 && Date.parse(states[last - 1]!.at) >= end) last--;
          let first = last;
          while (first > 0) {
            first--;
            if (Date.parse(states[first]!.at) <= start) break;
          }
          return [start, { kind, states: states.slice(first, last) }] as const;
        }
        const query = new URLSearchParams({
          device: statistics.device,
          capability: statistics.capability,
          from: new Date(start).toISOString(),
          to: new Date(end).toISOString(),
        });
        return [
          start,
          await coreJson<DeviceHistory>(`/api/history/states?${query}`),
        ] as const;
      }),
  );
  return new Map(entries);
}
