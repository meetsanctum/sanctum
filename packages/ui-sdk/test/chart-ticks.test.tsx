// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { homeClock } from "@meetsanctum/app-sdk/clock";

import { DayTimeAxis, WeekColumnsChart } from "../src/charts";
import { HomeTimeZoneProvider } from "../src/home-clock";

const hour = 60 * 60_000;
let container: HTMLDivElement;
let root: Root;

// The device is in Tokyo, far from every home here, so an hour or a day
// worked out in the device's zone shows.
beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Tokyo");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(520);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The labels under a day that ends at `to`, as a band 480 px wide shows them
// for a home in `timeZone`.
async function ticksUntil(to: string, timeZone = "Europe/Zurich") {
  const end = Date.parse(to);
  await act(async () =>
    root.render(
      <HomeTimeZoneProvider timeZone={timeZone}>
        <DayTimeAxis from={end - 24 * hour} to={end} width={480} />
      </HomeTimeZoneProvider>,
    ),
  );
  return [...container.querySelectorAll("span")].map(
    (each) => each.textContent,
  );
}

describe("a day's hours", () => {
  it("are the home's, written as the home counts its hours", async () => {
    // 17:30 in New York, 23:30 in Zurich and 07:30 on the device.
    const to = "2026-11-18T23:30:00+01:00";
    expect(await ticksUntil(to)).toEqual(["06:00", "12:00", "18:00"]);
    const end = Date.parse(to);
    await act(async () =>
      root.render(
        <HomeTimeZoneProvider timeZone="America/New_York" hourCycle="12h">
          <DayTimeAxis from={end - 24 * hour} to={end} width={480} />
        </HomeTimeZoneProvider>,
      ),
    );
    expect(
      [...container.querySelectorAll("span")].map((each) => each.textContent),
    ).toEqual(["12 AM", "6 AM", "12 PM"]);
  });

  // In Zurich summer time ended at 03:00 on 25 October 2026 and began at
  // 02:00 on 29 March 2026.
  it.each([
    [
      "the clocks go back",
      "2026-10-25T23:30:00+01:00",
      ["06:00", "12:00", "18:00"],
    ],
    [
      "after the clocks went back",
      "2026-10-26T20:00:00+01:00",
      ["00:00", "06:00", "12:00", "18:00"],
    ],
    [
      "the clocks go forward",
      "2026-03-29T23:30:00+02:00",
      ["00:00", "06:00", "12:00", "18:00"],
    ],
    [
      "after the clocks went forward",
      "2026-03-30T20:00:00+02:00",
      ["00:00", "06:00", "12:00", "18:00"],
    ],
  ])("fall on the clock's 6 hours the day %s", async (_, to, hours) => {
    expect(await ticksUntil(to)).toEqual(hours);
    const end = Date.parse(to);
    const zurich = homeClock({ timeZone: "Europe/Zurich" });
    expect(zurich.hours(end - 24 * hour, end).map(zurich.timeText)).toEqual(
      expect.arrayContaining(hours),
    );
  });

  it("skips midnight when the clocks jump straight to 01:00", async () => {
    expect(
      await ticksUntil("2026-09-06T20:00:00-03:00", "America/Santiago"),
    ).toEqual(["06:00", "12:00", "18:00"]);
  });
});

describe("a week of columns", () => {
  it("fits a light on all through the 25 hours of the day the clocks go back", async () => {
    const now = Date.parse("2026-10-27T12:00:00+01:00");
    const zurich = homeClock({ timeZone: "Europe/Zurich" });
    const days = [6, 5, 4, 3, 2, 1, 0].map((back) => {
      const start = zurich.startOfDay(now, back);
      const length = zurich.startOfDay(now, back - 1) - start;
      return { start, value: back === 2 ? length / hour : 0 };
    });
    expect(days[4]!.value).toBe(25);
    await act(async () =>
      root.render(
        <HomeTimeZoneProvider timeZone="Europe/Zurich">
          <WeekColumnsChart
            days={days}
            now={now}
            scale="hours"
            label="How long it was on each day"
            text={(day) => `${day.value} h`}
            spoken={(day) => `on for ${day.value} h`}
          />
        </HomeTimeZoneProvider>,
      ),
    );
    const scale = [...container.querySelectorAll("span")].find((each) =>
      each.textContent?.endsWith(" h"),
    );
    expect(scale?.textContent).toBe("25 h");
    const bar = container.querySelector("path")!.getAttribute("d")!;
    const top = /Q-?[\d.]+,(-?[\d.]+)/.exec(bar)?.[1];
    expect(Number(top)).toBe(0);
  });
});

describe("the hours under a day", () => {
  it("stay on the clock's 6 hours on the day the clocks go back", () => {
    const berlin = homeClock({ timeZone: "Europe/Berlin" });
    // Summer time ended at 03:00 on 25 October 2026.
    const to = Date.parse("2026-10-25T20:00:00+01:00");
    expect(berlin.hours(to - 24 * hour, to).map(berlin.timeText)).toEqual([
      "00:00",
      "06:00",
      "12:00",
      "18:00",
    ]);
  });
});
