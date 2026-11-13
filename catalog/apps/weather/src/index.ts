import {
  defineApp,
  forecastType,
  netPermission,
  placesLocationPermission,
  sunType,
} from "@meetsanctum/app-sdk";

import { weatherCard } from "./card.js";
import { openMeteoHost } from "./forecast.js";
import { createWeather, type WeatherOptions } from "./weather.js";

// Weather: the sun and the forecast for where the home is, which it brings
// to the home as the standard `sun` and `weather.forecast` entities, and its
// card for dashboards, which the shell draws from what Weather works out
// (card.ts). It reads the home's location from the core and reaches only
// Open-Meteo, and nothing until someone has set the location. The shell
// writes the card's temperatures in the home's unit, which the household
// sets in Settings → Household. Its own page is in ./ui, which the shell
// bundles.

export { weatherCard } from "./card.js";
export type { WeatherOptions } from "./weather.js";

/** The app, with timings a test may shorten. */
export function createWeatherApp(options: WeatherOptions = {}) {
  let running: ReturnType<typeof createWeather> | undefined;

  return defineApp({
    id: "sanctum.weather",
    name: "Weather",
    version: "0.3.0",
    core: "^1.0.0",
    summary: "The forecast and sun times for where your home is.",
    icon: { glyph: "cloud-sun", color: "sky" },
    pages: ["main"],
    permissions: [
      {
        id: placesLocationPermission,
        reason: "To fetch the forecast and sun times for where you live.",
        needed: true,
      },
      {
        id: netPermission(openMeteoHost),
        reason: "To fetch the forecast. Only your home's position is sent.",
        needed: true,
      },
    ],
    provides: {
      entities: [sunType, forecastType],
      widgets: [weatherCard],
    },
    migrations: "migrations",
    actions: [],
    events: [],
    async start(ctx) {
      running = createWeather(ctx, options);
      await running.start();
    },
    async resume() {
      running?.resume();
    },
    async stop() {
      running?.stop();
      running = undefined;
    },
  });
}

export default createWeatherApp();
