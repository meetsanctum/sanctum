import type { DeviceHistory } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  contactSentence,
  contactSpanText,
  contactWeekHeadline,
  doorWeekHeadline,
  openedTimes,
} from "../src/contact-history-data";
import {
  countedDays,
  daysOf,
  joinedSpans,
  midnight,
  spansOf,
  type Day,
} from "../src/device-history-data";

// A contact sensor's Contact page: its day as spans of open, closed and
// nothing known, and its week as time open a day, from core History.

const minute = 60_000;
const hour = 60 * minute;
// 15:00 where the tests run, so local midnight is as far back in any zone.
const now = new Date(2026, 9, 31, 15, 0).getTime();
const from = now - 24 * hour;
const at = (hours: number, minutes = 0) =>
  new Date(2026, 9, 31, hours, minutes).getTime();

function day(states: [number, "online" | "offline", object | null][]) {
  const history: Pick<DeviceHistory, "kind" | "states"> = {
    kind: "contact",
    states: states.map(([when, availability, state]) => ({
      at: new Date(when).toISOString(),
      availability,
      state: state as Record<string, unknown> | null,
    })),
  };
  return spansOf(history, from, now);
}

const closed = { open: false };
const open = { open: true };

describe("a contact sensor's day", () => {
  it("is open as on, closed as off, and not known while offline", () => {
    const spans = joinedSpans(
      day([
        [from - hour, "online", closed],
        [at(9, 5), "online", open],
        [at(9, 7), "online", closed],
        [at(12), "offline", closed],
        [at(12, 30), "online", closed],
      ]),
    );
    expect(spans.map(contactSpanText)).toEqual([
      "Closed",
      "Open",
      "Closed",
      "Offline",
      "Closed",
    ]);
  });

  it("counts its openings, how long they came to, and when it last opened", () => {
    const spans = day([
      [from - hour, "online", closed],
      [at(8), "online", open],
      [at(8, 4), "online", closed],
      [at(13, 52), "online", open],
      [at(13, 56), "online", closed],
    ]);
    expect(contactSentence(spans, from, now)).toBe(
      "Opened 2 times, 8 min in all, the last at 13:52",
    );
    expect(
      contactSentence(
        day([
          [from - hour, "online", closed],
          [at(13, 52), "online", open],
          [at(13, 56), "online", closed],
        ]),
        from,
        now,
      ),
    ).toBe("Opened once, 4 min in all, the last at 13:52");
  });

  it("says since when it is open now", () => {
    const spans = day([
      [from - hour, "online", closed],
      [at(8), "online", open],
      [at(9), "online", closed],
      [at(14, 35), "online", open],
    ]);
    expect(contactSentence(spans, from, now)).toBe(
      "Opened 2 times, 1 h 25 min in all, this time since 14:35",
    );
  });

  it("counts the first opening at the current instant before time has elapsed", () => {
    const spans = day([
      [from - hour, "online", closed],
      [now, "online", open],
    ]);
    expect(contactSentence(spans, from, now)).toBe(
      "Opened once, under a minute in all, this time since 15:00",
    );
  });

  it("does not count an opening it did not see", () => {
    // Already open when the day began: its time counts, not an opening.
    expect(
      contactSentence(
        day([
          [from - hour, "online", open],
          [at(8), "online", closed],
        ]),
        from,
        now,
      ),
    ).toBe("Open 17 h in all, until 08:00");
    // Open when it came back online: nobody saw it open.
    expect(
      contactSentence(
        day([
          [from - hour, "online", closed],
          [at(10), "offline", closed],
          [at(11), "online", open],
          [at(11, 30), "online", closed],
        ]),
        from,
        now,
      ),
    ).toBe("Open 30 min in all, until 11:30");
  });

  it("says when it was open the whole time", () => {
    expect(
      contactSentence(day([[from - hour, "online", open]]), from, now),
    ).toBe("Open the whole time");
  });

  it("keeps a brief closure in a day that was otherwise open", () => {
    expect(
      contactSentence(
        day([
          [from - hour, "online", open],
          [at(9), "online", closed],
          [at(9) + 30_000, "online", open],
        ]),
        from,
        now,
      ),
    ).toBe("Opened once, 24 h in all, this time since 09:00");
  });

  it("does not call a day with a brief gap open the whole time", () => {
    expect(
      contactSentence(
        day([
          [from - hour, "online", open],
          [at(9), "offline", open],
          [at(9) + 30_000, "online", open],
        ]),
        from,
        now,
      ),
    ).toBe("Open 24 h in all");
  });

  it("does not claim it stayed closed across even a brief gap", () => {
    for (const states of [
      [[from + 30_000, "online", closed]],
      [
        [from - hour, "online", closed],
        [at(9), "offline", closed],
        [at(9) + 30_000, "online", closed],
      ],
    ] satisfies Parameters<typeof day>[0][]) {
      expect(contactSentence(day(states), from, now)).toBe(
        "Not seen open in the last 24 hours",
      );
    }
  });

  it("says it was not opened only of a day it knows throughout", () => {
    expect(
      contactSentence(day([[from - hour, "online", closed]]), from, now),
    ).toBe("Not opened in the last 24 hours");
    expect(
      contactSentence(
        day([
          [from - hour, "online", closed],
          [at(10), "offline", closed],
          [at(11), "online", closed],
        ]),
        from,
        now,
      ),
    ).toBe("Not seen open in the last 24 hours");
    // It joined during the day: before that nothing is known.
    expect(contactSentence(day([[at(9), "online", closed]]), from, now)).toBe(
      "Not seen open in the last 24 hours",
    );
    expect(contactSentence(day([]), from, now)).toBe(
      "Nothing read in the last 24 hours",
    );
  });
});

