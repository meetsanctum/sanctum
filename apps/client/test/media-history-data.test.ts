import type { DeviceHistory } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  daysOf,
  joinedSpans,
  midnight,
  spansOf,
  type Day,
} from "../src/device-history-data";
import {
  aboutDuration,
  mediaSentence,
  mediaSpanText,
  playedHeadline,
  playedWeekHeadline,
  poweredWithin,
} from "../src/media-history-data";

// A media player's History: its day as spans of playing, of on without
// playing where it has power, of the rest and of nothing known, and its
// week as time played a day, from core History, which keeps only `on` and
// `activity` of a player.

const minute = 60_000;
const hour = 60 * minute;
// 22:40 where the tests run, so local midnight is as far back in any zone.
const now = new Date(2026, 10, 23, 22, 40).getTime();
const from = now - 24 * hour;
const at = (hours: number, minutes = 0) =>
  new Date(2026, 10, 23, hours, minutes).getTime();

function day(states: [number, "online" | "offline", object | null][]) {
  const history: Pick<DeviceHistory, "kind" | "states"> = {
    kind: "media",
    states: states.map(([when, availability, state]) => ({
      at: new Date(when).toISOString(),
      availability,
      state: state as Record<string, unknown> | null,
    })),
  };
  return spansOf(history, from, now);
}

const playing = { on: true, activity: "playing" };
const onIdle = { on: true, activity: "idle" };
const onPaused = { on: true, activity: "paused" };
const off = { on: false, activity: "idle" };

// A TV box's evening: on at 19:30, playing 19:45–21:10, paused ten
// minutes, then playing to now; off the rest, until a show at 07:15.
const tvDay = () =>
  day([
    [from - hour, "online", off],
    [at(7, 10), "online", onIdle],
    [at(7, 15), "online", playing],
    [at(7, 35), "online", onIdle],
    [at(7, 40), "online", off],
    [at(19, 30), "online", onIdle],
    [at(19, 45), "online", playing],
    [at(21, 10), "online", onPaused],
    [at(21, 20), "online", playing],
  ]);

