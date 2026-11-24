// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DayBandChart,
  DayBandMarks,
  DayStripChart,
  DayTimeAxis,
  LineChart,
  WeekColumnsChart,
  WeekRangeChart,
  type BandSpan,
  type StripSpan,
  type WeekRange,
} from "../src/charts";
import { midnight } from "../src/charts/time";

// The charts' date formatters take the zone the page starts in, as a page's
// do, so the zone is set before they load, whatever the machine's own.
vi.hoisted(() => {
  process.env.TZ = "Europe/Zurich";
});

// @meetsanctum/ui-sdk/charts: whole charts from plain times and values, each
// with its readout, keyboard cursor and list for screen readers, the words
// they say their own unless the caller's props say others.

const hour = 60 * 60_000;
const now = Date.parse("2026-11-18T15:30:00+01:00");
const from = now - 24 * hour;
let container: HTMLDivElement;
let root: Root;

// The chart modules create their date formatters when imported.
vi.hoisted(() => vi.stubEnv("TZ", "Europe/Zurich"));
afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
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
});

const render = (element: ReactElement) => act(async () => root.render(element));
const group = () => container.querySelector<HTMLElement>('[role="group"]')!;
const readout = () =>
  container.querySelector(".pointer-events-none")?.textContent ?? null;
const listed = () =>
  [...container.querySelectorAll("ul.sr-only > li")].map(
    (item) => item.textContent,
  );
const press = (key: string) =>
  act(async () =>
    group().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );

type Owned = BandSpan & { said: string };
const band: Owned[] = [
  { from, to: from + 6 * hour, level: "unknown", said: "Not known" },
  { from: from + 6 * hour, to: from + 9 * hour, level: "off", said: "Quiet" },
  { from: from + 9 * hour, to: from + 10 * hour, level: "on", said: "Motion" },
  { from: from + 10 * hour, to: from + 14 * hour, level: "faint", said: "On" },
  { from: from + 14 * hour, to: now, level: "off", said: "Quiet" },
];

