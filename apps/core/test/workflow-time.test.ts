import { describe, expect, it } from "vitest";

import { nextSun, refreshSunTimer } from "../src/workflows/jobs.js";
import {
  isTimeZone,
  nextDaily,
  nextEvery,
  withinTimes,
  zonedTime,
} from "../src/workflows/time.js";

// Times of day in the home's time zone.

const at = (iso: string) => new Date(iso);
const berlin = "Europe/Berlin";

describe("nextDaily", () => {
  it("runs later today, or tomorrow once today's time has passed", () => {
    expect(nextDaily(at("2026-10-26T06:00:00Z"), "07:00", "UTC")).toEqual(
      at("2026-10-26T07:00:00Z"),
    );
    expect(nextDaily(at("2026-10-26T07:00:00Z"), "07:00", "UTC")).toEqual(
      at("2026-10-27T07:00:00Z"),
    );
  });

  it("reads the time in the home's time zone", () => {
    // 07:00 in Berlin is 06:00 UTC in winter.
    expect(nextDaily(at("2026-11-02T00:00:00Z"), "07:00", berlin)).toEqual(
      at("2026-11-02T06:00:00Z"),
    );
  });

  it("runs only on the days given", () => {
    // 2026-10-26 is a Monday.
    expect(
      nextDaily(at("2026-10-26T08:00:00Z"), "07:00", "UTC", ["mon", "sat"]),
    ).toEqual(at("2026-10-31T07:00:00Z"));
  });

  it("runs a time the clocks skip as much later as they moved", () => {
    // Berlin skips 02:00 to 03:00 on 2026-03-29.
    expect(nextDaily(at("2026-03-28T12:00:00Z"), "02:30", berlin)).toEqual(
      at("2026-03-29T01:30:00Z"),
    );
    expect(zonedTime({ year: 2026, month: 3, day: 29 }, 2, 30, berlin)).toEqual(
      at("2026-03-29T01:30:00Z"),
    );
  });

  it("runs a time the clocks repeat once, the first time", () => {
    // Berlin goes from 03:00 back to 02:00 on 2026-10-25.
    const first = nextDaily(at("2026-10-24T12:00:00Z"), "02:30", berlin);
    expect(first).toEqual(at("2026-10-25T00:30:00Z"));
    expect(nextDaily(first, "02:30", berlin)).toEqual(
      at("2026-10-26T01:30:00Z"),
    );
  });
});

describe("nextEvery", () => {
  it("keeps the beat from the epoch, so a restart keeps it too", () => {
    expect(nextEvery(at("2026-10-26T12:03:10Z"), 300)).toEqual(
      at("2026-10-26T12:05:00Z"),
    );
    expect(nextEvery(at("2026-10-26T12:05:00Z"), 300)).toEqual(
      at("2026-10-26T12:10:00Z"),
    );
    expect(nextEvery(at("2026-10-26T12:03:10Z"), 300, 30)).toEqual(
      at("2026-10-26T12:05:30Z"),
    );
  });
});

describe("withinTimes", () => {
  const evening = { after: "18:00", before: "23:00" };
  const night = { after: "22:00", before: "06:00" };

  it("is from the first time up to the second", () => {
    expect(withinTimes(at("2026-10-26T18:00:00Z"), evening, "UTC")).toBe(true);
    expect(withinTimes(at("2026-10-26T23:00:00Z"), evening, "UTC")).toBe(false);
    expect(withinTimes(at("2026-10-26T12:00:00Z"), evening, "UTC")).toBe(false);
  });

  it("goes across midnight when the first time is later", () => {
    expect(withinTimes(at("2026-10-26T23:30:00Z"), night, "UTC")).toBe(true);
    expect(withinTimes(at("2026-10-27T05:59:00Z"), night, "UTC")).toBe(true);
    expect(withinTimes(at("2026-10-27T12:00:00Z"), night, "UTC")).toBe(false);
  });

  it("counts the day a span across midnight started on", () => {
    // Saturday night into Sunday morning is Saturday's.
    const saturday = { ...night, days: ["sat" as const] };
    expect(withinTimes(at("2026-11-01T03:00:00Z"), saturday, "UTC")).toBe(true);
    expect(withinTimes(at("2026-11-01T23:00:00Z"), saturday, "UTC")).toBe(
      false,
    );
  });
});

describe("nextSun", () => {
  const sun = [
    {
      date: "2026-10-26",
      sunrise: "2026-10-26T06:30:00Z",
      sunset: "2026-10-26T16:40:00Z",
    },
    {
      date: "2026-10-27",
      sunrise: "2026-10-27T06:32:00Z",
      sunset: "2026-10-27T16:38:00Z",
    },
  ];

  it("is the next sunrise or sunset, moved by the offset, and its day", () => {
    expect(nextSun(at("2026-10-26T12:00:00Z"), "sunset", -30, sun)).toEqual({
      nextAt: at("2026-10-26T16:10:00Z"),
      sunDay: "2026-10-26",
    });
    expect(nextSun(at("2026-10-26T12:00:00Z"), "sunrise", 0, sun)).toEqual({
      nextAt: at("2026-10-27T06:32:00Z"),
      sunDay: "2026-10-27",
    });
  });

  it("is on a later day than the one it ran for", () => {
    expect(
      nextSun(at("2026-10-26T12:00:00Z"), "sunset", 0, sun, "2026-10-26"),
    ).toEqual({ nextAt: at("2026-10-27T16:38:00Z"), sunDay: "2026-10-27" });
    expect(
      nextSun(at("2026-10-26T12:00:00Z"), "sunset", 0, sun, "2026-10-27"),
    ).toEqual({ nextAt: null, sunDay: "2026-10-28" });
  });

  it("waits while no app knows the sun, or its times have run out", () => {
    expect(nextSun(at("2026-10-26T12:00:00Z"), "sunset", 0, null)).toEqual({
      nextAt: null,
      sunDay: null,
    });
    expect(nextSun(at("2026-10-28T12:00:00Z"), "sunset", 0, sun)).toEqual({
      nextAt: null,
      sunDay: null,
    });
  });
});

describe("refreshSunTimer", () => {
  const sun = (sunset: string) => [
    {
      date: "2026-10-26",
      sunrise: null,
      sunset: `2026-10-26T${sunset}:00Z`,
    },
    {
      date: "2026-10-27",
      sunrise: null,
      sunset: "2026-10-27T16:38:00Z",
    },
  ];

  it("ties a due timer from before timers kept a day to its sunset's day", () => {
    // Due for 16:40 when the core comes back, with sunset since at 16:45.
    const timer = { nextAt: at("2026-10-26T16:40:00Z"), sunDay: null };
    const now = at("2026-10-26T16:40:05Z");
    expect(refreshSunTimer(timer, now, "sunset", 0, sun("16:45"))).toEqual({
      nextAt: at("2026-10-26T16:45:00Z"),
      sunDay: "2026-10-26",
    });
    expect(refreshSunTimer(timer, now, "sunset", 0, sun("16:40"))).toEqual({
      nextAt: at("2026-10-26T16:40:00Z"),
      sunDay: "2026-10-26",
    });
  });
});

describe("isTimeZone", () => {
  it("knows IANA time zones", () => {
    expect(isTimeZone(berlin)).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});
