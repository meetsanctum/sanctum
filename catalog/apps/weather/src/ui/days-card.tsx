import type { Forecast, TemperatureUnit } from "@meetsanctum/app-sdk";
import { PageSection, useHomeClock, widgetIconOf } from "@meetsanctum/ui-sdk";
import { useMemo } from "react";

import { condition } from "../conditions";
import { dateIn, daysFromToday, temperatureSpans } from "../days";
import { Chance } from "./parts";
import { degrees } from "./words";

// The next ten days in one card, a row each: the day, its sky, its chance
// of rain, and its low and high either side of a bar that runs from one to
// the other on a scale all ten share, so a warmer day's bar sits further
// right.

export function DaysCard(props: {
  forecast: Forecast;
  unit: TemperatureUnit;
  now: Date;
}) {
  const { forecast, unit, now } = props;
  const clock = useHomeClock();
  const weekday = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short" }),
    [],
  );
  const days = daysFromToday(clock, forecast, now).slice(0, 10);
  const today = dateIn(clock, forecast.timeZone, now);
  const spans = temperatureSpans(days);
  if (days.length === 0) return null;
  return (
    <PageSection id="weather-days" title="Next 10 days">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {days.map((day, index) => {
          const { text, icon } = condition(day.weatherCode);
          const Icon = widgetIconOf[icon];
          const span = spans[index];
          return (
            // 44 px from one row to the next with the 2 px between them,
            // and 48 px on a phone.
            <li
              key={day.date}
              className="flex h-[42px] items-center gap-2 rounded-sm px-2.5 text-[15px] leading-[22px] whitespace-nowrap max-sm:h-[46px]"
            >
              <span className="w-[58px] shrink-0">
                {day.date === today
                  ? "Today"
                  : weekday.format(Date.parse(`${day.date}T12:00:00Z`))}
              </span>
              <Icon
                role="img"
                aria-label={text}
                className="size-5 shrink-0"
                strokeWidth={1.6}
              />
              <Chance
                percent={day.precipitationProbabilityMax}
                className="w-8 shrink-0 text-right text-xs"
              />
              <span className="min-w-[30px] shrink-0 text-right text-muted-foreground">
                <span className="sr-only">Low </span>
                {degrees(day.temperatureMinC, unit)}
              </span>
              <span
                aria-hidden="true"
                className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-[3px] bg-foreground/12"
              >
                {span && (
                  <span
                    className="absolute inset-y-0 min-w-1.5 rounded-[3px] bg-foreground"
                    style={{
                      left: `${(span.start * 100).toFixed(1)}%`,
                      width: `${(span.width * 100).toFixed(1)}%`,
                    }}
                  />
                )}
              </span>
              <span className="min-w-[30px] shrink-0 text-right font-medium">
                <span className="sr-only">High </span>
                {degrees(day.temperatureMaxC, unit)}
              </span>
            </li>
          );
        })}
      </ul>
    </PageSection>
  );
}