describe("a day's band", () => {
  it("draws each level and hands the caller's own span back for its words", async () => {
    await render(
      <DayBandChart
        spans={band}
        from={from}
        to={now}
        label="Motion over the last 24 hours"
        text={(span) => span.said}
      />,
    );
    expect(group().getAttribute("aria-label")).toBe(
      "Motion over the last 24 hours",
    );
    // Nothing for the unknown span; a hairline, a span, a faint fill, a hairline.
    const rects = [...container.querySelectorAll("svg rect")];
    expect(rects.map((rect) => rect.getAttribute("class"))).toEqual([
      "fill-white/30",
      "fill-white/70",
      "fill-white/16",
      "fill-white/30",
    ]);
    expect(listed()).toEqual([
      "15:30 to 21:30: Not known",
      "21:30 to 00:30: Quiet",
      "00:30 to 01:30: Motion",
      "01:30 to 05:30: On",
      "05:30 to 15:30: Quiet",
    ]);
    await act(async () => group().focus());
    expect(readout()).toBe("Quiet05:30–now");
    await press("Home");
    expect(readout()).toBe("Not known15:30–21:30");
  });

  it("says its times and when a span was in the caller's words", async () => {
    await render(
      <DayBandChart
        spans={band}
        from={from}
        to={now}
        label="Motion"
        text={(span) => span.said}
        time={(at) => `${new Date(at).getHours()}h`}
        about={(span) => `from ${new Date(span.from).getHours()}h`}
      />,
    );
    expect(listed()[0]).toBe("15h to 21h: Not known");
    await act(async () => group().focus());
    expect(readout()).toBe("Quietfrom 5h");
  });

  it("highlights the on span under the pointer even beside another on span", async () => {
    await render(
      <DayBandChart
        spans={[
          { from, to: from + 12 * hour, level: "on", said: "First" },
          { from: from + 12 * hour, to: now, level: "on", said: "Second" },
        ]}
        from={from}
        to={now}
        width={480}
        tone="page"
        label="Activity"
        text={(span) => span.said}
      />,
    );
    await act(async () =>
      group().dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 242,
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    expect(readout()).toMatch(/^Second/);
    expect(
      [...container.querySelectorAll("svg rect")].map((rect) =>
        rect.getAttribute("class"),
      ),
    ).toEqual(["fill-foreground/70", "fill-foreground"]);
  });
});

describe("a day's band marks", () => {
  it("draw the band with nothing to focus, press or list, so a button can hold them", async () => {
    await render(
      <button type="button">
        <DayBandMarks spans={band} from={from} to={now} width={480} />
      </button>,
    );
    const button = container.querySelector("button")!;
    expect(
      button.querySelectorAll("[tabindex], button, a, ul, li, div"),
    ).toHaveLength(0);
    expect(button.querySelector("span")!.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(button.querySelector("svg")!.getAttribute("width")).toBe("480");
    expect(button.querySelectorAll("rect")).toHaveLength(4);
  });

  it("draw nothing until their width is known", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(0);
    await render(<DayBandMarks spans={band} from={from} to={now} />);
    expect(container.querySelectorAll("rect")).toHaveLength(0);
  });
});

describe("a day's time axis", () => {
  it("shows the clock's 6 hours and Now, in the caller's words where given", async () => {
    await render(
      <DayTimeAxis from={from} to={now} width={480} withNow nowText="Jetzt" />,
    );
    expect(
      [...container.querySelectorAll("span")].map((each) => each.textContent),
    ).toEqual(["18:00", "00:00", "06:00", "12:00", "Jetzt"]);
    expect(container.querySelector("[tabindex]")).toBeNull();
  });
});

describe("a day's strip", () => {
  const spans: StripSpan[] = [
    { from, to: from + 4 * hour, mark: "unknown" },
    { from: from + 4 * hour, to: from + 12 * hour, mark: "off" },
    {
      from: from + 12 * hour,
      to: from + 18 * hour,
      mark: { level: 50, colour: "#ff8800" },
    },
    { from: from + 18 * hour, to: now, mark: { level: null, colour: "#fff" } },
  ];

  it("fills each span on as high as its level, with its 100% at the top", async () => {
    await render(<DayStripChart spans={spans} from={from} to={now} levels />);
    expect(group().getAttribute("aria-label")).toBe(
      "Brightness over the last 24 hours",
    );
    expect(group().style.width).toBe("480px");
    const fills = [...container.querySelectorAll("path")].map((path) => [
      path.getAttribute("fill"),
      path.getAttribute("d"),
    ]);
    expect(fills).toEqual([
      [null, "M80 87h160v1h-160z"],
      ["#ff8800", "M240 44h120v44h-120z"],
      ["#ff8800", "M240 44h120v2h-120z"],
      ["#fff", "M360 0h120v88h-120z"],
      ["#fff", "M360 0h120v2h-120z"],
    ]);
    expect(container.textContent).toContain("100%");
    expect(listed()).toEqual([
      "15:30 to 19:30: Not known",
      "19:30 to 03:30: Off",
      "03:30 to 09:30: 50%",
      "09:30 to 15:30: On",
    ]);
  });

  it("says its words as the caller's props say them", async () => {
    await render(
      <DayStripChart
        spans={spans}
        from={from}
        to={now}
        levels
        label="Helligkeit"
        full="Voll"
        text={(span) => (span ? "Etwas" : "Nichts")}
      />,
    );
    expect(group().getAttribute("aria-label")).toBe("Helligkeit");
    expect(container.textContent).toContain("Voll");
    expect(listed()[0]).toBe("15:30 to 19:30: Etwas");
  });

  it("fills the flat strip for an on span with a numeric level", async () => {
    await render(
      <DayStripChart spans={spans} from={from} to={now} width={480} />,
    );
    expect(group().style.height).toBe("40px");
    expect(
      container.querySelector('path[fill="#ff8800"]')?.getAttribute("d"),
    ).toBe("M240 0h120v40h-120z");
  });
});

describe("a day's line", () => {
  const runs = [
    [
      { at: from + 2 * hour, value: 20 },
      { at: from + 3 * hour, value: 22 },
    ],
    [{ at: now, value: 30 }],
  ];
  const format = {
    gutter: 40,
    shown: (value: number) => value,
    text: (value: number) => `${value}°`,
    grid: (value: number) => `${value}°`,
  };

  it("is broken where nothing was known, and turns the danger colour past a limit", async () => {
    await render(
      <LineChart
        runs={[[], ...runs]}
        now={now}
        format={format}
        name="Temperature"
        height={100}
        width={519}
        scale={{ min: 0, max: 40, lines: [0, 20, 40] }}
        above={25}
      />,
    );
    expect(group().getAttribute("aria-label")).toBe(
      "Temperature over the last 24 hours",
    );
    const [line, danger] = container.querySelectorAll("g");
    expect(line!.querySelectorAll("polyline")).toHaveLength(1);
    expect(line!.querySelectorAll("circle")).toHaveLength(1);
    expect(danger!.getAttribute("class")).toBe(
      "fill-(--danger) stroke-(--danger)",
    );
    const clip = container.querySelector("clipPath")!;
    expect(clip.id).toBeTruthy();
    expect(danger!.getAttribute("clip-path")).toBe(`url(#${clip.id})`);
    const rect = clip.querySelector("rect")!;
    expect(
      Number(rect.getAttribute("y")) + Number(rect.getAttribute("height")),
    ).toBe(37.5);
    const tick = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "18:00",
    );
    expect(parseFloat(tick!.style.left)).toBeCloseTo((2.5 / 24) * 479);
    await act(async () => group().focus());
    expect(readout()).toBe("30°Now");
    await press("ArrowLeft");
    expect(readout()).toMatch(/^Not known\d\d:\d\d$/);
  });

  it("says its words as the caller's props say them", async () => {
    await render(
      <LineChart
        runs={runs}
        now={now}
        format={format}
        name="Temperature"
        height={100}
        hours={false}
        label="Temperatur"
        unknown="Unbekannt"
        nowText="Jetzt"
      />,
    );
    expect(group().getAttribute("aria-label")).toBe("Temperatur");
    expect(
      [...container.querySelectorAll("span")].map((span) => span.textContent),
    ).not.toContain("18:00");
    await act(async () => group().focus());
    expect(readout()).toBe("30°Jetzt");
    await press("ArrowLeft");
    expect(readout()).toMatch(/^Unbekannt\d\d:\d\d$/);
  });
});

