import type { Forecast, TemperatureUnit } from "@meetsanctum/app-sdk";
import { formatTemperature, widgetIconOf } from "@meetsanctum/ui-sdk";

import { condition } from "../conditions";
import { daysFromToday, homeDate } from "../days";

// Every day of the forecast, under the card on Weather's own page: its
// weather in words and its chance of rain, and its low and high, in the
// unit the home shows.

// Whole degrees, as a forecast shows them, the unit clear from the page.
const degrees = { compact: true, whole: true } as const;

/** A forecast day's weekday, such as Thursday. */
function weekday(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function DayList(props: {
  forecast: Forecast;
  unit: TemperatureUnit;
  now?: Date;
}) {
  const days = daysFromToday(props.forecast, props.now);
  const today = homeDate(props.forecast.timeZone, props.now);
  return (
    <ul className="m-0 flex max-w-md list-none flex-col gap-3 p-0">
      {days.map((day) => {
        const { text, icon } = condition(day.weatherCode);
        const Icon = widgetIconOf[icon];
        return (
          <li key={day.date} className="flex items-center gap-3">
            <Icon
              aria-hidden="true"
              className="size-6 shrink-0"
              strokeWidth={1.75}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
              <span className="truncate text-sm font-medium">
                {day.date === today ? "Today" : weekday(day.date)}
              </span>
              <span className="truncate text-[13px] font-medium text-(--glass-secondary)">
                {day.precipitationProbabilityMax === null
                  ? text
                  : `${text} · ${day.precipitationProbabilityMax}% rain`}
              </span>
            </span>
            <span className="text-sm font-medium tabular-nums">
              {formatTemperature(day.temperatureMinC, props.unit, degrees)}
              <span className="text-(--glass-secondary)"> to </span>
              {formatTemperature(day.temperatureMaxC, props.unit, degrees)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
