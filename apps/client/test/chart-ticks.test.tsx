// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Columns } from "../src/device-history";
import {
  midnight,
  sixHours,
  timeText,
  type Day,
} from "../src/device-history-data";
import { BandTicks } from "../src/motion-band";

const hour = 60 * 60_000;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubEnv("TZ", "Europe/Zurich");
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

// The labels under a day that ends at `to`, as a band 480 px wide shows them.
async function ticksUntil(to: string) {
  const end = Date.parse(to);
  await act(async () =>
    root.render(<BandTicks from={end - 24 * hour} to={end} plot={480} />),
  );
  return [...container.querySelectorAll("span")].map(
    (each) => each.textContent,
  );
}

describe("a day's hours", () => {
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
    expect(sixHours(end - 24 * hour, end).map(timeText)).toEqual(
      expect.arrayContaining(hours),
    );
  });

  it("skips midnight when the clocks jump straight to 01:00", async () => {
    vi.stubEnv("TZ", "America/Santiago");
    expect(await ticksUntil("2026-09-06T20:00:00-03:00")).toEqual([
      "06:00",
      "12:00",
      "18:00",
    ]);
  });
});

describe("a week of columns", () => {
  it("fits a light on all through the 25 hours of the day the clocks go back", async () => {
    const now = Date.parse("2026-10-27T12:00:00+01:00");
    const days: Day[] = [6, 5, 4, 3, 2, 1, 0].map((back) => {
      const start = midnight(now, back);
      const length = midnight(now, back - 1) - start;
      const on = back === 2 ? length / 1000 : 0;
      return { start, on, known: length / 1000 };
    });
    expect(days[4]!.on).toBe(25 * 3600);
    await act(async () => root.render(<Columns days={days} now={now} />));
    const scale = [...container.querySelectorAll("span")].find((each) =>
      each.textContent?.endsWith(" h"),
    );
    expect(scale?.textContent).toBe("25 h");
    const bar = container.querySelector("path")!.getAttribute("d")!;
    const top = /Q-?[\d.]+,(-?[\d.]+)/.exec(bar)?.[1];
    expect(Number(top)).toBe(0);
  });
});
