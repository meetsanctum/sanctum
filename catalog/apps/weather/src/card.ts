import {
  defineWidget,
  type Forecast,
  type SunTimes,
  type WidgetBlock,
  type WidgetContent,
  type WidgetValue,
} from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";

import { condition } from "./conditions.js";
import { dateIn, daysFromToday, sunToday } from "./days.js";

// Weather's card for dashboards, which the shell draws from what Weather
// works out here: four cells square, the temperature now as its headline,
// then today's high and low and chance of rain, sunrise and sunset, and the
// next five days. Weather shows it for the home once it has a location, and
// works it out again at every check, so the days move on at the home's
// midnight.

/** Its key: Weather shows one card, the home's. */
export const cardKey = "home";

// One of the next days, as the preview shows them.
const sampleDay = (
  date: string,
  [icon, iconLabel]:
    ["sun", "Clear"] | ["cloud-sun", "Partly cloudy"] | ["cloud-rain", "Rain"],
  high: number,
  low: number,
) => ({
  label: { date },
  icon,
  iconLabel,
  value: { temperature: high },
  detail: { temperature: low },
});

export const weatherCard = defineWidget({
  id: "weather.card",
  title: "Weather",
  size: { columns: 4, rows: 4 },
  preview: {
    blocks: [
      { kind: "headline", icon: "cloud-sun", value: { temperature: 18 } },
      {
        kind: "line",
        text: "Partly cloudy · H {high} L {low} · {rain} rain",
        values: {
          high: { temperature: 21 },
          low: { temperature: 12 },
          rain: { percent: 10 },
        },
      },
      // A June day's, where most homes are; the shell writes them in the
      // home's time zone.
      {
        kind: "facts",
        items: [
          {
            icon: "sunrise",
            label: "Sunrise",
            value: { time: "2026-06-21T03:31:00Z" },
          },
          {
            icon: "sunset",
            label: "Sunset",
            value: { time: "2026-06-21T19:26:00Z" },
          },
        ],
      },
      {
        kind: "columns",
        items: [
          sampleDay("2026-06-22", ["sun", "Clear"], 24, 13),
          sampleDay("2026-06-23", ["cloud-sun", "Partly cloudy"], 22, 14),
          sampleDay("2026-06-24", ["cloud-rain", "Rain"], 17, 11),
          sampleDay("2026-06-25", ["cloud-rain", "Rain"], 19, 10),
          sampleDay("2026-06-26", ["sun", "Clear"], 23, 12),
        ],
      },
    ],
  },
});

// A temperature, or a dash while there is none.
const degrees = (celsius: number | null): WidgetValue =>
  celsius === null ? "–" : { temperature: celsius };

/** What the card says for the home now, from the sun and the forecast Weather has. */
export function cardOf(
  clock: HomeClock,
  sun: SunTimes | null,
  forecast: Forecast | null,
  now: Date,
): WidgetContent {
  return {
    blocks: [
      ...(forecast ? weatherNow(clock, forecast, now) : noForecast),
      ...(sun ? sunBlocks(clock, sun, now) : []),
      ...(forecast ? nextDays(clock, forecast, now) : []),
    ],
  };
}

const noForecast: WidgetBlock[] = [{ kind: "note", text: "No forecast yet." }];

// The temperature now, the weather in words, today's high and low and its
// chance of rain.
function weatherNow(
  clock: HomeClock,
  forecast: Forecast,
  now: Date,
): WidgetBlock[] {
  const today = daysFromToday(clock, forecast, now).find(
    (day) => day.date === dateIn(clock, forecast.timeZone, now),
  );
  const current = forecast.current;
  const { text, icon } = condition(
    current?.weatherCode ?? today?.weatherCode ?? null,
    current?.isDay ?? true,
  );
  const rain = today?.precipitationProbabilityMax ?? null;
  return [
    {
      kind: "headline",
      icon,
      value: degrees(current?.temperatureC ?? today?.temperatureMaxC ?? null),
    },
    {
      kind: "line",
      text: [text, today && "H {high} L {low}", rain !== null && "{rain} rain"]
        .filter(Boolean)
        .join(" · "),
      values: {
        ...(today && {
          high: degrees(today.temperatureMaxC),
          low: degrees(today.temperatureMinC),
        }),
        ...(rain !== null && { rain: { percent: rain } }),
      },
    },
  ];
}

// Sunrise and sunset on the home's today, if it has them.
function sunBlocks(clock: HomeClock, sun: SunTimes, now: Date): WidgetBlock[] {
  const today = sunToday(clock, sun, now);
  if (!today) return [];
  const items = [
    today.sunrise && {
      icon: "sunrise" as const,
      label: "Sunrise",
      value: { time: today.sunrise },
    },
    today.sunset && {
      icon: "sunset" as const,
      label: "Sunset",
      value: { time: today.sunset },
    },
  ].filter((item) => !!item);
  return items.length > 0
    ? [{ kind: "facts", items }]
    : [{ kind: "note", text: "The sun neither rises nor sets today." }];
}

// The five days after the home's today.
function nextDays(
  clock: HomeClock,
  forecast: Forecast,
  now: Date,
): WidgetBlock[] {
  const today = dateIn(clock, forecast.timeZone, now);
  const days = daysFromToday(clock, forecast, now)
    .filter((day) => day.date > today)
    .slice(0, 5);
  if (days.length === 0) return [];
  return [
    {
      kind: "columns",
      items: days.map((day) => {
        const { text, icon } = condition(day.weatherCode);
        return {
          label: { date: day.date },
          icon,
          iconLabel: text,
          value: degrees(day.temperatureMaxC),
          detail: degrees(day.temperatureMinC),
        };
      }),
    },
  ];
}
