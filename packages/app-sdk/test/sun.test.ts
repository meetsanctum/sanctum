import { describe, expect, it } from "vitest";

import {
  addLocalDays,
  localDate,
  sunDay,
  sunTimes,
  sunType,
  zonedDateToUtc,
  type SunTimes,
} from "../src/index.js";

// The sun around the home's day, from NOAA's Solar Calculator, with v1's date
// handling, and checked against published times.

const london = {
  latitude: 51.5074,
  longitude: -0.1278,
  elevation: null,
  timeZone: "Europe/London",
};
const zurich = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: null,
  timeZone: "Europe/Zurich",
};
const tromso = {
  latitude: 69.6492,
  longitude: 18.9553,
  elevation: null,
  timeZone: "Europe/Oslo",
};
const tokyo = {
  latitude: 35.6762,
  longitude: 139.6503,
  elevation: null,
  timeZone: "Asia/Tokyo",
};

// sunrisesunset.io counts the elevation, from its own model of the ground,
// so these are as high as it takes them to be.
const bern = {
  latitude: 46.948,
  longitude: 7.4474,
  elevation: 538,
  timeZone: "Europe/Zurich",
};
const denver = {
  latitude: 39.7392,
  longitude: -104.9903,
  elevation: 1614,
  timeZone: "America/Denver",
};
const deadSea = {
  latitude: 31.5,
  longitude: 35.5,
  elevation: -430,
  timeZone: "Asia/Jerusalem",
};

const second = 1000;
const minute = 60 * second;
const at = (iso: string | null) => new Date(iso!).getTime();

// Today's, as the sun state lists it.
const today = (sun: SunTimes) => sunDay(sun)!;

