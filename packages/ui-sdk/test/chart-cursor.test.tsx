// @vitest-environment jsdom
import { homeClock } from "@meetsanctum/app-sdk/clock";
import { Sun } from "lucide-react";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DayBandChart,
  DayStripChart,
  LineChart,
  WeekColumnsChart,
  type BandSpan,
  type LinePoint,
  type WeekColumn,
} from "../src/charts";
import { HomeTimeZoneProvider } from "../src/home-clock";
import { SwipePages } from "../src/swipe-pages";

// Every chart's cursor (charts/cursor.tsx): a mouse's hover shows the
// readout, a click or a tap pins it, and the pin holds its point through
// the minute and a reload, until Escape, a tap on it again, or its point
// leaving the chart.

// The home is in Zurich and the device in Los Angeles, so a day or a time
// worked out in the device's zone shows.
vi.hoisted(() => {
  process.env.TZ = "America/Los_Angeles";
});
const zurich = homeClock({ timeZone: "Europe/Zurich" });

const minute = 60_000;
const hour = 60 * minute;
const now = Date.parse("2026-11-18T15:30:00+01:00");
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (element: ReactElement) =>
  act(async () =>
    root.render(
      <HomeTimeZoneProvider timeZone="Europe/Zurich">
        {element}
      </HomeTimeZoneProvider>,
    ),
  );
const group = () => container.querySelector<HTMLElement>('[role="group"]')!;
const readout = () =>
  container.querySelector(".pointer-events-none")?.textContent ?? null;
const spoken = () => container.querySelector('[role="status"]')?.textContent;
const pinned = () => group().hasAttribute("data-pinned");

function pointer(
  type: string,
  x: number,
  pointerType: "mouse" | "touch" = "mouse",
  target: Element = group(),
) {
  return act(async () => {
    const event = new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: 20,
      pointerType,
      isPrimary: true,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    target.dispatchEvent(event);
  });
}
// What React reads as the pointer leaving: it going out to the page.
const leave = () =>
  act(async () => {
    group().dispatchEvent(
      new PointerEvent("pointerout", {
        bubbles: true,
        pointerType: "mouse",
        relatedTarget: document.body,
      }),
    );
  });
const click = (x: number, target: Element = group()) =>
  act(async () => {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: x, detail: 1 }),
    );
  });
// A tap: down, up and the click it makes, with no move in between.
async function tap(x: number, pointerType: "mouse" | "touch" = "touch") {
  await pointer("pointerdown", x, pointerType);
  await pointer("pointerup", x, pointerType);
  await click(x);
}
async function press(key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => group().dispatchEvent(event));
  return event;
}

// A week of counts, 1 on the first day to 7 today.
const week = (days = 7, upTo = now): WeekColumn[] =>
  Array.from({ length: days }, (_, index) => ({
    start: zurich.startOfDay(upTo, days - 1 - index),
    value: index + 1,
  }));
// 520 px, less the 40 px gutter: a day is 480 / 7 px wide.
const dayX = (index: number) => Math.round((480 / 7) * (index + 0.5));
const columns = (days: WeekColumn[], at = now) => (
  <WeekColumnsChart
    days={days}
    now={at}
    scale="counts"
    label="How often it opened each day"
    text={(day) => `${day.value} times`}
    spoken={(day) => `opened ${day.value} times`}
    tone="page"
    width={520}
  />
);

