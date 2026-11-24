// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LineChart, type DaysLineChartProps } from "../src/charts";

// Days as lines (charts/days-line.tsx): a point a day for up to three
// lines, a readout with a row for each, and each day listed for screen
// readers.

const day = 24 * 60 * 60_000;
const today = Date.parse("2026-11-24T00:00:00Z");
// Five days, the last today.
const days = [4, 3, 2, 1, 0].map((back) => today - back * day);
const date = (start: number) => new Date(start).toISOString().slice(5, 10);
let container: HTMLDivElement;
let root: Root;

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

const render = (element: ReactElement) => act(async () => root.render(element));
const group = () => container.querySelector<HTMLElement>('[role="group"]')!;
const readout = () =>
  container.querySelector(".pointer-events-none")?.textContent ?? null;
const spoken = () => container.querySelector('[role="status"]')?.textContent;
const press = (key: string) =>
  act(async () => {
    group().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

const series = [
  { key: "mac", name: "Office Mac", values: [10, 20, null, 40, 50] },
  { key: "router", name: "Router", values: [5, 5, 5, 5, 0] },
] as const satisfies DaysLineChartProps["series"];
// 241 px wide less a 40 px gutter: 201 px, a day every 50 px.
const chart = (
  shown: DaysLineChartProps["series"] = series,
  shownDays = days,
  overrides: Partial<Pick<DaysLineChartProps, "format" | "scale">> = {},
) => (
  <LineChart
    mode="days"
    days={shownDays}
    series={shown}
    format={{
      gutter: 40,
      shown: (value) => value,
      text: (value) => `${value} tokens`,
      grid: (value) => `${value}`,
    }}
    scale={{ min: 0, max: 100, lines: [0, 50, 100] }}
    name="Tokens used"
    height={100}
    date={date}
    width={241}
    tone="page"
    {...overrides}
  />
);

describe("days as lines", () => {
  it("draws each line in its series colour, a day on each pixel's middle, broken where a day wasn't known", async () => {
    await render(chart());
    const [mac, router] = container.querySelectorAll("svg g");
    expect((mac as SVGGElement).style.stroke).toBe("var(--series-1)");
    expect((router as SVGGElement).style.stroke).toBe("var(--series-2)");
    expect(
      [...mac!.querySelectorAll("polyline")].map((line) =>
        line.getAttribute("points"),
      ),
    ).toEqual(["0.5,90 50.5,80", "150.5,60 200.5,50"]);
    expect(router!.querySelector("polyline")!.getAttribute("points")).toBe(
      "0.5,95 50.5,95 100.5,95 150.5,95 200.5,100",
    );
    expect(group().getAttribute("aria-label")).toBe("Tokens used each day");
  });

  it("names its first day, its middle one and Today under it", async () => {
    await render(chart());
    const names = container.querySelectorAll<HTMLElement>(
      '[aria-hidden="true"].relative.mt-2 > span',
    );
    expect([...names].map((name) => name.textContent)).toEqual([
      "11-20",
      "11-22",
      "Today",
    ]);
    expect(names[1]!.style.left).toBe("100.5px");
  });

  it("reads each line's value for a day, in a row each", async () => {
    await render(chart());
    await act(async () => group().focus());
    expect(readout()).toBe("TodayOffice Mac50 tokensRouter0 tokens");
    expect(spoken()).toBe("Today: Office Mac 50 tokens, Router 0 tokens");
    await press("Home");
    await press("ArrowRight");
    await press("ArrowRight");
    expect(readout()).toBe("11-22Office MacNot knownRouter5 tokens");
    const cursor = container.querySelector("svg > rect:last-of-type")!;
    expect(cursor.getAttribute("x")).toBe("100");
    // A dot for the known line only.
    expect(container.querySelectorAll("svg > circle")).toHaveLength(1);
  });

  it("reads one line inside the plot, beside the cursor", async () => {
    await render(chart([series[0]]));
    await act(async () => group().focus());
    expect(readout()).toBe("50 tokensToday");
    expect(spoken()).toBe("Today: 50 tokens");
    const popover = group().querySelector<HTMLElement>(".pointer-events-none")!;
    expect(popover.classList.contains("top-0")).toBe(true);
    expect(popover.style.right).toBe("8px");
  });

  it("scales in displayed units using the supplied days", async () => {
    await render(
      chart(
        [
          { key: "mac", name: "Office Mac", values: [200, 500, null, 400] },
          {
            key: "router",
            name: "Router",
            values: [200, 200, 200, 200, 200, 9000],
          },
        ],
        days,
        {
          scale: undefined,
          format: {
            gutter: 40,
            shown: (value) => value / 10,
            text: (value) => `${value / 10} units`,
            grid: (value) => `${value} units`,
          },
        },
      ),
    );
    expect(
      [...container.querySelectorAll("span.absolute.right-0.tabular-nums")].map(
        (label) => label.textContent,
      ),
    ).toEqual(["20 units", "40 units"]);
    const [mac, router] = container.querySelectorAll("svg g");
    expect(mac!.querySelector("polyline")?.getAttribute("points")).toBe(
      "0.5,80 50.5,20",
    );
    expect(mac!.querySelector("circle")?.getAttribute("cy")).toBe("40");
    expect(router!.querySelector("polyline")?.getAttribute("points")).toBe(
      "0.5,80 50.5,80 100.5,80 150.5,80 200.5,80",
    );
    await act(async () => group().focus());
    expect(spoken()).toBe("Today: Office Mac Not known, Router 20 units");
  });

  it("lists each day for screen readers", async () => {
    await render(chart());
    expect(
      [...container.querySelectorAll("ul.sr-only > li")].map(
        (item) => item.textContent,
      ),
    ).toEqual([
      "11-20: Office Mac 10 tokens, Router 5 tokens",
      "11-21: Office Mac 20 tokens, Router 5 tokens",
      "11-22: Office Mac Not known, Router 5 tokens",
      "11-23: Office Mac 40 tokens, Router 5 tokens",
      "Today: Office Mac 50 tokens, Router 0 tokens",
    ]);
  });

  it("keeps a pinned day as a new day begins, and clears it once the day has gone", async () => {
    await render(chart());
    await act(async () => group().focus());
    await press("Home");
    await press("ArrowRight");
    expect(spoken()).toBe("11-21: Office Mac 20 tokens, Router 5 tokens");
    const next = [...days.slice(1), today + day];
    const advance = (line: (typeof series)[number]) => ({
      ...line,
      values: [...line.values.slice(1), 0],
    });
    const moved = [advance(series[0]), advance(series[1])] as const;
    await render(chart(moved, next));
    expect(readout()).toBe("11-21Office Mac20 tokensRouter5 tokens");
    await render(
      chart(
        moved,
        next.map((start) => start + day),
      ),
    );
    expect(readout()).toBeNull();
  });
});