describe("a contact sensor's week", () => {
  const week = (on: number[], known?: number[]): Day[] =>
    on.map((seconds, index) => {
      const start = midnight(now, on.length - 1 - index);
      return {
        start,
        on: seconds,
        known:
          known?.[index] ?? (Math.min(midnight(start, -1), now) - start) / 1000,
      };
    });

  it("says about how long it was open a day, over the days that have ended", () => {
    expect(
      contactWeekHeadline(week([2400, 2400, 2400, 2400, 2400, 2400, 0]), now),
    ).toBe("Open about 40 min a day");
    expect(
      contactWeekHeadline(week([7200, 7200, 7200, 7200, 7200, 7200, 0]), now),
    ).toBe("Open about 2 h a day");
  });

  it("says how long today until a day has ended, or that it was not opened", () => {
    expect(
      contactWeekHeadline(
        week([0, 0, 0, 0, 0, 0, 840], [0, 0, 0, 0, 0, 0, 3600]),
        now,
      ),
    ).toBe("Open for 14 min today");
    expect(contactWeekHeadline(week([0, 0, 0, 0, 0, 0, 0]), now)).toBe(
      "Not opened all week",
    );
    expect(
      contactWeekHeadline(
        week([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 3600]),
        now,
      ),
    ).toBe("Not seen open today");
    expect(
      contactWeekHeadline(
        week([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 15 * 3600]),
        now,
      ),
    ).toBe("Not opened today");
    expect(
      contactWeekHeadline(
        week([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]),
        now,
      ),
    ).toBe("Not known yet");
  });

  it("does not claim no openings across gaps in the week", () => {
    expect(
      contactWeekHeadline(week(Array(7).fill(0), Array(7).fill(3600)), now),
    ).toBe("Not seen open all week");
    const missingDay = week(Array(7).fill(0));
    missingDay[3]!.known = 0;
    expect(contactWeekHeadline(missingDay, now)).toBe(
      "Not seen open since Sun",
    );
  });

  it("reads how long it was open from the hourly roll-ups of open", () => {
    const yesterday = new Date(2026, 9, 30, 8).getTime();
    const days = daysOf(
      {
        fields: {
          open: [
            {
              start: new Date(yesterday).toISOString(),
              mean: 0.5,
              min: 0,
              max: 1,
              seconds: 3600,
            },
          ],
        },
      },
      [],
      now,
      "open",
    );
    expect(days.at(-2)).toMatchObject({ on: 1800, known: 3600 });
  });
});

