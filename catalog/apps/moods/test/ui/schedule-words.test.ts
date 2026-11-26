import { homeClock } from "@meetsanctum/app-sdk/clock";
import { describe, expect, it } from "vitest";

import {
  minuteOfDay,
  minuteWords,
  whenWords,
} from "../../src/ui/schedule-words.js";

const zurich = homeClock({ timeZone: "Europe/Zurich" });

describe("snapshot dates", () => {
  it.each([
    ["2026-03-29T12:00:00Z", "2026-03-29T22:30:00Z", "14:00"],
    ["2026-10-24T12:00:00Z", "2026-10-25T22:30:00Z", "14:00"],
  ])("recognises yesterday across a clock change (%s)", (at, now, time) => {
    expect(whenWords(zurich, new Date(at), new Date(now))).toBe(
      `at ${time} yesterday`,
    );
  });

  it("names an older day by its date", () => {
    expect(
      whenWords(
        zurich,
        new Date("2026-10-28T12:00:00Z"),
        new Date("2026-10-30T12:00:00Z"),
      ),
    ).toBe("on 28 October");
  });
});

describe("a schedule's minutes", () => {
  it("reads the minute of the day on the home's clock", () => {
    const at = new Date("2026-10-30T21:20:00Z");
    expect(minuteOfDay(homeClock({ timeZone: "UTC" }), at)).toBe(21 * 60 + 20);
    expect(minuteOfDay(zurich, at)).toBe(22 * 60 + 20);
    expect(minuteOfDay(zurich, new Date("2026-10-30T23:10:00Z"))).toBe(10);
  });

  it("writes them as the home does, the day's end too", () => {
    const twelve = homeClock({ timeZone: "UTC", hourCycle: "12h" });
    expect(minuteWords(zurich, 465)).toBe("07:45");
    expect(minuteWords(zurich, 1440)).toBe("24:00");
    expect(minuteWords(twelve, 465)).toBe("7:45 AM");
    expect(minuteWords(twelve, 0)).toBe("12:00 AM");
    expect(minuteWords(twelve, 1440)).toBe("12:00 AM");
  });
});
