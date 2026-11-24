import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import {
  addLocalDays,
  dateText,
  homeClock,
  hostTimeZone,
  hourText,
  hoursBetween,
  isTimeZone,
  localDate,
  localParts,
  startOfDay,
  timeText,
  weekdayText,
  zonedDateToUtc,
  zonedTime,
} from "../src/clock.js";

// The home clock (clock.ts): days and times in the home's time zone, one rule
// for the nights the clocks change, and the home's words for them.

const at = (iso: string) => new Date(iso);
const zurich = "Europe/Zurich";
const newYork = "America/New_York";
// Santiago's clocks go from 00:00 to 01:00 on 2026-09-06: that day has no
// midnight.
const santiago = "America/Santiago";

describe("local dates", () => {
  it("keeps the existing helpers available at the package root", () => {
    expect(sdk.localDate).toBe(localDate);
    expect(sdk.addLocalDays).toBe(addLocalDays);
    expect(sdk.zonedDateToUtc).toBe(zonedDateToUtc);
    expect(sdk.isTimeZone).toBe(isTimeZone);
  });

  it("are read in the home's time zone", () => {
    const instant = at("2026-10-29T23:30:00Z");
    expect(localDate(zurich, instant)).toBe("2026-10-30");
    expect(localDate(newYork, instant)).toBe("2026-10-29");
    expect(localDate("UTC", instant)).toBe("2026-10-29");
  });

  it("add up across months and years", () => {
    expect(addLocalDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("turn into instants across daylight saving changes", () => {
    // Noon in Zurich is 10:00 UTC in summer time and 11:00 in winter.
    expect(zonedDateToUtc("2026-03-29", 12, 0, zurich)).toEqual(
      at("2026-03-29T10:00:00Z"),
    );
    expect(zonedDateToUtc("2026-10-25", 12, 0, zurich)).toEqual(
      at("2026-10-25T11:00:00Z"),
    );
    expect(zonedDateToUtc("2026-10-29", 0, 5, "Asia/Tokyo")).toEqual(
      at("2026-10-28T15:05:00Z"),
    );
  });
});

describe("a time the clocks change", () => {
  it("comes as much later as the clocks moved where they skip it", () => {
    // Zurich skips 02:00 to 03:00 on 2026-03-29.
    expect(zonedTime({ year: 2026, month: 3, day: 29 }, 2, 30, zurich)).toEqual(
      at("2026-03-29T01:30:00Z"),
    );
  });

  it("comes the first time where they repeat it", () => {
    // Zurich goes from 03:00 back to 02:00 on 2026-10-25.
    expect(zonedDateToUtc("2026-10-25", 2, 30, zurich)).toEqual(
      at("2026-10-25T00:30:00Z"),
    );
  });

  it("starts a day without a midnight at its first instant, on that day", () => {
    expect(zonedDateToUtc("2026-09-06", 0, 0, santiago)).toEqual(
      at("2026-09-06T04:00:00Z"),
    );
    expect(localParts(at("2026-09-06T04:00:00Z"), santiago)).toMatchObject({
      day: 6,
      hour: 1,
      minute: 0,
    });
    expect(startOfDay(Date.parse("2026-09-06T18:00:00Z"), santiago)).toBe(
      Date.parse("2026-09-06T04:00:00Z"),
    );
  });
});

describe("a day's start", () => {
  it("starts at the clock change when the gap begins before midnight", () => {
    const toronto = "America/Toronto";
    expect(startOfDay(Date.parse("1919-03-31T12:00:00Z"), toronto)).toBe(
      Date.parse("1919-03-31T04:30:00Z"),
    );
    expect(zonedDateToUtc("1919-03-31", 0, 0, toronto)).toEqual(
      at("1919-03-31T05:00:00Z"),
    );
  });

  it("is the home's midnight, whatever the device's zone", () => {
    const evening = Date.parse("2026-11-24T22:30:00Z");
    // 23:30 in Zurich, 17:30 in New York: two different days start.
    expect(startOfDay(evening, zurich)).toBe(
      Date.parse("2026-11-23T23:00:00Z"),
    );
    expect(startOfDay(evening, newYork)).toBe(
      Date.parse("2026-11-24T05:00:00Z"),
    );
  });

  it("counts days back across the clocks' change", () => {
    const monday = Date.parse("2026-10-26T12:00:00Z");
    // Sunday 25 October has 25 hours in Zurich.
    expect(startOfDay(monday, zurich, 1)).toBe(
      Date.parse("2026-10-24T22:00:00Z"),
    );
    expect(startOfDay(monday, zurich) - startOfDay(monday, zurich, 1)).toBe(
      25 * 3600_000,
    );
  });
});

describe("the hours every 6", () => {
  it("fall on the home's whole hours, strictly inside the span", () => {
    const from = Date.parse("2026-11-23T23:00:00Z");
    const to = Date.parse("2026-11-24T23:00:00Z");
    expect(
      hoursBetween(from, to, zurich).map((each) => timeText(each, zurich)),
    ).toEqual(["06:00", "12:00", "18:00"]);
  });

  it("leave out an hour the clocks skip", () => {
    const from = Date.parse("2026-09-05T12:00:00Z");
    const to = Date.parse("2026-09-06T12:00:00Z");
    // From 08:00 on the 5th: 12:00 and 18:00, then 06:00 on the 6th, whose
    // midnight never comes.
    expect(
      hoursBetween(from, to, santiago).map((each) => timeText(each, santiago)),
    ).toEqual(["12:00", "18:00", "06:00"]);
  });

  it("leave out an entire date the clocks skip", () => {
    const from = Date.parse("2011-12-30T00:00:00Z");
    const to = Date.parse("2011-12-31T12:00:00Z");
    expect(hoursBetween(from, to, "Pacific/Apia")).toEqual(
      [
        "2011-12-30T04:00:00Z",
        "2011-12-30T10:00:00Z",
        "2011-12-30T16:00:00Z",
        "2011-12-30T22:00:00Z",
        "2011-12-31T04:00:00Z",
        "2011-12-31T10:00:00Z",
      ].map(Date.parse),
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity])(
    "reject an invalid interval of %s hours",
    (every) => {
      const from = Date.parse("2026-11-24T00:00:00Z");
      const to = Date.parse("2026-11-25T00:00:00Z");
      expect(() => hoursBetween(from, to, "UTC", every)).toThrow(RangeError);
    },
  );
});

describe("the home's words", () => {
  const instant = at("2026-11-24T13:48:00Z");

  it("write a time in 24 hours unless the home counts 12", () => {
    expect(timeText(instant, zurich)).toBe("14:48");
    expect(timeText(at("2026-11-24T06:05:00Z"), zurich)).toBe("07:05");
    expect(timeText(instant, zurich, "12h")).toBe("2:48 PM");
    expect(timeText(instant, newYork)).toBe("08:48");
  });

  it("write an hour on its own", () => {
    const four = at("2026-11-24T15:00:00Z");
    expect(hourText(four, zurich)).toBe("16:00");
    expect(hourText(four, zurich, "12h")).toBe("4 PM");
  });

  it("write a day's name and its date in the home's zone", () => {
    const late = at("2026-11-24T23:30:00Z");
    expect(weekdayText(late, zurich)).toBe("Wed");
    expect(weekdayText(late, newYork)).toBe("Tue");
    expect(dateText(late, zurich)).toBe("Wed 25 Nov");
  });
});

describe("the home clock", () => {
  it("binds every way of working out days and times to the home", () => {
    const clock = homeClock({
      timeZone: zurich,
      hourCycle: "12h",
      now: () => at("2026-11-24T22:30:00Z"),
    });
    expect(clock.date()).toBe("2026-11-24");
    expect(clock.startOfDay()).toBe(Date.parse("2026-11-23T23:00:00Z"));
    expect(clock.startOfDay(undefined, 1)).toBe(
      Date.parse("2026-11-22T23:00:00Z"),
    );
    expect(clock.timeText(clock.now())).toBe("11:30 PM");
    expect(clock.at("2026-11-25", 7, 30)).toEqual(at("2026-11-25T06:30:00Z"));
    expect(clock.parts()).toMatchObject({ day: 24, hour: 23, minute: 30 });
  });

  it("uses the device's zone while the home's isn't known, or the runtime doesn't know it", () => {
    expect(homeClock().timeZone).toBe(hostTimeZone());
    expect(homeClock({ timeZone: null }).timeZone).toBe(hostTimeZone());
    expect(homeClock({ timeZone: "Mars/Olympus" }).timeZone).toBe(
      hostTimeZone(),
    );
    expect(homeClock({ timeZone: zurich }).hourCycle).toBe("24h");
  });

  it("knows the runtime's time zones", () => {
    expect(isTimeZone(zurich)).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});