describe("a media player's day", () => {
  it("is playing as on, and on without playing where it has power", () => {
    const spans = joinedSpans(tvDay());
    expect(spans.map(mediaSpanText)).toEqual([
      "Off",
      "On",
      "Playing",
      "On",
      "Off",
      "On",
      "Playing",
      "On",
      "Playing",
    ]);
    expect(spans.map((span) => span.powered)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("joins being on whether it was idle or paused", () => {
    const spans = joinedSpans(
      day([
        [from - hour, "online", onIdle],
        [at(9), "online", onPaused],
      ]),
    );
    expect(spans).toHaveLength(1);
    expect(mediaSpanText(spans[0]!)).toBe("On");
  });

  it("says Not playing of a player without power, and nothing while offline", () => {
    const spans = joinedSpans(
      day([
        [from - hour, "online", { activity: "paused" }],
        [at(8), "online", { activity: "playing" }],
        [at(9), "offline", null],
      ]),
    );
    expect(spans.map(mediaSpanText)).toEqual([
      "Not playing",
      "Playing",
      "Offline",
    ]);
    expect(spans[0]!.powered).toBeUndefined();
  });

  it("comes to how long it played and, with power, how long it was on", () => {
    const spans = tvDay();
    // 20 min in the morning, 85 and 80 in the evening.
    expect(playedHeadline(spans, from, now)).toBe("Played 3 h 5 min");
    expect(poweredWithin(spans, from, now)).toBe((30 + 190) * 60);
    expect(mediaSentence(spans, [], from, now, true)).toBe("On for 3 h 40 min");
  });

  it("says nothing played, since when it is known", () => {
    expect(playedHeadline(day([[from - hour, "online", off]]), from, now)).toBe(
      "Nothing played",
    );
    expect(playedHeadline(day([[at(14, 20), "online", off]]), from, now)).toBe(
      "Nothing played since 14:20",
    );
    expect(playedHeadline([], from, now)).toBe("Not known yet");
  });

  it("says of a player with power that was never on that it was off", () => {
    expect(
      mediaSentence(day([[from - hour, "online", off]]), [], from, now, true),
    ).toBe("Off the whole time");
    expect(
      mediaSentence(day([[at(14, 20), "online", off]]), [], from, now, true),
    ).toBe("Off since 14:20");
  });

  it("omits the power summary when power is unknown", () => {
    const spans = day([
      [from - hour, "online", { activity: "idle" }],
      [at(17), "online", { activity: "playing" }],
    ]);
    expect(mediaSentence(spans, [], from, now, true)).toBeNull();
  });

  it("counts only the current stretch of reported off time", () => {
    const spans = day([
      [from - hour, "online", off],
      [at(12), "online", { activity: "idle" }],
      [at(14, 20), "online", off],
    ]);
    expect(mediaSentence(spans, [], from, now, true)).toBe("Off since 14:20");
  });

  describe("without power", () => {
    const idle = { activity: "idle" };
    const plays = { activity: "playing" };

    it("says since when it has been playing", () => {
      const spans = day([
        [from - hour, "online", idle],
        [at(21, 50), "online", plays],
      ]);
      expect(mediaSentence(spans, [], from, now, false)).toBe(
        "Playing since 21:50",
      );
      expect(
        mediaSentence(
          day([[from - hour, "online", plays]]),
          [],
          from,
          now,
          false,
        ),
      ).toBe("Playing the whole time");
    });

    it("says when it last played within the day", () => {
      const spans = day([
        [from - hour, "online", idle],
        [at(8, 5), "online", plays],
        [at(8, 50), "online", idle],
        [at(17, 10), "online", plays],
        [at(18), "online", idle],
      ]);
      expect(mediaSentence(spans, [], from, now, false)).toBe(
        "Last played 17:10–18:00",
      );
      expect(playedHeadline(spans, from, now)).toBe("Played 1 h 35 min");
    });

    it("says on which day it last played, from the week", () => {
      const spans = day([[from - hour, "online", idle]]);
      const days: Day[] = [6, 5, 4, 3, 2, 1, 0].map((back) => ({
        start: midnight(now, back),
        on: back === 3 ? 1200 : 0,
        known: 86_400,
      }));
      expect(mediaSentence(spans, days, from, now, false)).toBe(
        "Last played on Fri",
      );
      expect(
        mediaSentence(
          spans,
          days.map((each) => ({ ...each, on: 0 })),
          from,
          now,
          false,
        ),
      ).toBeNull();
    });
  });

  it("says since when it has been offline", () => {
    const spans = day([
      [from - hour, "online", playing],
      [at(20, 10), "offline", null],
    ]);
    expect(mediaSentence(spans, [], from, now, true)).toBe(
      "Offline since 20:10",
    );
    expect(mediaSentence(spans, [], from, now, false)).toBe(
      "Offline since 20:10",
    );
  });
});

describe("a media player's week", () => {
  const daysWith = (minutes: (number | null)[]) =>
    minutes.map((each, index) => {
      const back = 6 - index;
      const start = midnight(now, back);
      const end = back === 0 ? now : midnight(now, back - 1);
      return {
        start,
        on: (each ?? 0) * 60,
        known: each === null ? 0 : (end - start) / 1000,
      };
    });

  it("is how long it played a day, from the roll-ups of playing", () => {
    const days = daysOf(
      {
        fields: {
          playing: [
            {
              start: new Date(at(20) - 24 * hour).toISOString(),
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
      "playing",
    );
    expect(days.at(-2)!.on).toBe(1800);
  });

  it("comes to about how long a day over the days that have ended", () => {
    expect(
      playedWeekHeadline(daysWith([110, 0, 150, 190, 260, 165, 185]), now),
    ).toBe("Played about 2 h 25 min a day");
    expect(
      playedWeekHeadline(daysWith([null, null, null, null, null, 7, 30]), now),
    ).toBe("Played about 7 min a day");
  });

  it("shows today's play time when completed days have no playback", () => {
    const today = (minutes: number) =>
      daysWith([null, null, null, null, null, null, minutes]);
    expect(playedWeekHeadline(today(40), now)).toBe("Played 40 min today");
  });

  it("distinguishes a quiet week from a week with gaps", () => {
    const idle = daysWith([0, 0, 0, 0, 0, 0, 0]);
    expect(playedWeekHeadline(idle, now)).toBe("Nothing played all week");
    expect(
      playedWeekHeadline(
        idle.map((day) => ({ ...day, known: 60 })),
        now,
      ),
    ).toBe("No playback recorded");
    expect(playedWeekHeadline(daysWith([null, null, 0, 0, 0, 0, 0]), now)).toBe(
      "No playback recorded",
    );
    expect(playedWeekHeadline(daysWith(Array(7).fill(null)), now)).toBe(
      "Not known yet",
    );
  });

  it("rounds about how long to 5 minutes from 10 minutes", () => {
    expect(aboutDuration(20)).toBe("under a minute");
    expect(aboutDuration(7 * 60)).toBe("7 min");
    expect(aboutDuration(146 * 60)).toBe("2 h 25 min");
    expect(aboutDuration(58 * 60)).toBe("1 h");
  });
});