describe("sun times", () => {
  it("match the published ones for London at midsummer", () => {
    // Sunrise 04:43 and sunset 21:21 BST, to the minute.
    const sun = sunTimes(london, new Date("2026-06-21T10:00:00Z"));

    expect(sun.date).toBe("2026-06-21");
    expect(
      Math.abs(at(today(sun).sunrise) - at("2026-06-21T03:43:00Z")),
    ).toBeLessThan(minute);
    expect(
      Math.abs(at(today(sun).sunset) - at("2026-06-21T20:21:00Z")),
    ).toBeLessThan(minute);
    expect(sunType.state.parse(sun)).toEqual(sun);
  });

  it("match the published ones for Zurich at midwinter", () => {
    // The shortest day, 8 h 27 min, ends just after the year's earliest
    // sunsets at 16:36 CET.
    const { sunrise, sunset, solarNoon } = today(
      sunTimes(zurich, new Date("2026-12-21T10:00:00Z")),
    );

    expect(
      Math.abs(at(sunset) - at(sunrise) - (8 * 60 + 27) * minute),
    ).toBeLessThan(2 * minute);
    expect(at(sunset)).toBeGreaterThan(at("2026-12-21T15:36:00Z"));
    expect(at(sunset)).toBeLessThan(at("2026-12-21T15:41:00Z"));
    expect(at(solarNoon)).toBeGreaterThan(at(sunrise));
    expect(at(solarNoon)).toBeLessThan(at(sunset));
  });

  it.each([
    // 07:03:13, 12:13:56 and 17:24:00 CET.
    [
      "Bern",
      bern,
      "2026-10-29T06:03:13Z",
      "2026-10-29T11:13:56Z",
      "2026-10-29T16:24:00Z",
    ],
    // 07:17:53, 12:43:40 and 18:08:55 MDT.
    [
      "Denver",
      denver,
      "2026-10-29T13:17:53Z",
      "2026-10-29T18:43:40Z",
      "2026-10-30T00:08:55Z",
    ],
  ])(
    "match the published ones for %s on 29 October, to the elevation",
    (_place, location, sunrise, solarNoon, sunset) => {
      const now = new Date("2026-10-29T12:00:00Z");
      const daylight = (day: {
        sunrise: string | null;
        sunset: string | null;
      }) => at(day.sunset) - at(day.sunrise);
      const upHigh = today(sunTimes(location, now));
      const atSeaLevel = today(sunTimes({ ...location, elevation: null }, now));

      // sunrisesunset.io's come 3 seconds after NOAA's, all three of them.
      expect(Math.abs(at(upHigh.sunrise) - at(sunrise))).toBeLessThan(
        10 * second,
      );
      expect(Math.abs(at(upHigh.solarNoon) - at(solarNoon))).toBeLessThan(
        10 * second,
      );
      expect(Math.abs(at(upHigh.sunset) - at(sunset))).toBeLessThan(
        10 * second,
      );
      // At sea level the day would be 8 to 14 minutes shorter.
      expect(daylight(upHigh) - daylight(atSeaLevel)).toBeGreaterThan(
        7 * minute,
      );
    },
  );

  it("count a home below sea level as at it", () => {
    const now = new Date("2026-10-29T12:00:00Z");

    expect(sunTimes(deadSea, now)).toEqual(
      sunTimes({ ...deadSea, elevation: null }, now),
    );
    expect(today(sunTimes(deadSea, now)).sunrise).toEqual(expect.any(String));
  });

  it("are the home's days, whatever the host's clock says", () => {
    // Late on 29 October in UTC is the morning of the 30th in Tokyo.
    const sun = sunTimes(tokyo, new Date("2026-10-29T23:30:00Z"));

    expect(sun.date).toBe("2026-10-30");
    expect(sun.timeZone).toBe("Asia/Tokyo");
    for (const day of sun.days) {
      expect(localDate("Asia/Tokyo", new Date(day.sunrise!))).toBe(day.date);
      expect(localDate("Asia/Tokyo", new Date(day.sunset!))).toBe(day.date);
    }
  });

  it("keep the local solar day on the far side of the date line", () => {
    const location = {
      latitude: 1.8721,
      longitude: -157.4278,
      elevation: null,
      timeZone: "Pacific/Kiritimati",
    };
    const sun = sunTimes(location, new Date("2026-10-29T23:30:00Z"));

    expect(sun.date).toBe("2026-10-30");
    for (const day of sun.days) {
      for (const event of [day.sunrise, day.solarNoon, day.sunset]) {
        expect(event).not.toBeNull();
        expect(localDate(location.timeZone, new Date(event!))).toBe(day.date);
      }
      expect(at(day.sunrise)).toBeLessThan(at(day.solarNoon));
      expect(at(day.sunset)).toBeGreaterThan(at(day.solarNoon));
    }
  });

  it("list yesterday, today and tomorrow, and change only with the day", () => {
    const morning = sunTimes(zurich, new Date("2026-10-29T05:00:00Z"));
    const evening = sunTimes(zurich, new Date("2026-10-29T20:00:00Z"));

    expect(morning.days.map((day) => day.date)).toEqual([
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
    ]);
    expect(evening).toEqual(morning);
    // Late in the evening it is already the next day.
    expect(sunTimes(zurich, new Date("2026-10-29T23:30:00Z")).date).toBe(
      "2026-10-30",
    );
  });

  it("have no sunrise or sunset in a polar winter or summer", () => {
    for (const when of ["2026-12-21T10:00:00Z", "2026-06-21T10:00:00Z"]) {
      const sun = sunTimes(tromso, new Date(when));
      for (const day of sun.days) {
        expect(day).toMatchObject({ sunrise: null, sunset: null });
        expect(day.solarNoon).toEqual(expect.any(String));
      }
      expect(sunType.state.parse(sun)).toEqual(sun);
    }
  });

  it.each([
    ["2026-05-18", "sunrise", "2026-05-17T22:51:19Z", "sunset"],
    ["2026-07-25", "sunset", "2026-07-25T22:37:32Z", "sunrise"],
  ] as const)(
    "keep the horizon crossing at the edge of polar summer on %s",
    (date, event, expected, absent) => {
      // Roots of NOAA's solar elevation at -0.833 degrees. The noon
      // declination alone says there is no crossing on these days.
      const day = today(sunTimes(tromso, new Date(`${date}T12:00:00Z`)));

      expect(day[event]).not.toBeNull();
      expect(Math.abs(at(day[event]) - at(expected))).toBeLessThan(second);
      expect(day[absent]).toBeNull();
    },
  );

  it("converge for a shallow horizon crossing near the pole", () => {
    const day = today(
      sunTimes(
        { latitude: 89, longitude: 0, elevation: null, timeZone: "UTC" },
        new Date("2026-03-20T12:00:00Z"),
      ),
    );

    // Where NOAA's solar elevation crosses -0.833 degrees.
    expect(day.sunset).not.toBeNull();
    expect(Math.abs(at(day.sunset) - at("2026-03-20T23:16:16Z"))).toBeLessThan(
      second,
    );
  });

  it("keep a sunrise and sunset both before noon, by the North Pole", () => {
    const { sunrise, sunset, solarNoon } = today(
      sunTimes(
        { latitude: 89.875, longitude: 0, elevation: null, timeZone: "UTC" },
        new Date("2026-09-25T12:00:00Z"),
      ),
    );

    // So near the pole, days after the equinox, the sun's falling declination
    // outruns its climb towards noon: it is up only from 08:39:29 to
    // 11:01:56, and below the horizon again at noon.
    expect(Math.abs(at(sunrise) - at("2026-09-25T08:39:29Z"))).toBeLessThan(
      second,
    );
    expect(Math.abs(at(sunset) - at("2026-09-25T11:01:56Z"))).toBeLessThan(
      second,
    );
    expect(at(sunset)).toBeLessThan(at(solarNoon));
  });

  it("have no sunrise after a night the sun stays up, near the South Pole", () => {
    const day = today(
      sunTimes(
        { latitude: -85, longitude: 0, elevation: 500, timeZone: "UTC" },
        new Date("2026-03-12T12:00:00Z"),
      ),
    );

    // From 500 m the sun stays above the horizon through the solar midnight
    // before, by less than a hundredth of a degree.
    expect(day.sunrise).toBeNull();
    expect(day.sunset).not.toBeNull();
    expect(Math.abs(at(day.sunset) - at("2026-03-12T22:41:22Z"))).toBeLessThan(
      second,
    );
  });
});

describe("local dates", () => {
  it("are read in the home's time zone", () => {
    const instant = new Date("2026-10-29T23:30:00Z");
    expect(localDate("Europe/Zurich", instant)).toBe("2026-10-30");
    expect(localDate("America/New_York", instant)).toBe("2026-10-29");
    expect(localDate("UTC", instant)).toBe("2026-10-29");
  });

  it("add up across months and years", () => {
    expect(addLocalDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("turn into instants across daylight saving changes", () => {
    // Noon in Zurich is 10:00 UTC in summer time and 11:00 in winter.
    expect(
      zonedDateToUtc("2026-03-29", 12, 0, "Europe/Zurich").toISOString(),
    ).toBe("2026-03-29T10:00:00.000Z");
    expect(
      zonedDateToUtc("2026-10-25", 12, 0, "Europe/Zurich").toISOString(),
    ).toBe("2026-10-25T11:00:00.000Z");
    expect(zonedDateToUtc("2026-10-29", 0, 5, "Asia/Tokyo").toISOString()).toBe(
      "2026-10-28T15:05:00.000Z",
    );
  });
});
