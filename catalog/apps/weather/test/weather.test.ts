import {
  defineApp,
  sunDay,
  toStaticManifest,
  type SunTimes,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { cardKey } from "../src/card.js";
import app, { createWeatherApp } from "../src/index.js";
import { createWeather, forecastKey, sunKey } from "../src/weather.js";
import { answer, fakeCore, openMeteoAnswer } from "./fake-core.js";

// What Weather brings to the home while it runs: the sun, the forecast and
// its card for where the home is, from the moment someone sets it, and
// nothing before.

const zurich = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: null,
  timeZone: "Europe/Zurich",
};
const minute = 60_000;
const at = (iso: string | null) => new Date(iso!).getTime();
// The kinds of the card's blocks, as Weather shows it now.
const card = (state: { entities: Map<string, { state: unknown }> }) =>
  (
    state.entities.get(cardKey)?.state as
      { blocks: { kind: string }[] } | undefined
  )?.blocks.map((block) => block.kind);

function running() {
  const { ctx, state } = fakeCore(app);
  const clock = { now: new Date("2026-10-29T09:00:00Z").getTime() };
  const weather = createWeather(ctx, { now: () => new Date(clock.now) });
  let answered = 0;
  state.internet = async () => {
    answered += 1;
    return answer(openMeteoAnswer);
  };
  return {
    ctx,
    state,
    weather,
    fetches: () => answered,
    advance: (ms: number) => (clock.now += ms),
  };
}

