// @vitest-environment jsdom
import type {
  AppInfo,
  EntityInfo,
  Forecast,
  LiveMessage,
  SunTimes,
  TemperatureUnit,
} from "@meetsanctum/app-sdk";
import type { HourCycle } from "@meetsanctum/app-sdk/clock";
import {
  AppScope,
  HomeTimeZoneProvider,
  TemperatureUnitProvider,
  type AppClient,
  type LiveListener,
} from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { weatherCard } from "../../src/card";
import ui from "../../src/ui/index";
import { forecast, morning } from "../sample";

// Weather's page: the weather now, the next 24 hours, the next ten days,
// today's measures and the sun, for a home without a location, one whose
// forecast has not come yet, one with both, and one whose forecast was kept
// while Open-Meteo could not be reached. Times are written as the device
// writes them, so the tests take either a 24-hour or a 12-hour clock.

const sun: SunTimes = {
  date: "2026-10-29",
  timeZone: "Europe/Zurich",
  days: [
    {
      date: "2026-10-28",
      sunrise: "2026-10-28T06:04:00.000Z",
      sunset: "2026-10-28T16:17:40.000Z",
      solarNoon: "2026-10-28T11:10:50.000Z",
    },
    {
      date: "2026-10-29",
      sunrise: "2026-10-29T06:05:30.452Z",
      sunset: "2026-10-29T16:16:02.464Z",
      solarNoon: "2026-10-29T11:10:46.458Z",
    },
    {
      date: "2026-10-30",
      sunrise: "2026-10-30T06:07:00.862Z",
      sunset: "2026-10-30T16:14:26.000Z",
      solarNoon: "2026-10-30T11:10:43.000Z",
    },
  ],
};
const entity = (
  key: string,
  type: string,
  state: unknown,
  name = "Home",
): EntityInfo => ({
  app: "sanctum.weather",
  key,
  type,
  name,
  state,
  updatedAt: "2026-10-29T08:58:00.000Z",
});

