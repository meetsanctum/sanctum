import { describe, expect, it } from "vitest";

import { daySummary, summarySentence } from "../src/summary.js";
import { forecast, morning, withHours } from "./sample.js";

// The rest of the home's day in one sentence.

const hour = 3_600_000;
const later = (hours: number) => new Date(morning.getTime() + hours * hour);
// The hour of an instant in UTC, such as 15:00.
const time = (instant: string) => instant.slice(11, 16);
const sentence = (...args: Parameters<typeof daySummary>) => {
  const summary = daySummary(...args);
  return summary && summarySentence(summary, time);
};

describe("the day's summary", () => {
  it("says until when it falls, when it falls now", () => {
    expect(daySummary(forecast, morning)).toEqual({
      kind: "wet-until",
      words: "Rain",
      until: "2026-10-29T15:00:00.000Z",
      hasBreaks: false,
    });
    expect(sentence(forecast, morning)).toBe("Rain until 15:00, then dry.");
  });

  it("says it falls for the rest of the day when it doesn't stop", () => {
    const snowing = {
      ...withHours(() => ({ weatherCode: 73 })),
      current: { ...forecast.current!, weatherCode: 73 },
    };

    expect(sentence(snowing, morning)).toBe("Snow for the rest of the day.");
  });

  it("says on and off, to the last of it, when it pauses and falls again", () => {
    const rainAgain = withHours((each) => ({
      weatherCode:
        each.time >= "2026-10-29T18:00:00.000Z" &&
        each.time < "2026-10-29T20:00:00.000Z"
          ? 63
          : each.weatherCode,
    }));

    expect(daySummary(rainAgain, morning)).toEqual({
      kind: "wet-until",
      words: "Rain",
      until: "2026-10-29T20:00:00.000Z",
      hasBreaks: true,
    });
    expect(sentence(rainAgain, morning)).toBe(
      "Rain on and off until 20:00, then dry.",
    );
    // A shower in the day's last hour, after a dry evening.
    const rainAtNight = withHours((each) => ({
      weatherCode:
        each.time === "2026-10-29T22:00:00.000Z" ? 80 : each.weatherCode,
    }));
    expect(sentence(rainAtNight, morning)).toBe(
      "Rain on and off for the rest of the day.",
    );
  });

  it("says from when it falls, when it is dry now", () => {
    const showersLater = {
      ...withHours((each) => ({
        weatherCode: each.time >= "2026-10-29T13:00:00.000Z" ? 80 : 2,
      })),
      current: { ...forecast.current!, weatherCode: 2 },
    };

    expect(sentence(showersLater, morning)).toBe(
      "Dry until 13:00, then showers.",
    );
  });

  it("says the sky most of the hours left have, when nothing falls", () => {
    // After the rain: overcast until midnight.
    expect(sentence(forecast, later(8))).toBe(
      "Overcast and dry for the rest of the day.",
    );
    const clearing = {
      ...withHours((each) => ({
        weatherCode: each.time >= "2026-10-29T12:00:00.000Z" ? 0 : 3,
      })),
      current: { ...forecast.current!, weatherCode: 3 },
    };
    expect(sentence(clearing, morning)).toBe(
      "Clear and dry for the rest of the day.",
    );
  });

  it("goes by the weather now for the hour it is, as the page does", () => {
    // Fetched dry in an hour forecast as rain.
    const dryNow = {
      ...forecast,
      current: { ...forecast.current!, weatherCode: 3 },
    };

    expect(sentence(dryNow, morning)).toBe("Dry until 10:00, then rain.");
  });

  it("looks no further than the home's midnight", () => {
    const rainTomorrow = {
      ...withHours((each) => ({
        weatherCode: each.time >= "2026-10-29T23:00:00.000Z" ? 63 : 1,
      })),
      current: { ...forecast.current!, weatherCode: 1 },
    };

    expect(sentence(rainTomorrow, morning)).toBe(
      "Mostly clear and dry for the rest of the day.",
    );
  });

  it("says nothing without hours left today or a sky for now", () => {
    expect(daySummary({ ...forecast, hours: undefined }, morning)).toBeNull();
    expect(daySummary(forecast, later(48))).toBeNull();
    const unknownNow = {
      ...forecast,
      current: { ...forecast.current!, weatherCode: null },
    };
    expect(daySummary(unknownNow, morning)).toBeNull();
  });

  it("says nothing when a kept forecast ends before the day's end", () => {
    expect(daySummary(forecast, later(41))).toBeNull();
  });

  it("does not treat unknown hours as dry weather", () => {
    const missingHour = withHours((each) => ({
      weatherCode:
        each.time === "2026-10-29T15:00:00.000Z" ? null : each.weatherCode,
    }));

    expect(daySummary(missingHour, morning)).toBeNull();
  });
});