describe("a door's week", () => {
  // Each day known throughout, with how often it was opened.
  const week = (counts: number[], known?: number[]): Day[] =>
    counts.map((count, index) => {
      const start = midnight(now, counts.length - 1 - index);
      return {
        start,
        on: count * 60,
        known:
          known?.[index] ?? (Math.min(midnight(start, -1), now) - start) / 1000,
        count,
      };
    });
  const online = (when: number, state: object) =>
    [when, "online", state] as [number, "online", object];
  // Its changes over the week, as spans from the week's first midnight.
  const spansOver = (states: [number, "online" | "offline", object | null][]) =>
    spansOf(
      {
        kind: "contact",
        states: states.map(([when, availability, state]) => ({
          at: new Date(when).toISOString(),
          availability,
          state: state as Record<string, unknown> | null,
        })),
      },
      midnight(now, 6),
      now,
    );
  const dayAt = (daysBack: number, hours: number, minutes = 0) =>
    midnight(now, daysBack) + hours * hour + minutes * minute;

  it("counts each opening on the day it opened, and none it did not see", () => {
    const spans = spansOver([
      online(dayAt(6, 0), closed),
      // Two days ago: opened twice, the second left open past midnight.
      online(dayAt(2, 8), open),
      online(dayAt(2, 8, 2), closed),
      online(dayAt(2, 23, 50), open),
      online(dayAt(1, 0, 10), closed),
      // Yesterday: once more. Then offline, and open when it came back.
      online(dayAt(1, 18), open),
      online(dayAt(1, 18, 1), closed),
      [dayAt(1, 20), "offline", null],
      online(dayAt(0, 7), open),
      online(dayAt(0, 7, 5), closed),
      online(dayAt(0, 9), open),
    ]);
    const counted = countedDays(week([0, 0, 0, 0, 0, 0, 0]), spans);
    expect(counted.map((each) => each.count)).toEqual([0, 0, 0, 0, 2, 1, 1]);
  });

  it("says about how often it was opened a day, over the days that have ended", () => {
    expect(doorWeekHeadline(week([6, 5, 7, 6, 6, 6, 2]), now)).toBe(
      "Opened about 6 times a day",
    );
    expect(doorWeekHeadline(week([1, 1, 2, 1, 1, 1, 0]), now)).toBe(
      "Opened about once a day",
    );
  });

  it("says how often in all while that is less than once a day", () => {
    expect(doorWeekHeadline(week([0, 1, 0, 0, 2, 0, 0]), now)).toBe(
      "Opened 3 times this week",
    );
    expect(doorWeekHeadline(week([0, 0, 0, 0, 0, 0, 1]), now)).toBe(
      "Opened once this week",
    );
    // Known only since yesterday, and only since today.
    expect(
      doorWeekHeadline(
        week([0, 0, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 3600]),
        now,
      ),
    ).toBe("Opened 2 times today");
  });

  it("says since when it was not opened, and only of days it knows throughout", () => {
    expect(doorWeekHeadline(week([0, 0, 0, 0, 0, 0, 0]), now)).toBe(
      "Not opened all week",
    );
    expect(
      doorWeekHeadline(
        week([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 3600]),
        now,
      ),
    ).toBe("Not seen open today");
    expect(
      doorWeekHeadline(week([0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]), now),
    ).toBe("Not known yet");
  });

  it("says a count as its column does", () => {
    expect(openedTimes(1)).toBe("Opened once");
    expect(openedTimes(4)).toBe("Opened 4 times");
  });
});
