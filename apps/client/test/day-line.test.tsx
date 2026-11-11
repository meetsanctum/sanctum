// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DayLineChart } from "../src/day-line";

// A day as a line (day-line.tsx): at its end the cursor shows what it reads
// now, where the line ends, and not the last 5 minutes before it.

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const minute = 60_000;
const now = Date.parse("2026-11-03T00:10:00Z");

const dayMs = 24 * 60 * minute;
const slotMs = 5 * minute;
// The middle of each of the day's 5 minutes, as the chart lays them out.
const slotMiddle = (slot: number) => now - dayMs + (slot + 0.5) * slotMs;

function chart(line: Parameters<typeof DayLineChart>[0]["line"]) {
  return (
    <DayLineChart
      line={line}
      now={now}
      name="Temperature"
      height={72}
      tone="page"
      format={{
        gutter: 0,
        shown: (value) => value,
        text: (value) => `${value}°C`,
        grid: (value) => `${value}°C`,
      }}
      scale={{ min: 0, max: 1000, lines: [0, 500, 1000] }}
    />
  );
}

const readout = () =>
  container.querySelector(".pointer-events-none")?.textContent ?? null;

describe("a day's line", () => {
  it("gives Now only the last pixel while nothing is kept yet", async () => {
    const width = 576;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      width,
    );
    await act(async () =>
      root.render(
        chart({ runs: [[{ at: now, value: 999 }]], min: 999, max: 999 }),
      ),
    );
    const plot = container.querySelector<HTMLElement>('[role="group"]')!;
    const point = async (x: number) =>
      act(async () =>
        plot.dispatchEvent(
          new MouseEvent("pointermove", { clientX: x, bubbles: true }),
        ),
      );
    await point(width * 0.75);
    expect(readout()).toMatch(/^Not known\d\d:\d\d$/);
    await point(width - 0.5);
    expect(readout()).toBe("999°CNow");
  });

  it("doesn't read Now across a stretch without readings before it", async () => {
    const width = 576;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      width,
    );
    // Nothing for the last 2 hours, then what it reads now on its own.
    const kept = { at: now - 2 * 60 * minute - 2.5 * minute, value: 50 };
    await act(async () =>
      root.render(
        chart({
          runs: [[kept], [{ at: now, value: 999 }]],
          min: 50,
          max: 999,
        }),
      ),
    );
    const plot = container.querySelector<HTMLElement>('[role="group"]')!;
    const point = async (x: number) =>
      act(async () =>
        plot.dispatchEvent(
          new MouseEvent("pointermove", { clientX: x, bubbles: true }),
        ),
      );
    const xOf = (at: number) => ((at - (now - dayMs)) / dayMs) * width;
    await point(xOf(now - 30 * minute));
    expect(readout()).toMatch(/^Not known\d\d:\d\d$/);
    await point(xOf(now - 4 * minute));
    expect(readout()).toMatch(/^Not known\d\d:\d\d$/);
    await point(width - 0.5);
    expect(readout()).toBe("999°CNow");
  });

  it("shows under the pointer the 5 minutes drawn there, and Now only at the end", async () => {
    // 2 px for each 5 minutes.
    const width = 576;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      width,
    );
    // Two 5 minutes mid-day, and the last kept, its middle 4 minutes ago.
    const kept = [143, 144].map((slot) => ({
      at: slotMiddle(slot),
      value: slot,
    }));
    const last = { at: now - 4 * minute, value: 287 };
    await act(async () =>
      root.render(
        chart({
          runs: [kept, [last, { at: now, value: 999 }]],
          min: 143,
          max: 999,
        }),
      ),
    );
    const plot = container.querySelector<HTMLElement>('[role="group"]')!;
    const point = async (x: number) =>
      act(async () =>
        plot.dispatchEvent(
          new MouseEvent("pointermove", { clientX: x, bubbles: true }),
        ),
      );
    const xOf = (at: number) => ((at - (now - dayMs)) / dayMs) * width;
    for (const { at, value } of [...kept, last]) {
      await point(xOf(at));
      expect(readout()).toMatch(new RegExp(`^${value}°C\\d\\d:\\d\\d$`));
    }
    await point(width - 0.5);
    expect(readout()).toBe("999°CNow");
  });

  it("reads now at its end, and every 5 minutes kept a step back at a time", async () => {
    const line = {
      runs: [
        [
          { at: now - 7.5 * minute, value: 54 },
          { at: now - 2.5 * minute, value: 55 },
          { at: now, value: 58 },
        ],
      ],
      min: 54,
      max: 58,
    };
    await act(async () =>
      root.render(
        <DayLineChart
          line={line}
          now={now}
          name="Temperature"
          height={72}
          tone="page"
          format={{
            gutter: 0,
            shown: (value) => value,
            text: (value) => `${value}°C`,
            grid: (value) => `${value}°C`,
          }}
          scale={{ min: 20, max: 90, lines: [20, 50, 80] }}
        />,
      ),
    );
    const chart = container.querySelector<HTMLElement>('[role="group"]')!;
    // Focus puts the cursor at the end, as End does.
    await act(async () => chart.focus());
    expect(container.querySelector(".pointer-events-none")?.textContent).toBe(
      "58°CNow",
    );
    await act(async () =>
      chart.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    // Steps back are the 5 minutes kept, the last of them first.
    expect(
      container.querySelector(".pointer-events-none")?.textContent,
    ).toMatch(/^55°C\d\d:\d\d$/);
    await act(async () =>
      chart.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(
      container.querySelector(".pointer-events-none")?.textContent,
    ).toMatch(/^54°C\d\d:\d\d$/);
  });
});