describe("Weather", () => {
  it("brings nothing and asks nothing until the home has a location", async () => {
    const { state, weather } = running();

    await weather.check();

    expect(state.entities.size).toBe(0);
    expect(state.requests).toEqual([]);
  });

  it("brings the sun and the forecast once it has one", async () => {
    const { state, weather } = running();
    state.location = zurich;

    await weather.check();

    expect(state.entities.get(sunKey)).toMatchObject({
      type: "sun",
      name: "Home",
      state: { date: "2026-10-29", timeZone: "Europe/Zurich" },
    });
    expect(state.entities.get(forecastKey)).toMatchObject({
      type: "weather.forecast",
      state: {
        updatedAt: "2026-10-29T09:00:00.000Z",
        current: { temperatureC: 11.4 },
      },
    });
    expect(state.entities.get(cardKey)).toMatchObject({
      type: "weather.card",
      name: "Weather",
    });
    expect(card(state)).toEqual(["headline", "line", "facts", "columns"]);
  });

  it("shows its card with the sun while the forecast has not come", async () => {
    const { state, weather } = running();
    state.location = zurich;
    state.internet = async () => answer({}, 503);

    await weather.check();

    expect(card(state)).toEqual(["note", "facts"]);
  });

  it("moves its card's days on at the home's midnight", async () => {
    const { state, weather, advance } = running();
    state.location = zurich;
    await weather.check();
    expect(card(state)).toContain("columns");

    // 00:00:15 on the 30th in Zurich: the forecast's last day is today.
    advance(14 * 60 * minute + 15_000);
    state.internet = async () => answer({}, 503);
    await weather.check();

    expect(card(state)).toEqual(["headline", "line", "facts"]);
  });

  it("asks again after an hour, or ten minutes after a failure", async () => {
    const { state, weather, fetches, advance } = running();
    state.location = zurich;

    await weather.check();
    advance(59 * minute);
    await weather.check();
    expect(fetches()).toBe(1);
    advance(minute);
    await weather.check();
    expect(fetches()).toBe(2);

    state.internet = async () => {
      throw new Error("offline");
    };
    advance(60 * minute);
    await weather.check();
    advance(9 * minute);
    await weather.check();
    expect(state.requests).toHaveLength(3);
    advance(minute);
    await weather.check();
    expect(state.requests).toHaveLength(4);
    expect(state.logs).toContain("no forecast (offline)");
  });

  it("keeps the last forecast while Open-Meteo is away, but never one for another place", async () => {
    const { state, weather, advance } = running();
    state.location = zurich;
    await weather.check();
    const kept = state.entities.get(forecastKey);

    state.internet = async () => answer({}, 503);
    advance(60 * minute);
    await weather.check();
    expect(state.entities.get(forecastKey)).toEqual(kept);

    state.location = { ...zurich, latitude: 46.948, longitude: 7.4474 };
    await weather.check();
    expect(state.entities.has(forecastKey)).toBe(false);
    expect(state.entities.has(sunKey)).toBe(true);
  });

  it("asks again at once when the home moves", async () => {
    const { state, weather, fetches } = running();
    state.location = zurich;
    await weather.check();

    state.location = { ...zurich, timeZone: "Europe/Berlin" };
    await weather.check();

    expect(fetches()).toBe(2);
    expect(state.entities.get(sunKey)?.state).toMatchObject({
      timeZone: "Europe/Berlin",
    });
  });

  it("moves the sun, and keeps the forecast, when only the elevation changes", async () => {
    const { state, weather, fetches } = running();
    state.location = zurich;
    await weather.check();
    const forecast = state.entities.get(forecastKey);
    const atSeaLevel = state.entities.get(sunKey)?.state as SunTimes;

    state.location = { ...zurich, elevation: 408 };
    await weather.check();

    expect(fetches()).toBe(1);
    expect(state.entities.get(forecastKey)).toEqual(forecast);
    const upHigh = state.entities.get(sunKey)?.state as SunTimes;
    expect(at(sunDay(upHigh)!.sunrise)).toBeLessThan(
      at(sunDay(atSeaLevel)!.sunrise),
    );
  });

  it("takes all three out of the home when the location goes", async () => {
    const { state, weather } = running();
    state.location = zurich;
    await weather.check();

    state.location = null;
    await weather.check();

    expect(state.entities.size).toBe(0);
  });

  it("keeps the matching forecast, and its card, across an offline restart", async () => {
    const { ctx, state, weather } = running();
    state.location = zurich;
    await weather.check();
    const kept = state.entities.get(forecastKey);
    const shown = state.entities.get(cardKey);
    state.internet = async () => answer({}, 503);

    await createWeather(ctx, {
      now: () => new Date("2026-10-29T09:00:00Z"),
    }).check();

    expect(state.entities.get(forecastKey)).toEqual(kept);
    expect(state.entities.get(cardKey)).toEqual(shown);
  });

  it.each([null, { ...zurich, latitude: 46.948 }])(
    "discards persisted weather after restarting at %j",
    async (location) => {
      const { ctx, state, weather } = running();
      state.location = zurich;
      await weather.check();
      state.location = location;
      state.internet = async () => answer({}, 503);

      await createWeather(ctx).check();

      expect(state.entities.has(forecastKey)).toBe(false);
      expect(state.entities.has(sunKey)).toBe(location !== null);
      expect(card(state)).toEqual(location ? ["note", "facts"] : undefined);
    },
  );

  it("removes the previous place's forecast before the next request settles", async () => {
    const { state, weather } = running();
    state.location = zurich;
    await weather.check();
    state.location = { ...zurich, latitude: 46.948 };
    state.internet = async () => {
      expect(state.entities.has(forecastKey)).toBe(false);
      return answer(openMeteoAnswer);
    };

    await weather.check();

    expect(state.entities.has(forecastKey)).toBe(true);
  });

  it("checks in the background once started, and stops with the app", async () => {
    const { ctx, state } = fakeCore(app);
    state.location = zurich;
    state.internet = async () => answer(openMeteoAnswer);
    const weatherApp = createWeatherApp({ checkMs: 5 });

    await weatherApp.start!(ctx, { reason: "started" });
    await expect.poll(() => state.entities.size).toBe(3);
    await weatherApp.stop!(ctx, { reason: "shutdown" });
    const asked = state.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.requests.length).toBe(asked);
  });
});

describe("its start", () => {
  const fetchNeverAnswers = () => new Promise<never>(() => undefined);

  it("publishes all it owns from its database, not waiting for the network", async () => {
    // A first run leaves its forecast in its database.
    const first = fakeCore(app);
    first.state.location = zurich;
    first.state.internet = async () => answer(openMeteoAnswer);
    const before = createWeather(first.ctx);
    await before.check();
    const kept = first.state.entities.get(forecastKey);
    expect(kept).toBeDefined();
    // A core that holds none of it, with Open-Meteo gone quiet.
    first.state.entities.clear();
    first.state.internet = fetchNeverAnswers;
    const weatherApp = createWeatherApp({ checkMs: 60_000 });

    await weatherApp.start!(first.ctx, { reason: "started" });

    expect([...first.state.entities.keys()].sort()).toEqual(
      [cardKey, forecastKey, sunKey].sort(),
    );
    expect(first.state.entities.get(forecastKey)).toEqual(kept);
    await weatherApp.stop!(first.ctx, { reason: "shutdown" });
  });

  it("has nothing of its own while the home has no location, and takes it away", async () => {
    const { ctx, state } = fakeCore(app);
    state.entities.set(sunKey, { type: "sun", name: "Home", state: {} });
    const weatherApp = createWeatherApp({ checkMs: 60_000 });

    await weatherApp.start!(ctx, { reason: "started" });

    expect(state.entities.size).toBe(0);
    await weatherApp.stop!(ctx, { reason: "shutdown" });
  });

  it("fails if it can't read what it needs, rather than commit having published nothing", async () => {
    const { ctx } = fakeCore({ ...app, permissions: [] });
    const weatherApp = createWeatherApp({ checkMs: 60_000 });

    await expect(weatherApp.start!(ctx, { reason: "started" })).rejects.toThrow(
      "places.location",
    );
  });
});

