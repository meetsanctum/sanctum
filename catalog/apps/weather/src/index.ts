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
// sets in Settings → Household. Its own page is in ./ui, which opens in a
// frame the core serves.

export { weatherCard } from "./card.js";
export type { WeatherOptions } from "./weather.js";

/** The app, with timings a test may shorten. */
export function createWeatherApp(options: WeatherOptions = {}) {
  let running: ReturnType<typeof createWeather> | undefined;

  return defineApp({
    id: "sanctum.weather",
    name: "Weather",
    // 0.4.0: the forecast hour by hour, with how the air feels, its
    // humidity, the wind, the UV index and what falls each day.
    version: "0.4.1",
    core: "^2.0.0",
    summary: "The forecast and sun times for where your home is.",
    icon: { glyph: "cloud-sun", color: "sky" },
    pages: ["main"],
    permissions: [
      {
        id: placesLocationPermission,
        reason: "To get the forecast and sun times there.",
        needed: true,
      },
      {
        id: netPermission(openMeteoHost),
        reason:
          "Only your home's location and time zone are sent, to get the forecast.",
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