describe("a chart's cursor", () => {
  it("shows a mouse's hover, but not a finger moving over it", async () => {
    await render(columns(week()));
    await pointer("pointermove", dayX(2), "touch");
    expect(readout()).toBeNull();
    await pointer("pointermove", dayX(2));
    expect(readout()).toBe("3 timesSat 14 Nov");
    await leave();
    expect(readout()).toBeNull();
    expect(pinned()).toBe(false);
  });

  it("pins on a tap, moves on a tap elsewhere, and clears on a tap on it again", async () => {
    await render(columns(week()));
    await tap(dayX(2));
    expect(readout()).toBe("3 timesSat 14 Nov");
    expect(pinned()).toBe(true);
    expect(spoken()).toBe("Sat 14 Nov: 3 times");
    await tap(dayX(5));
    expect(readout()).toBe("6 timesTue 17 Nov");
    await tap(dayX(5) + 10);
    expect(readout()).toBeNull();
    expect(pinned()).toBe(false);
    expect(spoken()).toBe("");
  });

  it("shows a hover over its pin, and the pin again once the mouse leaves", async () => {
    await render(columns(week()));
    await tap(dayX(1), "mouse");
    await pointer("pointermove", dayX(4));
    expect(readout()).toMatch(/^5 times/);
    // A hover is no news to a screen reader.
    expect(spoken()).toMatch(/: 2 times$/);
    await leave();
    expect(readout()).toMatch(/^2 times/);
  });

  it("ignores a swipe's click and pins again when the original plot receives focus", async () => {
    await render(
      <SwipePages
        label="Device"
        pages={["First", "Second"].map((label) => ({
          id: label.toLowerCase(),
          label,
          icon: Sun,
          content: columns(week()),
        }))}
      />,
    );
    const plot = group();
    await pointer("pointerdown", 300, "touch", plot);
    await pointer("pointermove", 200, "touch", plot);
    const surface = container.querySelector("[data-swiping]")!.parentElement!;
    surface.setPointerCapture = vi.fn();
    await pointer("pointerup", 200, "touch", surface);
    await click(200, plot);
    expect(container.querySelector("[data-pinned]")).toBeNull();
    expect(
      container
        .querySelector('[aria-label="Second"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    // A tap with no move pins as anywhere else.
    const shown = container.querySelector(
      '[role="tabpanel"][id$="-second"] [role="group"]',
    )!;
    await pointer("pointerdown", dayX(3), "touch", shown);
    await pointer("pointerup", dayX(3), "touch", shown);
    await click(dayX(3), shown);
    expect(shown.hasAttribute("data-pinned")).toBe(true);
    const firstTab = container.querySelector<HTMLElement>(
      '[role="tab"][aria-label="First"]',
    )!;
    await click(0, firstTab);
    await act(async () => firstTab.focus());
    await act(async () => plot.focus());
    expect(readout()).toBe("7 timesWed 18 Nov");
  });

  it("takes the first Escape to clear its pin and leaves the next to what is around it", async () => {
    const around = vi.fn();
    window.addEventListener("keydown", around);
    try {
      await render(columns(week()));
      await tap(dayX(2));
      const first = await press("Escape");
      expect(first.defaultPrevented).toBe(true);
      expect(around).not.toHaveBeenCalled();
      expect(readout()).toBeNull();
      expect(pinned()).toBe(false);
      const second = await press("Escape");
      expect(second.defaultPrevented).toBe(false);
      expect(around).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", around);
    }
  });

  it("steps by a day, by 4 with Shift, and to either end, saying where it is", async () => {
    await render(columns(week()));
    await act(async () => group().focus());
    expect(readout()).toBe("7 timesWed 18 Nov");
    expect(spoken()).toBe("Wed 18 Nov: 7 times");
    await press("ArrowLeft");
    expect(spoken()).toBe("Tue 17 Nov: 6 times");
    await press("ArrowLeft", true);
    expect(spoken()).toBe("Fri 13 Nov: 2 times");
    await press("ArrowLeft", true);
    expect(spoken()).toBe("Thu 12 Nov: 1 times");
    await press("End");
    expect(spoken()).toBe("Wed 18 Nov: 7 times");
    await press("Home");
    expect(spoken()).toBe("Thu 12 Nov: 1 times");
    await press("ArrowRight");
    expect(readout()).toBe("2 timesFri 13 Nov");
  });

  it("pins where a press lands, not at the end its focus would show", async () => {
    await render(columns(week()));
    await pointer("pointerdown", dayX(1), "mouse");
    await act(async () => group().focus());
    expect(readout()).toBeNull();
    await pointer("pointerup", dayX(1), "mouse");
    await click(dayX(1));
    expect(readout()).toBe("2 timesFri 13 Nov");
  });

  it("pins the latest day on a tap, which focuses once the finger has lifted", async () => {
    await render(columns(week()));
    await pointer("pointerdown", dayX(6), "touch");
    await pointer("pointerup", dayX(6), "touch");
    await act(async () => group().focus());
    await click(dayX(6));
    expect(readout()).toBe("7 timesWed 18 Nov");
    expect(pinned()).toBe(true);
  });

  it("pins on focus after a mouse press is released outside the plot", async () => {
    await render(columns(week()));
    await pointer("pointerdown", dayX(1));
    await act(async () => group().focus());
    expect(readout()).toBeNull();
    await pointer("pointerup", 600, "mouse", document.body);
    await act(async () => group().blur());
    await act(async () => group().focus());
    expect(readout()).toBe("7 timesWed 18 Nov");
  });

  it("updates the pinned count without announcing a refresh", async () => {
    const days = week();
    await render(columns(days));
    await tap(dayX(2));
    expect(readout()).toBe("3 timesSat 14 Nov");
    expect(spoken()).toBe("Sat 14 Nov: 3 times");
    await render(
      columns(
        days.map((day, index) => (index === 2 ? { ...day, value: 4 } : day)),
      ),
    );
    expect(readout()).toBe("4 timesSat 14 Nov");
    expect(spoken()).toBe("Sat 14 Nov: 3 times");
  });

  it("keeps a pinned day as the week moves on, and clears it once the day has gone", async () => {
    await render(columns(week()));
    await tap(dayX(1));
    expect(readout()).toBe("2 timesFri 13 Nov");
    const tomorrow = now + 24 * hour;
    const next = week(8, tomorrow).slice(1);
    await render(columns(next, tomorrow));
    // Fri 13 Nov is the first day now, its value as it was.
    expect(readout()).toBe("2 timesFri 13 Nov");
    await render(columns(week(8, now + 48 * hour).slice(1), now + 48 * hour));
    expect(readout()).toBeNull();
    expect(pinned()).toBe(false);
  });
});

describe("a pinned line", () => {
  const width = 576;
  // A reading every 5 minutes, at their middles, its value the minutes
  // since the day began.
  const runsAt = (at: number): LinePoint[][] => {
    const start = Math.ceil((at - 24 * hour) / (5 * minute)) * 5 * minute;
    const run: LinePoint[] = [];
    for (let each = start + 2.5 * minute; each < at; each += 5 * minute) {
      run.push({ at: each, value: Math.round((each - start) / minute) });
    }
    return [run];
  };
  const line = (at: number, runs = runsAt(at)) => (
    <LineChart
      runs={runs}
      now={at}
      name="Temperature"
      height={72}
      tone="page"
      width={width}
      format={{
        gutter: 0,
        shown: (value) => value,
        text: (value) => `${value}°C`,
        grid: (value) => `${value}°C`,
      }}
      scale={{ min: 0, max: 1500, lines: [0, 1500] }}
    />
  );

  it("holds its reading as the minute moves on and the data reloads", async () => {
    await render(line(now));
    await tap(width / 2);
    const held = readout();
    expect(held).toMatch(/^\d+°C\d\d:\d\d$/);
    expect(spoken()).toBe(`${held!.slice(-5)}: ${held!.slice(0, -5)}`);
    for (const at of [now + minute, now + 2 * minute, now + 3 * minute]) {
      await render(line(at, runsAt(now)));
      expect(readout()).toBe(held);
    }
    // A reload: the same readings in new arrays.
    await render(
      line(
        now + 3 * minute,
        runsAt(now).map((run) => [...run]),
      ),
    );
    expect(readout()).toBe(held);
  });

  it("clears once its reading has left the day", async () => {
    await render(line(now));
    await tap(2);
    expect(readout()).not.toBeNull();
    await render(line(now + 10 * minute));
    expect(readout()).toBeNull();
    expect(pinned()).toBe(false);
  });

  it("updates a stationary mouse's readout and pins that reading on click", async () => {
    const x = width / 2;
    const runs = runsAt(now);
    await render(line(now, runs));
    await pointer("pointermove", x);
    expect(readout()).toBe("723°C03:32");
    await render(line(now + 5 * minute, runs));
    expect(readout()).toBe("728°C03:37");
    await click(x);
    expect(readout()).toBe("728°C03:37");
    expect(spoken()).toBe("03:37: 728°C");
    await leave();
    expect(readout()).toBe("728°C03:37");
  });

  it("steps left past a reading on the next slot's boundary", async () => {
    const at = now + 2.5 * minute;
    await render(
      line(at, [
        [
          { at: at - 5 * minute, value: 12 },
          { at, value: 15 },
        ],
      ]),
    );
    await press("End");
    await press("ArrowLeft");
    expect(readout()).toBe("12°C15:27");
    await press("ArrowLeft");
    expect(readout()).toBe("Not known15:25");
    await press("ArrowLeft");
    expect(readout()).toBe("Not known15:20");
  });

  it("clears a historical pin when the window moves back past it", async () => {
    await render(line(now));
    await tap(width - 1);
    expect(readout()).toBe("1438°C15:27");
    await render(line(now - hour));
    expect(readout()).toBeNull();
    expect(pinned()).toBe(false);
  });

  it("keeps Now pinned as the reading changes and clears it when the reading is gone", async () => {
    await render(line(now, [...runsAt(now), [{ at: now, value: 18 }]]));
    await tap(width - 1);
    expect(readout()).toBe("18°CNow");
    const later = now + minute;
    await render(line(later, [...runsAt(later), [{ at: later, value: 19 }]]));
    expect(readout()).toBe("19°CNow");
    expect(pinned()).toBe(true);
    await render(line(later));
    expect(readout()).toBeNull();
    expect(pinned()).toBe(false);
  });
});

describe("the other charts' pins", () => {
  it("holds a snapped band pin through a resize and steps from span to span", async () => {
    const from = now - 24 * hour;
    const spans: (BandSpan & { said: string })[] = [
      { from, to: from + 9 * hour, level: "off", said: "Quiet" },
      {
        from: from + 9 * hour,
        to: from + 10 * hour,
        level: "on",
        said: "Motion",
      },
      { from: from + 10 * hour, to: now, level: "off", said: "Quiet" },
    ];
    const band = (at: number, width = 480) => (
      <DayBandChart
        spans={spans}
        from={at - 24 * hour}
        to={at}
        label="Motion over the last 24 hours"
        text={(span) => span.said}
        width={width}
      />
    );
    await render(band(now, 240));
    await tap(87);
    expect(readout()).toBe("Motion00:30–01:30");
    await render(band(now));
    expect(readout()).toBe("Motion00:30–01:30");
    await render(band(now + minute));
    expect(readout()).toBe("Motion00:30–01:30");
    await press("ArrowRight");
    // Its span ended a minute ago, as the chart moved on.
    expect(spoken()).toBe("01:30–15:30: Quiet");
    await tap(400);
    expect(readout()).toBeNull();
  });

  it("steps by key onto a short span beside an on span, which a pointer there would snap to", async () => {
    const from = now - 24 * hour;
    const spans: (BandSpan & { said: string })[] = [
      { from, to: now - 20 * minute, level: "off", said: "Quiet" },
      {
        from: now - 20 * minute,
        to: now - 6 * minute,
        level: "on",
        said: "Motion",
      },
      { from: now - 6 * minute, to: now, level: "off", said: "Quiet" },
    ];
    await render(
      <DayBandChart
        spans={spans}
        from={from}
        to={now}
        label="Motion over the last 24 hours"
        text={(span) => span.said}
        width={480}
      />,
    );
    await act(async () => group().focus());
    expect(readout()).toBe("Quiet15:24–now");
    await press("ArrowLeft");
    expect(readout()).toBe("Motion15:10–15:24");
    await press("ArrowRight");
    expect(readout()).toBe("Quiet15:24–now");
    await pointer("pointermove", 479);
    expect(readout()).toBe("Motion15:10–15:24");
    await leave();
    expect(readout()).toBe("Quiet15:24–now");
  });

  it("holds a strip's quarter hour as the day moves on", async () => {
    const from = now - 24 * hour;
    const strip = (at: number) => (
      <DayStripChart
        spans={[
          { from, to: from + 12 * hour, mark: "off" },
          {
            from: from + 12 * hour,
            to: now,
            mark: { level: null, colour: "#fc0" },
          },
        ]}
        from={at - 24 * hour}
        to={at}
        width={480}
      />
    );
    await render(strip(now));
    await tap(100);
    const held = readout();
    expect(held).toMatch(/^Off\d\d:\d\d$/);
    await render(strip(now + 5 * minute));
    expect(readout()).toBe(held);
    await render(strip(now - 20 * hour));
    expect(readout()).toBeNull();
    expect(pinned()).toBe(false);
  });
});
