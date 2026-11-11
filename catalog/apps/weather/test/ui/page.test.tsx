// @vitest-environment jsdom
import type {
  AppInfo,
  EntityInfo,
  Forecast,
  LiveMessage,
  SunTimes,
  TemperatureUnit,
} from "@meetsanctum/app-sdk";
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

import { cardOf, weatherCard } from "../../src/card";
import ui from "../../src/ui/index";

// Weather's page: its card, which the shell draws from what Weather shows,
// as dashboards show it, for a home without a location, one whose forecast
// has not come yet, and one with both, and every day of the forecast under
// it.

const now = new Date("2026-10-29T09:00:00Z");

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
const day = (date: string, max: number, min: number, code: number) => ({
  date,
  temperatureMaxC: max,
  temperatureMinC: min,
  precipitationProbabilityMax: 20,
  weatherCode: code,
});
const forecast: Forecast = {
  timeZone: "Europe/Zurich",
  updatedAt: "2026-10-29T08:58:00.000Z",
  current: { temperatureC: 11.4, weatherCode: 2, isDay: true },
  days: [
    day("2026-10-28", 13, 5, 3),
    day("2026-10-29", 14.2, 6.1, 2),
    day("2026-10-30", 12.8, 7.4, 61),
    day("2026-10-31", 11, 4, 3),
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// What Weather shows: its card, worked out at nine in the morning, and the
// forecast it was worked out from.
const card = (withForecast: Forecast | null) =>
  entity("home", "weather.card", cardOf(sun, withForecast, now), "Weather");
const shown = [
  card(forecast),
  entity("forecast", "weather.forecast", forecast),
];

// Its page as the shell shows it, in the unit and the time zone the home
// shows, or before the shell knows the unit.
async function show(
  client: AppClient,
  unit: TemperatureUnit | "unknown" = "celsius",
) {
  const Main = ui.pages.main!;
  await act(async () => {
    root.render(
      <TemperatureUnitProvider unit={unit === "unknown" ? undefined : unit}>
        <HomeTimeZoneProvider timeZone="Europe/Zurich">
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
  return container.querySelector("article")?.textContent ?? "";
}

// The card's next days, each its weekday, high and low.
const nextDays = () =>
  [...container.querySelectorAll("article li")].map((each) => each.textContent);

describe("Weather's page", () => {
  it("says where to set the location before the home has one", async () => {
    const text = await show(fakeClient([]).client);

    expect(text).toContain("Weather");
    expect(text).toContain(
      "Weather starts once the home’s location is set in Settings.",
    );
  });

  it("shows the sun while the forecast has not come yet", async () => {
    const text = await show(fakeClient([card(null)]).client);

    expect(text).toContain("No forecast yet.");
    expect(text).toMatch(/Sunrise\s*0?7:05/);
    expect(text).toMatch(/Sunset\s*(17:16|5:16)/);
  });

  it("shows the weather now, today and the days after", async () => {
    const { client, push } = fakeClient(shown);
    const text = await show(client);

    expect(text).toContain("11°");
    expect(text).toContain("Partly cloudy · H 14° L 6° · 20% rain");
    expect(nextDays()).toEqual([
      expect.stringMatching(/13°7°$/),
      expect.stringMatching(/11°4°$/),
    ]);
    expect(container.querySelector('[aria-label="Light rain"]')).not.toBeNull();
    // In Sky, Weather's colour.
    expect(container.querySelector("h2")?.getAttribute("style")).toContain(
      "--sky-text",
    );

    await act(async () =>
      push({
        type: "entity",
        app: "sanctum.weather",
        key: "home",
        entity: card(null),
        was: "weather.card",
      }),
    );
    expect(container.textContent).toContain("No forecast yet.");
  });

  it("does not restore an entity removed while the initial snapshot is loading", async () => {
    const old = [card(forecast)];
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
        key: "home",
        entity: null,
        was: "weather.card",
      });
      resolve(old);
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
      resolve([card(forecast)]);
    });
    expect(container.textContent).not.toContain("11°");
    expect(container.textContent).toContain("Weather starts once");
  });

  it("shows temperatures in Fahrenheit when the home shows them so", async () => {
    const { client } = fakeClient(shown);
    const text = await show(client, "fahrenheit");

    expect(text).toContain("53°");
    expect(text).toContain("Partly cloudy · H 58° L 43° · 20% rain");
    expect(nextDays()).toEqual([
      expect.stringMatching(/55°45°$/),
      expect.stringMatching(/52°39°$/),
    ]);
  });

  it("follows a change of the home's unit", async () => {
    const { client } = fakeClient(shown);
    await show(client);
    expect(container.textContent).toContain("H 14° L 6°");

    await show(client, "fahrenheit");

    expect(container.textContent).toContain("H 58° L 43°");
  });

  it("shows no temperature until it knows the unit", async () => {
    const { client } = fakeClient(shown);

    const text = await show(client, "unknown");

    expect(text).toBe("Weather");
    expect(container.textContent).not.toContain("°");
  });

  it("waits for the unit before showing every day of the forecast", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const { client } = fakeClient(shown);
      await show(client, "unknown");
      expect(container.textContent).not.toContain("°");
      // It has no settings of its own: the unit is the home's.
      expect(container.querySelector("button")).toBeNull();

      await show(client, "fahrenheit");
      expect(container.textContent).toContain("43° to 58°");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a page and nothing else: the shell draws its card on dashboards", () => {
    expect(ui.id).toBe("sanctum.weather");
    expect(Object.keys(ui)).toEqual(["id", "version", "pages"]);
    expect(Object.keys(ui.pages)).toEqual(["main"]);
  });
});