function fakeClient(entities: EntityInfo[]) {
  const listeners = new Set<LiveListener>();
  const app: AppInfo = {
    id: "sanctum.weather",
    name: "Weather",
    version: "0.2.0",
    icon: { glyph: "cloud-sun", color: "sky" },
    pages: ["main"],
    permissions: ["places.location", "net:api.open-meteo.com"],
    requests: [],
    state: "running",
    settings: null,
    provides: {
      entities: [],
      widgets: [
        {
          id: weatherCard.id,
          title: weatherCard.title,
          size: weatherCard.size,
        },
      ],
      roomSections: [],
      devicePages: [],
    },
  };
  const client: AppClient = {
    app,
    call: vi.fn(),
    places: vi.fn(),
    devices: vi.fn(),
    command: vi.fn(),
    entities: vi.fn(async () => entities),
    settings: vi.fn(async () => ({})),
    capturePresses: vi.fn(),
    ask: vi.fn(async () => true),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const push = (message: LiveMessage) => {
    for (const listener of listeners) listener.message?.(message);
  };
  return {
    client,
    push,
    refresh: () => {
      for (const listener of listeners) listener.refresh?.();
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The device is in Los Angeles, so a time still written in its zone fails.
  vi.stubEnv("TZ", "America/Los_Angeles");
  // Ten in the morning in Zurich, two minutes after the forecast was fetched.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(morning);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sunEntity = entity("sun", "sun", sun);
const forecastEntity = (state: Forecast = forecast) =>
  entity("forecast", "weather.forecast", state);
const shown = [sunEntity, forecastEntity()];

// Its page as the shell shows it, in the unit and the time zone the home
// shows, or before the shell knows the unit.
async function show(
  client: AppClient,
  unit: TemperatureUnit | "unknown" = "celsius",
  hourCycle: HourCycle = "24h",
) {
  const Main = ui.pages.main!;
  await act(async () => {
    root.render(
      <TemperatureUnitProvider unit={unit === "unknown" ? undefined : unit}>
        <HomeTimeZoneProvider timeZone="Europe/Zurich" hourCycle={hourCycle}>
          <AppScope client={client}>
            <Main
              params={{}}
              open={() => {}}
              back={() => {}}
              openSettings={() => {}}
            />
          </AppScope>
        </HomeTimeZoneProvider>
      </TemperatureUnitProvider>,
    );
  });
  return container.textContent ?? "";
}

// A section of the page, by its heading.
const section = (title: string) => {
  const heading = [...container.querySelectorAll("h2")].find(
    (each) => each.textContent === title,
  );
  return heading?.closest("section") ?? null;
};
const texts = (within: Element | null, selector: string) =>
  [...(within?.querySelectorAll(selector) ?? [])].map(
    (each) => each.textContent,
  );
// A time as the home writes it with 24 hours, such as 07:05 or 16:00.
const time = (hour: number, minute = "00") =>
  `${String(hour).padStart(2, "0")}:${minute}`;
// Friday, the day after the forecast's.
const friday = "Fri";
// An hour above its column, such as 16:00.
const column = (hour: number) => new RegExp(`^${time(hour)}$`);

describe("Weather's page", () => {
  it("says where to set the location before the home has one", async () => {
    const text = await show(fakeClient([]).client);

    expect(text).toBe(
      "WeatherWeather starts once the home’s location is set in Settings.",
    );
  });

  it("shows the sun while the forecast has not come yet", async () => {
    const text = await show(fakeClient([sunEntity]).client);

    expect(text).toContain("No forecast yet.");
    expect(text).toMatch(new RegExp(`Sunrise ${time(7, "05")}`));
    expect(text).toMatch(new RegExp(`Sunset ${time(17, "16")}`));
    expect(section("Now")).toBeNull();
  });

  it("shows the weather now and the rest of the day in a sentence", async () => {
    await show(fakeClient(shown).client);

    const now = section("Now");
    expect(texts(now, "p")).toEqual([
      "11°",
      "Rain",
      "Feels like 10° · High 14° · Low 6°",
      expect.stringMatching(
        new RegExp(`^Rain until ${time(16)}, then dry\\.$`),
      ),
    ]);
    // Its icon says nothing the words beside it don't.
    expect(now?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("writes its times as the home does, with 12 hours", async () => {
    const text = await show(fakeClient(shown).client, "celsius", "12h");

    const labels = [
      ...(section("Next 24 hours")?.querySelectorAll(
        "ol > li > span:first-child",
      ) ?? []),
    ].map((each) => each.textContent);
    expect(labels.slice(0, 9)).toEqual([
      "Now",
      "12 PM",
      "2 PM",
      "4 PM",
      "6 PM",
      "8 PM",
      "10 PM",
      "Fri",
      "2 AM",
    ]);
    expect(section("Sun")?.textContent).toMatch(
      /Sunrise 7:05 AMSunset 5:16 PM$/,
    );
    expect(text).toMatch(/Updated 9:58 AM · Forecast by Open-Meteo$/);
  });

  it("shows the next 24 hours, two hours apart from the hour it is", async () => {
    await show(fakeClient(shown).client);

    const hours = section("Next 24 hours");
    const columns = [...(hours?.querySelectorAll("ol > li") ?? [])];
    expect(columns).toHaveLength(12);
    const labels = columns.map(
      (each) => each.querySelector("span")?.textContent ?? "",
    );
    expect(labels[0]).toBe("Now");
    expect(labels[1]).toMatch(column(12));
    expect(labels[6]).toMatch(column(22));
    // Midnight in Zurich starts Friday: its weekday, not its time.
    expect(labels[7]).toBe(friday);
    expect(labels[8]).toMatch(column(2));
    // The weather now, then each hour's own.
    expect(columns[0]?.textContent).toBe("Now11°80% chance of rain or snow");
    expect(columns[2]?.textContent).toMatch(/12°80% chance of rain or snow$/);
    expect(columns[3]?.textContent).toMatch(/11°$/);
    expect(
      columns.map((each) =>
        each.querySelector("svg")?.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Rain",
      "Rain",
      "Rain",
      "Overcast",
      "Overcast",
      "Overcast",
      "Overcast",
      "Overcast",
      "Clear",
      "Clear",
      "Clear",
      "Overcast",
    ]);
    // The line through their temperatures says its range.
    expect(
      hours?.querySelector('svg[role="img"]:has(polyline)'),
    ).not.toBeNull();
    expect(
      hours?.querySelector("svg:has(polyline)")?.getAttribute("aria-label"),
    ).toBe("Temperatures over these hours, from 4° to 12°");
    expect(
      hours?.querySelector("polyline")?.getAttribute("points")?.split(" "),
    ).toHaveLength(12);
  });

  it("shows eight hours, three apart, on a phone", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(width < 40rem)",
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    await show(fakeClient(shown).client);

    const columns = [
      ...(section("Next 24 hours")?.querySelectorAll("ol > li") ?? []),
    ];
    expect(columns).toHaveLength(8);
    const labels = columns.map(
      (each) => each.querySelector("span")?.textContent ?? "",
    );
    expect(labels[0]).toBe("Now");
    expect(labels[1]).toMatch(column(13));
    expect(labels[5]).toBe(friday);
    expect(labels[7]).toMatch(column(7));
  });

  it("shows a chance of rain only from a fifth up", async () => {
    const { client } = fakeClient([
      sunEntity,
      forecastEntity({
        ...forecast,
        hours: forecast.hours!.map((hour, index) => ({
          ...hour,
          precipitationProbability: [null, null, 19, null, 20][index] ?? null,
        })),
        days: forecast.days.map((day, index) => ({
          ...day,
          precipitationProbabilityMax: [0, 19.4, 20, null, 100][index] ?? null,
        })),
      }),
    ]);
    await show(client);

    const chances = (title: string, rows: string) =>
      texts(section(title), `${rows} .text-cyan`).map((each) =>
        each?.replace(" chance of rain or snow", ""),
      );
    // From the hour it is: unknown, then 19% and unknown, then 20%.
    expect(chances("Next 24 hours", "ol > li").slice(0, 2)).toEqual([
      "",
      "20%",
    ]);
    expect(chances("Next 10 days", "ul > li")).toEqual(["", "20%", "", "100%"]);
  });

  it("shows the next ten days from the home's today, each with its bar", async () => {
    await show(fakeClient(shown).client);

    const rows = [
      ...(section("Next 10 days")?.querySelectorAll("ul > li") ?? []),
    ];
    // Yesterday, which the forecast still holds, is left out.
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toBe(
      "Today80% chance of rain or snowLow 6°High 14°",
    );
    expect(rows[1]?.textContent).toBe(`${friday}Low 7°High 13°`);
    expect(
      rows.map((each) => each.querySelector("svg")?.getAttribute("aria-label")),
    ).toEqual(["Rain", "Partly cloudy", "Clear", "Light rain"]);
    // From the coldest low, 2°, to the warmest high, 16°.
    const bars = rows.map((each) => {
      const bar = each.querySelector<HTMLElement>("[aria-hidden] > span");
      return [bar?.style.left, bar?.style.width];
    });
    expect(bars).toEqual([
      ["29.3%", "57.9%"],
      ["38.6%", "38.6%"],
      ["0%", "57.1%"],
      ["42.9%", "57.1%"],
    ]);
  });

  it("shows today's measures, each with its line", async () => {
    await show(fakeClient(shown).client);

    const today = section("Today");
    expect(texts(today, "h3")).toEqual([
      "Rain",
      "Wind",
      "UV index",
      "Humidity",
    ]);
    const cards = [...(today?.querySelectorAll("h3") ?? [])].map((each) =>
      texts(each.parentElement, "p"),
    );
    expect(cards).toEqual([
      ["6.5mm", expect.stringMatching(new RegExp(`^Until ${time(16)}$`))],
      ["14km/h", "W, gusts 22"],
      ["1", "Low all day"],
      ["74%", "Dew point 7°"],
    ]);
  });

  it("names what falls Snow, in centimetres, on a day of snow", async () => {
    const snowy: Forecast = {
      ...forecast,
      current: { ...forecast.current!, temperatureC: -1.2, weatherCode: 73 },
      days: forecast.days.map((day) =>
        day.date === "2026-10-29"
          ? { ...day, precipitationSumMm: 9.1, snowfallSumCm: 6.4 }
          : day,
      ),
    };
    await show(fakeClient([sunEntity, forecastEntity(snowy)]).client);

    const today = section("Today");
    expect(texts(today, "h3")[0]).toBe("Snow");
    expect(texts(today, "h3 + p")[0]).toBe("6.4cm");
    expect(texts(section("Now"), "p").slice(0, 2)).toEqual(["-1°", "Snow"]);
  });

  it("shows the sun on its path, with sunrise, sunset and the daylight", async () => {
    await show(fakeClient(shown).client);

    const card = section("Sun");
    expect(card?.textContent).toMatch(
      new RegExp(
        `^Sun10 h 11 min of daylightSunrise ${time(7, "05")}Sunset ${time(17, "16")}$`,
      ),
    );
    // Ten in the morning, 29% of the way from 07:05 to 17:16.
    const arc = card?.querySelector('svg[role="img"]');
    expect(arc?.getAttribute("aria-label")).toBe(
      "The sun is up, 29% of the way from sunrise to sunset",
    );
    const dot = arc?.querySelector("circle");
    expect(dot?.getAttribute("class")).toContain("fill-foreground");
    expect(Number(dot?.getAttribute("cx"))).toBeCloseTo(78.6, 0);
  });

  it("puts the sun at the end of its path, hollow, once it is down", async () => {
    vi.setSystemTime(new Date("2026-10-29T18:00:00Z"));
    await show(fakeClient(shown).client);

    const arc = section("Sun")?.querySelector('svg[role="img"]');
    expect(arc?.getAttribute("aria-label")).toBe("The sun has set");
    const dot = arc?.querySelector("circle");
    expect(dot?.getAttribute("cx")).toBe("250");
    expect(dot?.getAttribute("class")).toContain("fill-card");
  });

  it("says when the forecast was fetched, and by whom", async () => {
    const text = await show(fakeClient(shown).client);

    expect(text).toMatch(
      new RegExp(`Updated ${time(9, "58")} · Forecast by Open-Meteo$`),
    );
  });

  it("shows a forecast kept while Open-Meteo is away from the hour it is, and says its age", async () => {
    // Half past three the next night in Zurich, the forecast 17 hours old.
    vi.setSystemTime(new Date("2026-10-30T02:30:00Z"));
    const text = await show(fakeClient(shown).client);

    const columns = [
      ...(section("Next 24 hours")?.querySelectorAll("ol > li") ?? []),
    ];
    expect(columns[0]?.querySelector("span")?.textContent).toBe("Now");
    expect(columns[1]?.querySelector("span")?.textContent).toMatch(column(5));
    // The night's hour says the weather now, and nothing says the wind.
    expect(texts(section("Now"), "p").slice(0, 3)).toEqual([
      "4°",
      "Clear",
      "Feels like – · High 13° · Low 7°",
    ]);
    expect(texts(section("Today"), "h3 + p")).toEqual(["0mm", "–", "–", "–"]);
    expect(
      texts(section("Next 10 days"), "ul > li").map((each) =>
        each?.slice(0, 5),
      )[0],
    ).toBe("Today");
    expect(texts(section("Next 10 days"), "ul > li")).toHaveLength(3);
    expect(text).toMatch(
      // Its day too, such as 29 Oct, since that isn't today.
      new RegExp(`Updated .*29.* ${time(9, "58")} · Forecast by`),
    );
  });

  it("keeps old measures unknown after its hours and sun days run out", async () => {
    vi.setSystemTime(new Date("2026-10-31T09:00:00Z"));
    const text = await show(fakeClient(shown).client);

    expect(texts(section("Now"), "p")).toEqual([
      "11°",
      "Rain",
      "Feels like – · High 10° · Low 2°",
    ]);
    expect(texts(section("Today"), "h3 + p")).toEqual(["0mm", "–", "–", "–"]);
    expect(section("Next 24 hours")).toBeNull();
    expect(section("Sun")).toBeNull();
    expect(text).not.toContain("The sun neither rises nor sets today.");
  });

  it("shows no summary or rain timing when the rest of today is unknown", async () => {
    vi.setSystemTime(new Date("2026-10-31T02:30:00Z"));
    await show(fakeClient(shown).client);

    expect(texts(section("Now"), "p")).toHaveLength(3);
    expect(texts(section("Today"), "p")[1]).toBe("");
  });

  it("describes a polar day only when today's sun data is present", async () => {
    const polarSun: SunTimes = {
      ...sun,
      days: sun.days.map((day) => ({ ...day, sunrise: null, sunset: null })),
    };
    await show(fakeClient([entity("sun", "sun", polarSun)]).client);

    expect(section("Sun")?.textContent).toBe(
      "SunThe sun neither rises nor sets today.",
    );
  });

  it("shows what a forecast with the days and the weather now alone has, and dashes for the rest", async () => {
    const bare: Forecast = {
      timeZone: "Europe/Zurich",
      updatedAt: forecast.updatedAt,
      current: { temperatureC: 11.4, weatherCode: 2, isDay: true },
      days: [
        {
          date: "2026-10-29",
          temperatureMaxC: null,
          temperatureMinC: 6.1,
          precipitationProbabilityMax: null,
          weatherCode: null,
        },
      ],
    };
    const text = await show(
      fakeClient([sunEntity, forecastEntity(bare)]).client,
    );

    expect(section("Next 24 hours")).toBeNull();
    expect(texts(section("Now"), "p")).toEqual([
      "11°",
      "Partly cloudy",
      "Feels like – · High – · Low 6°",
    ]);
    expect(texts(section("Next 10 days"), "ul > li")).toEqual([
      "TodayLow 6°High –",
    ]);
    expect(
      section("Next 10 days")?.querySelector("[aria-hidden] > span"),
    ).toBeNull();
    expect(texts(section("Today"), "h3 + p")).toEqual(["–", "–", "–", "–"]);
    expect(text).not.toMatch(/null|NaN|undefined/);
  });

  it("follows the forecast as Weather fetches it again", async () => {
    const { client, push } = fakeClient(shown);
    await show(client);
    expect(texts(section("Now"), "p")[0]).toBe("11°");

    const fresh = forecastEntity({
      ...forecast,
      current: { ...forecast.current!, temperatureC: 12.6, weatherCode: 3 },
    });
    await act(async () =>
      push({
        type: "entity",
        app: "sanctum.weather",
        key: "forecast",
        entity: fresh,
        was: "weather.forecast",
      }),
    );

    expect(texts(section("Now"), "p").slice(0, 2)).toEqual(["13°", "Overcast"]);
  });

  it("does not restore an entity removed while the initial snapshot is loading", async () => {
    const { client, push } = fakeClient([]);
    let resolve!: (value: EntityInfo[]) => void;
    vi.mocked(client.entities).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await show(client);
    await act(async () => {
      push({
        type: "entity",
        app: client.app.id,
        key: "forecast",
        entity: null,
        was: "weather.forecast",
      });
      resolve([forecastEntity()]);
    });
    expect(container.textContent).not.toContain("11°");
    expect(container.textContent).toContain("Weather starts once");
    expect(client.entities).toHaveBeenCalledTimes(2);
  });

  it("ignores a snapshot from before the latest reconnect", async () => {
    const { client, refresh } = fakeClient([]);
    let resolve!: (value: EntityInfo[]) => void;
    vi.mocked(client.entities).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await show(client);
    await act(async () => {
      refresh();
    });
    await act(async () => {
      resolve(shown);
    });
    expect(container.textContent).not.toContain("11°");
    expect(container.textContent).toContain("Weather starts once");
  });

  it("shows temperatures in Fahrenheit when the home shows them so", async () => {
    await show(fakeClient(shown).client, "fahrenheit");

    expect(texts(section("Now"), "p").slice(0, 3)).toEqual([
      "53°",
      "Rain",
      "Feels like 49° · High 58° · Low 43°",
    ]);
    expect(texts(section("Next 10 days"), "ul > li")[0]).toBe(
      "Today80% chance of rain or snowLow 43°High 58°",
    );
    expect(texts(section("Today"), "p").at(-1)).toBe("Dew point 44°");
    // The days' bars are the same in either unit.
    expect(
      section("Next 10 days")?.querySelector<HTMLElement>(
        "[aria-hidden] > span",
      )?.style.left,
    ).toBe("29.3%");
  });

  it("follows a change of the home's unit", async () => {
    const { client } = fakeClient(shown);
    await show(client);
    expect(container.textContent).toContain("High 14° · Low 6°");

    await show(client, "fahrenheit");

    expect(container.textContent).toContain("High 58° · Low 43°");
  });

  it("shows no temperature until it knows the unit", async () => {
    const text = await show(fakeClient(shown).client, "unknown");

    expect(text).toBe("Weather");
  });

  it("has nothing to press, and no settings of its own", async () => {
    await show(fakeClient(shown).client);

    expect(
      container.querySelector("button, a, [role=button], input"),
    ).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
  });

  it("has a heading for each section, under the page's own", async () => {
    await show(fakeClient(shown).client);

    expect(texts(container, "h1")).toEqual(["Weather"]);
    expect(texts(container, "h2")).toEqual([
      "Now",
      "Next 24 hours",
      "Next 10 days",
      "Today",
      "Sun",
    ]);
    for (const each of container.querySelectorAll("section")) {
      const labelled = each.getAttribute("aria-labelledby");
      expect(each.querySelector(`[id="${labelled}"]`)?.tagName).toBe("H2");
    }
  });

  it("is a page and nothing else: the shell draws its card on dashboards", () => {
    expect(ui.id).toBe("sanctum.weather");
    expect(Object.keys(ui)).toEqual(["id", "version", "pages"]);
    expect(Object.keys(ui.pages)).toEqual(["main"]);
  });
});
