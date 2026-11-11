import type { DeviceHistory } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  daysOf,
  midnight,
  spansOf,
  type Day,
} from "../src/device-history-data";
import {
  motionSentence,
  motionSpans,
  motionSpanText,
  motionWeekHeadline,
  spanTimes,
} from "../src/motion-history-data";

// A motion sensor's Motion page: its day as spans of motion, quiet and
// nothing known, and its week as motion time a day, from core History.

const minute = 60_000;
const hour = 60 * minute;
// 15:00 where the tests run, so local midnight is as far back in any zone.
const now = new Date(2026, 9, 31, 15, 0).getTime();
const from = now - 24 * hour;

function history(
  states: [number, "online" | "offline", object | null][],
): Pick<DeviceHistory, "kind" | "states"> {
  return {
    kind: "occupancy",
    states: states.map(([at, availability, state]) => ({
      at: new Date(at).toISOString(),
      availability,
      state: state as Record<string, unknown> | null,
    })),
  };
}

describe("a motion sensor's day", () => {
  const day = spansOf(
    history([
      [from - hour, "online", { occupied: false }],
      [from + hour, "online", { occupied: true, sensitivity: "medium" }],
      // Its settings changed during the motion.
      [
        from + hour + 10 * minute,
        "online",
        { occupied: true, sensitivity: "high" },
      ],
      [from + 2 * hour, "online", { occupied: false, sensitivity: "high" }],
      [from + 5 * hour, "offline", { occupied: false, sensitivity: "high" }],
      [from + 6 * hour, "online", { occupied: false, sensitivity: "high" }],
      [now - 2 * hour - 4 * minute, "online", { occupied: true }],
      [now - 2 * hour + 30 * minute, "online", { occupied: false }],
    ]),
    from,
    now,
  );

  it("is motion as on, however its settings changed meanwhile", () => {
    const spans = motionSpans(day);
    expect(
      spans.map((span) => [(span.from - from) / minute, motionSpanText(span)]),
    ).toEqual([
      [0, "No motion"],
      [60, "Motion"],
      [120, "No motion"],
      [300, "Offline"],
      [360, "No motion"],
      [1316, "Motion"],
      [1350, "No motion"],
    ]);
    expect(spanTimes(spans[1]!, now)).toBe("16:00–17:00");
    expect(spanTimes(spans.at(-1)!, now)).toBe("13:30–now");
  });

  it("says how long there was motion, and when the last ended", () => {
    expect(motionSentence(day, from, now)).toBe(
      "1 h 34 min of motion, the last at 13:30",
    );
  });

  it("says since when while there is motion now", () => {
    const moving = spansOf(
      history([
        [from - hour, "online", { occupied: false }],
        [now - 25 * minute, "online", { occupied: true }],
        // A settings report must not restart the current motion span.
        [now - 5 * minute, "online", { occupied: true, sensitivity: "high" }],
      ]),
      from,
      now,
    );
    expect(motionSentence(moving, from, now)).toBe(
      "25 min of motion, this time since 14:35",
    );
  });

  it("says when there was none, or nothing was heard", () => {
    const quiet = spansOf(
      history([[from - hour, "online", { occupied: false }]]),
      from,
      now,
    );
    expect(motionSentence(quiet, from, now)).toBe(
      "No motion in the last 24 hours",
    );
    expect(motionSentence([], from, now)).toBe(
      "Nothing read in the last 24 hours",
    );
  });
});

describe("a motion sensor's week", () => {
  it("counts motion from the hourly roll-ups of occupied", () => {
    const start = new Date(midnight(now, 1) + 9 * hour).toISOString();
    const days = daysOf(
      {
        fields: {
          occupied: [{ start, mean: 0.5, min: 0, max: 1, seconds: 3600 }],
        },
      },
      [],
      now,
      "occupied",
    );
    expect(days.at(-2)).toEqual({
      start: midnight(now, 1),
      on: 1800,
      known: 3600,
    });
  });

  const week = (on: (number | null)[]): Day[] =>
    on.map((seconds, index) => ({
      start: midnight(now, 6 - index),
      on: seconds ?? 0,
      known: seconds === null ? 0 : 86_400,
    }));

  it("says about how long a day, over the days that have ended", () => {
    expect(
      motionWeekHeadline(
        week([2, 5.8, 6.4, 5.9, 6.6, 4.2, 1].map((h) => h * 3600)),
        now,
      ),
    ).toBe("About 5 h a day");
    expect(
      motionWeekHeadline(week([null, null, null, null, null, 2400, 0]), now),
    ).toBe("About 40 min a day");
    expect(
      motionWeekHeadline(week([null, null, null, null, null, 20, 0]), now),
    ).toBe("Under a minute a day");
  });

  it("says today's until a day has ended, or since when there has been none", () => {
    expect(
      motionWeekHeadline(
        week([null, null, null, null, null, null, 45 * 60]),
        now,
      ),
    ).toBe("45 min today");
    expect(motionWeekHeadline(week([0, 0, 0, 0, 0, 0, 0]), now)).toBe(
      "No motion all week",
    );
    expect(
      motionWeekHeadline(week([null, null, null, null, null, null, 0]), now),
    ).toBe("No motion today");
    expect(motionWeekHeadline(week(Array(7).fill(null)), now)).toBe(
      "Not known yet",
    );
  });
});
