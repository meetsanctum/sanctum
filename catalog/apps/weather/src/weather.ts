import {
  forecastType,
  sunTimes,
  sunType,
  type AppContext,
  type Forecast,
  type HomeLocation,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";

import { cardKey, cardOf, weatherCard } from "./card.js";
import { fetchForecast } from "./forecast.js";
import { forecastLocation } from "./schema.js";

// What Weather does while it runs. It reads where the home is as it starts and when
// the core says that changed, and publishes the sun for the home's day and its card,
// which the core keeps only when they changed. Once a minute it looks again, so the
// card's days move on at the home's midnight. It fetches the forecast when the
// location has changed, and otherwise once an hour, or ten minutes after a fetch
// failed. Nothing is fetched until someone has set the location, and taking the
// location away takes all three out of the home. While Open-Meteo cannot be reached,
// the forecast stays as it was, unless the home has moved.
//
// Its start publishes all it owns from its own database and the location, without
// the network, since that's how a failed update of it is undone: what its start
// doesn't publish goes. Fetching stays in the background.

export const sunKey = "sun";
export const forecastKey = "forecast";
// The entities are the home's; the home's own name is in Places, which
// Weather does not read.
const name = "Home";

export type WeatherOptions = {
  checkMs?: number;
  refreshMs?: number;
  retryMs?: number;
  now?: () => Date;
};

export function createWeather(ctx: AppContext, options: WeatherOptions = {}) {
  const checkMs = options.checkMs ?? 60_000;
  const refreshMs = options.refreshMs ?? 60 * 60_000;
  const retryMs = options.retryMs ?? 10 * 60_000;
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let isStopped = false;
  let isAskedAgain = false;
  // The last fetch: where it was for, when, and whether it worked.
  let fetched: { where: string; at: number; ok: boolean } | undefined;
  // Loaded once from the app's database; undefined means not loaded yet.
  let previousLocation: string | null | undefined;
  // The last forecast for it, for the card.
  let forecast: Forecast | null = null;

  async function load() {
    if (previousLocation !== undefined) return;
    const row = await ctx.storage.db.select().from(forecastLocation).get();
    previousLocation = row?.location ?? null;
    const kept = forecastType.state.safeParse(row?.forecast);
    forecast = kept.success ? kept.data : null;
  }

  // The core may still have entities from before this app restarted.
  async function clear() {
    await ctx.widgets.hide(cardKey);
    await ctx.entities.remove(sunKey);
    await ctx.entities.remove(forecastKey);
    await ctx.storage.db.delete(forecastLocation);
    previousLocation = null;
    forecast = null;
    fetched = undefined;
  }

  // The sun and the card for where the home is now, with nothing from the network.
  async function publishHere(location: HomeLocation, at: Date) {
    // Where the forecast is for. The elevation moves the sun, not the
    // forecast, so a new one keeps the forecast.
    const where = JSON.stringify({
      latitude: location.latitude,
      longitude: location.longitude,
      timeZone: location.timeZone,
    });
    if (previousLocation !== where) {
      // Remove the previous place before waiting on the network. Record the
      // new location only after removal, so a crash cannot mislabel old data.
      await ctx.entities.remove(forecastKey);
      forecast = null;
      await ctx.storage.db
        .insert(forecastLocation)
        .values({ id: 1, location: where, forecast: null })
        .onConflictDoUpdate({
          target: forecastLocation.id,
          set: { location: where, forecast: null },
        });
      previousLocation = where;
    }
    const sun = sunTimes(location, at);
    await ctx.entities.publish({
      type: sunType.id,
      key: sunKey,
      name,
      state: sun,
    });
    await ctx.widgets.show(weatherCard, cardKey, cardOf(sun, forecast, at));
    return { sun, where };
  }

  async function check() {
    await load();
    const location = await ctx.places.location();
    if (!location) return clear();
    const at = now();
    const { sun, where } = await publishHere(location, at);

    const due =
      !fetched ||
      fetched.where !== where ||
      at.getTime() - fetched.at >= (fetched.ok ? refreshMs : retryMs);
    if (!due) {
      return;
    }
    fetched = { where, at: at.getTime(), ok: false };
    try {
      const fresh = await fetchForecast(ctx.net, location, at);
      await ctx.entities.publish({
        type: forecastType.id,
        key: forecastKey,
        name,
        state: fresh,
      });
      await ctx.storage.db
        .update(forecastLocation)
        .set({ forecast: fresh })
        .where(eq(forecastLocation.id, 1));
      forecast = fresh;
      fetched.ok = true;
      await ctx.widgets.show(weatherCard, cardKey, cardOf(sun, fresh, at));
    } catch (error) {
      ctx.log(
        `no forecast (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  // Wakes the loop started below for a check now: work launched by a handler
  // loses its access to the core as soon as that handler returns.
  function askAgain() {
    isAskedAgain = true;
    wake?.();
  }

  async function run() {
    while (!isStopped) {
      isAskedAgain = false;
      try {
        await check();
      } catch (error) {
        if (!isStopped) {
          ctx.log(
            `check failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      if (isStopped) return;
      // One at a time: what asks meanwhile runs right after.
      if (isAskedAgain) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, checkMs);
      });
      clearTimeout(timer);
      wake = undefined;
    }
  }

  return {
    check,
    /**
     * Publishes all it owns, then checks in the background, so the app's start
     * doesn't wait for Open-Meteo.
     */
    async start() {
      await ctx.events.on("location.changed", askAgain);
      await load();
      const location = await ctx.places.location();
      if (location) {
        await publishHere(location, now());
        // What it knows for here, which may be gone from a core put back.
        if (forecast) {
          await ctx.entities.publish({
            type: forecastType.id,
            key: forecastKey,
            name,
            state: forecast,
          });
        }
      } else {
        await clear();
      }
      void run();
    },
    /** After the core restarted: what it missed meanwhile, in a check now. */
    resume: askAgain,
    stop() {
      isStopped = true;
      clearTimeout(timer);
      wake?.();
    },
  };
}