// Built in the same time zone as the charts' date formatters.
const week = () => [6, 5, 4, 3, 2, 1, 0].map((back) => midnight(now, back));

describe("a week's columns", () => {
  const days = () =>
    week().map((start, index) => ({
      start,
      value: index === 0 ? null : index === 1 ? 0 : index,
    }));

  it("tops hours with a round number of them, and tells a day without any from one not known", async () => {
    await render(
      <WeekColumnsChart
        days={days()}
        now={now}
        scale="hours"
        label="How long it was on each day"
        text={(day) => `${day.value} h on`}
        spoken={(day) => `on for ${day.value} h`}
      />,
    );
    expect(container.querySelectorAll("path")).toHaveLength(5);
    expect(container.textContent).toMatch(/^6 h/);
    expect(listed()).toEqual([
      "Thu 12 Nov: Not known",
      "Fri 13 Nov: Off",
      "Sat 14 Nov: on for 2 h",
      "Sun 15 Nov: on for 3 h",
      "Mon 16 Nov: on for 4 h",
      "Tue 17 Nov: on for 5 h",
      "Wed 18 Nov: on for 6 h",
    ]);
    expect(container.textContent).toContain("Today");
    await act(async () => group().focus());
    expect(readout()).toBe("6 h onWed 18 Nov");
  });

  it("tops counts with a round count, and says its words as the caller's props say them", async () => {
    await render(
      <WeekColumnsChart
        days={days()}
        now={now}
        scale="counts"
        label="How often it opened each day"
        text={(day) => `${day.value} times`}
        spoken={(day) => `opened ${day.value} times`}
        none="Never"
        unknown="Unbekannt"
        today="Heute"
        topText={(top) => `${top} times`}
        dayName={() => "Day"}
        date={(start) => new Date(start).toISOString().slice(0, 10)}
      />,
    );
    expect(container.textContent).toContain("10 times");
    expect(container.textContent).toContain("Heute");
    expect(container.textContent).toContain("Day");
    expect(listed().slice(0, 2)).toEqual([
      "2026-11-11: Unbekannt",
      "2026-11-12: Never",
    ]);
  });
});

describe("a week's ranges", () => {
  const days = () =>
    week().map((start, index): WeekRange =>
      index === 2
        ? { start, min: null, max: null }
        : { start, min: 18 + index * 0.5, max: 21 + index * 0.5 },
    );
  const format = {
    gutter: 36,
    shown: (value: number) => value,
    grid: (value: number) => `${value}°`,
    range: (min: number, max: number) => `${min}–${max}°`,
  };

  it("draws a bar a day from its lowest to its highest on round gridlines", async () => {
    await render(
      <WeekRangeChart
        days={days()}
        now={now}
        format={format}
        name="Temperature"
      />,
    );
    expect(group().getAttribute("aria-label")).toBe(
      "Each day's lowest and highest temperature",
    );
    expect(container.querySelectorAll('rect[rx="4"]')).toHaveLength(6);
    expect(listed()[2]).toBe("Sat 14 Nov: Not known");
    await press("Home");
    expect(readout()).toBe("18–21°Thu 12 Nov");
  });

  it("announces the date and range of a tapped day", async () => {
    await render(
      <WeekRangeChart
        days={days()}
        now={now}
        format={format}
        name="Temperature"
        width={456}
      />,
    );
    const plot = group();
    // The fourth of seven 60 px days; a tap goes straight to click.
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) {
        plot.dispatchEvent(
          new PointerEvent(type, {
            clientX: 210,
            bubbles: true,
            pointerType: "touch",
            isPrimary: true,
            pointerId: 1,
          }),
        );
      }
      plot.dispatchEvent(
        new MouseEvent("click", { clientX: 210, bubbles: true, detail: 1 }),
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Sun 15 Nov: 19.5–22.5°",
    );
  });

  it("says its words as the caller's props say them", async () => {
    await render(
      <WeekRangeChart
        days={days()}
        now={now}
        format={format}
        name="Temperature"
        label="Temperatur"
        unknown="Unbekannt"
        width={300}
        tone="page"
      />,
    );
    expect(group().getAttribute("aria-label")).toBe("Temperatur");
    expect(group().style.width).toBe("264px");
    expect(container.querySelector('rect[rx="4"]')?.getAttribute("class")).toBe(
      "fill-foreground/70",
    );
    expect(container.querySelector("span.text-muted-foreground")).toBeTruthy();
    expect(listed()[2]).toBe("Sat 14 Nov: Unbekannt");
  });
});