describe("when the home moves", () => {
  it("hears at once, without waiting for its next look", async () => {
    const { ctx, state, moveTo } = fakeCore(app);
    state.internet = async () => answer(openMeteoAnswer);
    const weatherApp = createWeatherApp({ checkMs: 60_000 });
    await weatherApp.start!(ctx, { reason: "started" });
    expect(state.entities.size).toBe(0);

    moveTo(zurich);

    await expect.poll(() => state.entities.size).toBe(3);
    expect(state.requests).toHaveLength(1);
    await weatherApp.stop!(ctx, { reason: "shutdown" });
  });

  it("takes it all away when the location goes", async () => {
    const { ctx, state, moveTo } = fakeCore(app);
    state.location = zurich;
    state.internet = async () => answer(openMeteoAnswer);
    const weatherApp = createWeatherApp({ checkMs: 60_000 });
    await weatherApp.start!(ctx, { reason: "started" });
    await expect.poll(() => state.entities.size).toBe(3);

    moveTo(null);

    await expect.poll(() => state.entities.size).toBe(0);
    await weatherApp.stop!(ctx, { reason: "shutdown" });
  });

  it("looks once more if it moves again while looking", async () => {
    const { ctx, state, moveTo } = fakeCore(app);
    state.location = zurich;
    let answerNow!: () => void;
    const held = new Promise<void>((done) => {
      answerNow = done;
    });
    state.internet = async () => {
      await held;
      return answer(openMeteoAnswer);
    };
    const weatherApp = createWeatherApp({ checkMs: 60_000 });
    await weatherApp.start!(ctx, { reason: "started" });
    await expect.poll(() => state.requests.length).toBe(1);

    moveTo({ ...zurich, latitude: 46 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.requests).toHaveLength(1);
    answerNow();

    await expect.poll(() => state.requests.length).toBe(2);
    await weatherApp.stop!(ctx, { reason: "shutdown" });
  });

  it("hears nothing once it has stopped", async () => {
    const { ctx, state, moveTo } = fakeCore(app);
    const weatherApp = createWeatherApp({ checkMs: 60_000 });
    await weatherApp.start!(ctx, { reason: "started" });
    await weatherApp.stop!(ctx, { reason: "shutdown" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.internet = async () => answer(openMeteoAnswer);

    moveTo(zurich);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.entities.size).toBe(0);
  });
});

describe("after the core restarted", () => {
  it("looks again at once, without waiting for its next look", async () => {
    const { ctx, state } = fakeCore(app);
    state.internet = async () => answer(openMeteoAnswer);
    const weatherApp = createWeatherApp({ checkMs: 60_000 });
    await weatherApp.start!(ctx, { reason: "started" });
    expect(state.entities.size).toBe(0);
    // As the next core has it, which the app hasn't heard.
    state.location = zurich;

    await weatherApp.resume!(ctx, { reason: "started" });

    await expect.poll(() => state.entities.size).toBe(3);
    expect(state.requests).toHaveLength(1);
    await weatherApp.stop!(ctx, { reason: "shutdown" });
  });
});

describe("Weather's manifest", () => {
  it("declares what it brings and the one host it reaches", () => {
    const manifest = toStaticManifest(defineApp(app));
    expect(manifest.permissions.map(({ id, needed }) => [id, needed])).toEqual([
      ["places.location", true],
      ["net:api.open-meteo.com", true],
    ]);
    expect(manifest.provides.entities.map((type) => type.id)).toEqual([
      "sun",
      "weather.forecast",
    ]);
    expect(manifest.provides.widgets).toEqual([
      expect.objectContaining({
        id: "weather.card",
        title: "Weather",
        size: { columns: 4, rows: 4 },
      }),
    ]);
  });
});
