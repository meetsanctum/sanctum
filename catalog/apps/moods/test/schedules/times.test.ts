import { describe, expect, it } from "vitest";

import {
  byStart,
  endsFrom,
  formatMinute,
  holds,
  isEnd,
  isStart,
  lengthOf,
  minuteIn,
  nextFreeWindow,
  overlaps,
  spanAt,
  windowsOf,
} from "../../src/schedules/times.js";

// A schedule's times, ported from v1's room-schedules.test.ts (web-nuxt,
// Pragmata v1-final), with a time that runs past midnight kept as one.

const night = { start: 22 * 60, end: 6 * 60 + 30 };
const focus = { start: 9 * 60, end: 17 * 60 };

describe("a schedule's times", () => {
  it("formats minutes, midnight as an end being 24:00", () => {
    expect(formatMinute(0)).toBe("00:00");
    expect(formatMinute(465)).toBe("07:45");
    expect(formatMinute(1440)).toBe("24:00");
  });

  it("starts from 00:00 to 23:45 and ends from 00:15 to 24:00, in 15-minute steps", () => {
    expect([0, 1425].every(isStart)).toBe(true);
    expect([1440, 7, -15].some(isStart)).toBe(false);
    expect([15, 1440].every(isEnd)).toBe(true);
    expect([0, 1455, 20].some(isEnd)).toBe(false);
  });

  it("runs a time whose end is not after its start past midnight", () => {
    expect(windowsOf(night)).toEqual([
      { start: 1320, end: 1440 },
      { start: 0, end: 390 },
    ]);
    expect(windowsOf({ start: 1320, end: 1440 })).toEqual([
      { start: 1320, end: 1440 },
    ]);
    expect(lengthOf(night)).toBe(8 * 60 + 30);
    expect(lengthOf({ start: 0, end: 1440 })).toBe(1440);
  });

  it("holds from its start up to its end (v1's currentRoomScheduleConfigEntry)", () => {
    expect(holds(focus, 540)).toBe(true);
    expect(holds(focus, 1019)).toBe(true);
    expect(holds(focus, 1020)).toBe(false);
    expect(holds(night, 1439)).toBe(true);
    expect(holds(night, 0)).toBe(true);
    expect(holds(night, 390)).toBe(false);
    expect(spanAt([focus, night], 23 * 60)).toBe(night);
    expect(spanAt([focus, night], 18 * 60)).toBeUndefined();
  });

  it("tells overlapping times apart from those that only meet", () => {
    expect(overlaps(focus, { start: 16 * 60, end: 18 * 60 })).toBe(true);
    expect(overlaps(focus, { start: 17 * 60, end: 18 * 60 })).toBe(false);
    expect(overlaps(night, { start: 6 * 60, end: 7 * 60 })).toBe(true);
    expect(overlaps(night, { start: 390, end: 9 * 60 })).toBe(false);
    expect(overlaps(night, { start: 23 * 60, end: 1 * 60 })).toBe(true);
  });

  it("puts times in the order of the day", () => {
    expect(byStart([night, focus])).toEqual([focus, night]);
  });

  it("offers ends from a start up to the next time, past midnight", () => {
    const morning = { start: 390, end: 540 };
    expect(endsFrom([morning, focus, night], 17 * 60)).toEqual([
      1035, 1050, 1065, 1080, 1095, 1110, 1125, 1140, 1155, 1170, 1185, 1200,
      1215, 1230, 1245, 1260, 1275, 1290, 1305, 1320,
    ]);
    // From 23:00 with nothing after: on to midnight and round to 22:45.
    const late = endsFrom([], 23 * 60);
    expect(late.slice(0, 5)).toEqual([1395, 1410, 1425, 1440, 15]);
    expect(late.at(-1)).toBe(1365);
    expect(endsFrom([], 0).at(-1)).toBe(1440);
    // A start another time holds has none.
    expect(endsFrom([focus], 10 * 60)).toEqual([]);
  });

  it("chooses the next free hour after the latest time (v1's nextAvailableScheduleWindow)", () => {
    expect(nextFreeWindow([])).toEqual({ start: 420, end: 480 });
    expect(nextFreeWindow([{ start: 420, end: 960 }])).toEqual({
      start: 960,
      end: 1020,
    });
  });

  it("wraps to the earliest free hour when no later one is free", () => {
    expect(nextFreeWindow([{ start: 600, end: 1440 }])).toEqual({
      start: 0,
      end: 60,
    });
    // As in the office: 17:00, after Focus, before Evening.
    expect(
      nextFreeWindow([
        { start: 390, end: 540 },
        focus,
        { start: 1110, end: 1320 },
        night,
      ]),
    ).toEqual({ start: 1020, end: 1080 });
  });

  it("falls back to a free quarter of an hour, and none when the day is full", () => {
    expect(
      nextFreeWindow([
        { start: 0, end: 705 },
        { start: 720, end: 1440 },
      ]),
    ).toEqual({ start: 705, end: 720 });
    expect(nextFreeWindow([{ start: 0, end: 1440 }])).toBeNull();
    expect(
      nextFreeWindow([
        { start: 600, end: 1440 },
        { start: 0, end: 600 },
      ]),
    ).toBeNull();
  });

  it("reads the minute of the day in the home's time zone", () => {
    const at = new Date("2026-10-30T21:20:00Z");
    expect(minuteIn(at, "UTC")).toBe(21 * 60 + 20);
    expect(minuteIn(at, "Europe/Zurich")).toBe(22 * 60 + 20);
    expect(minuteIn(new Date("2026-10-30T23:10:00Z"), "Europe/Zurich")).toBe(
      10,
    );
  });
});
