import type { DeviceHistory } from "@meetsanctum/app-sdk";
import { lightColour } from "@meetsanctum/ui-sdk";
import { describe, expect, it } from "vitest";

import {
  dayHeadline,
  daysOf,
  durationText,
  midnight,
  onWithin,
  spansOf,
  spanText,
  weekHeadline,
  type Day,
} from "../src/device-history-data";

// A device's History page: its last day as spans from core History's
// changes, and its week from the hourly roll-ups.

const minute = 60_000;
const hour = 60 * minute;
// 18:00 where the tests run, so local midnight is as far back in any zone.
const now = new Date(2026, 9, 30, 18, 0).getTime();
const from = now - 24 * hour;
const warm = {
  on: true,
  brightness: 40,
  colorMode: "temperature",
  colorTemperature: 450,
};

function history(
  states: [
    number,
    DeviceHistory["states"][number]["availability"],
    object | null,
  ][],
): Pick<DeviceHistory, "kind" | "states"> {
  return {
    kind: "light",
    states: states.map(([at, availability, state]) => ({
      at: new Date(at).toISOString(),
      availability,
      state: state as Record<string, unknown> | null,
    })),
  };
}

describe("a device's history", () => {
  it("makes spans from one change to the next, clipped to the day", () => {
    const spans = spansOf(
      history([
        [from - 3 * hour, "online", { ...warm, on: false }],
        [from + hour, "online", warm],
        [from + 2 * hour, "offline", warm],
      ]),
      from,
      now,
    );

    expect(spans).toEqual([
      {
        from,
        to: from + hour,
        known: true,
        offline: false,
        on: false,
        brightness: null,
        colour: "#ffffff",
      },
      {
        from: from + hour,
        to: from + 2 * hour,
        known: true,
        offline: false,
        on: true,
        brightness: 40,
        colour: lightColour(warm as never),
      },
      {
        from: from + 2 * hour,
        to: now,
        known: false,
        offline: true,
        on: false,
        brightness: null,
        colour: "#ffffff",
      },
    ]);
    expect(spans.map(spanText)).toEqual(["Off", "40%", "Offline"]);
    expect(spanText(undefined)).toBe("Not known");
  });

  it("carries what the device is now to the end, where it differs", () => {
    const recorded = history([[from + hour, "online", warm]]);

    expect(
      spansOf(recorded, from, now, [
        {
          availability: "online",
          state: warm,
          since: now - minute,
        },
      ]),
    ).toHaveLength(1);
    const spans = spansOf(recorded, from, now, [
      {
        availability: "online",
        state: { ...warm, on: false },
        since: now - 10 * minute,
      },
    ]);
    expect(spans.map((span) => [span.from, span.to, span.on])).toEqual([
      [from + hour, now - 10 * minute, true],
      [now - 10 * minute, now, false],
    ]);
  });

  it("counts how long it was on out of how long it was known", () => {
    const spans = spansOf(
      history([
        [from, "online", warm],
        [from + 90 * minute, "online", { ...warm, on: false }],
        [from + 2 * hour, "unknown", null],
      ]),
      from,
      now,
    );

    expect(onWithin(spans, from, now)).toEqual({
      on: 90 * 60,
      known: 120 * 60,
    });
    expect(durationText(90 * 60)).toBe("1 h 30 min");
    expect(durationText(2 * 3600)).toBe("2 h");
    expect(durationText(45 * 60)).toBe("45 min");
    expect(durationText(20)).toBe("under a minute");
  });

  it("lets refreshed history replace older live changes and keeps newer ones", () => {
    const spans = spansOf(
      history([
        [from, "online", warm],
        [now - 10 * minute, "offline", warm],
        [now - 5 * minute, "online", warm],
      ]),
      from,
      now,
      [
        { availability: "offline", state: warm, since: now - 9 * minute },
        { availability: "online", state: warm, since: now - 4 * minute },
        {
          availability: "online",
          state: { ...warm, on: false },
          since: now - minute,
        },
      ],
    );
    expect(spans.map((span) => [span.from, span.to, spanText(span)])).toEqual([
      [from, now - 10 * minute, "40%"],
      [now - 10 * minute, now - 5 * minute, "Offline"],
      [now - 5 * minute, now - minute, "40%"],
      [now - minute, now, "Off"],
    ]);
  });

  it("makes each of the last 7 days from the hours, and since the last hour from the spans", () => {
    const today = midnight(now);
    const yesterdayNoon = midnight(now, 1) + 12 * hour;
    // The last hour rolled up ended an hour ago; the light has been on
    // since two hours ago.
    const spans = spansOf(
      history([[now - 2 * hour, "online", warm]]),
      from,
      now,
    );
    const days = daysOf(
      {
        fields: {
          on: [
            {
              start: new Date(yesterdayNoon).toISOString(),
              mean: 0.5,
              min: 0,
              max: 1,
              seconds: 3600,
            },
            {
              start: new Date(now - 2 * hour).toISOString(),
              mean: 1,
              min: 1,
              max: 1,
              seconds: 3600,
            },
          ],
        },
      },
      spans,
      now,
    );

    expect(days).toHaveLength(7);
    expect(days.map((day) => day.start)).toEqual(
      [6, 5, 4, 3, 2, 1, 0].map((back) => midnight(now, back)),
    );
    expect(days.at(-1)!.start).toBe(today);
    expect(days.at(-2)).toMatchObject({ on: 1800, known: 3600 });
    expect(days.at(-1)).toMatchObject({ on: 7200, known: 7200 });
    expect(days[0]).toMatchObject({ on: 0, known: 0 });
  });

  it("says what the day and the week come to, and since when it is off once history begins", () => {
    const on = spansOf(history([[from + hour, "online", warm]]), from, now);
    expect(dayHeadline(on, from, now)).toBe("On for 23 h");
    const off = spansOf(
      history([[now - 25 * minute, "online", { ...warm, on: false }]]),
      from,
      now,
    );
    expect(dayHeadline(off, from, now)).toMatch(/^Off since \d\d:\d\d$/);
    expect(dayHeadline([], from, now)).toBe("Not known yet");

    const week = (values: [number, number][]): Day[] =>
      values.map(([on, known], index) => ({
        start: midnight(now, 6 - index),
        on,
        known,
      }));
    // Today, with 4 hours on so far, does not count.
    expect(
      weekHeadline(
        week([
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
          [3600, 86400],
          [4 * 3600, 3600 * 5],
        ]),
        now,
      ),
    ).toBe("1 h a day");
    // Until a day has ended, today is all there is.
    expect(
      weekHeadline(week([...Array(6).fill([0, 0]), [2 * 3600, 3 * 3600]]), now),
    ).toBe("On for 2 h today");
    expect(
      weekHeadline(week([...Array(6).fill([0, 86400]), [3600, 3600]]), now),
    ).toBe("On for 1 h today");
    expect(weekHeadline(week(Array(7).fill([0, 86400])), now)).toBe(
      "Off all week",
    );
    expect(weekHeadline(week([...Array(6).fill([0, 0]), [0, 600]]), now)).toBe(
      "Off today",
    );
    expect(weekHeadline(week([...Array(7).fill([20, 86400])]), now)).toBe(
      "Under a minute a day",
    );
  });

  it("shares an hour that local midnight splits between its two days", () => {
    const today = midnight(now);
    const days = daysOf(
      {
        fields: {
          on: [
            {
              start: new Date(today - 30 * minute).toISOString(),
              mean: 1,
              min: 1,
              max: 1,
              seconds: 3600,
            },
          ],
        },
      },
      [],
      now,
    );

    expect(days.at(-2)).toMatchObject({ on: 1800, known: 1800 });
    expect(days.at(-1)!.on).toBeGreaterThanOrEqual(1800);
  });
});
