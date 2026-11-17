import type { Forecast, TemperatureUnit } from "@meetsanctum/app-sdk";
import { PageSection, usePhone, widgetIconOf } from "@meetsanctum/ui-sdk";

import { condition } from "../conditions";
import { hourColumns, plotOf } from "../hours";
import { Chance } from "./parts";
import { degrees, hourLabel, weekdayAt } from "./words";

// The next 24 hours in one card: twelve columns two hours apart, and on a
// phone eight, three apart. Each has its time, its temperature, its sky and
// its chance of rain, and a line runs through their temperatures, with a dot
// on the hour it is.

// The line's drawing, in its own units: 50 to a column, as high as it is
// drawn, and 6 clear of its top and foot.
const plotSize = { column: 50, height: 36, inset: 6 };

export function HoursCard(props: {
  forecast: Forecast;
  unit: TemperatureUnit;
  now: Date;
}) {
  const { forecast, unit, now } = props;
  const isPhone = usePhone();
  const count = isPhone ? 8 : 12;
  const columns = hourColumns(forecast, { count, every: isPhone ? 3 : 2 }, now);
  if (columns.length === 0) return null;
  const temperatures = columns.map((column) => column.temperatureC);
  const plot = plotOf(temperatures, plotSize);
  const known = temperatures.filter((each) => each !== null);
  return (
    <PageSection id="weather-hours" title="Next 24 hours">
      <div className="relative mx-2.5 my-1.5 max-sm:mx-1">
        {known.length > 1 && (
          <svg
            role="img"
            aria-label={`Temperatures over these hours, from ${degrees(Math.min(...known), unit)} to ${degrees(Math.max(...known), unit)}`}
            viewBox={`0 0 ${plotSize.column * count} ${plotSize.height}`}
            preserveAspectRatio="none"
            className="absolute inset-x-0 top-5 h-9 w-full"
          >
            <polyline
              points={plot.points}
              fill="none"
              className="stroke-foreground/60"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        {plot.first && (
          <span
            aria-hidden="true"
            className="absolute size-2 rounded-full bg-foreground"
            style={{
              left: `calc(${50 / count}% - 4px)`,
              top: 20 + plot.first.y - 4,
            }}
          />
        )}
        <ol
          className={`m-0 grid list-none p-0 ${isPhone ? "grid-cols-8" : "grid-cols-12"}`}
        >
          {columns.map((column) => {
            const { text, icon } = condition(
              column.weatherCode,
              column.isDay ?? true,
            );
            const Icon = widgetIconOf[icon];
            const isMarked = column.isNow || column.startsDay;
            return (
              <li
                key={column.time}
                className="flex min-w-0 flex-col items-center"
              >
                <span
                  className={`text-xs leading-4 whitespace-nowrap ${isMarked ? "font-medium" : "text-muted-foreground"}`}
                >
                  {column.isNow
                    ? "Now"
                    : column.startsDay
                      ? weekdayAt(column.time, forecast.timeZone)
                      : hourLabel(column.time, forecast.timeZone)}
                </span>
                <span className="mt-[42px] text-[15px] leading-[22px] font-medium">
                  {degrees(column.temperatureC, unit)}
                </span>
                <Icon
                  role="img"
                  aria-label={text}
                  className="mt-1 size-5"
                  strokeWidth={1.6}
                />
                <Chance
                  percent={column.precipitationProbability}
                  className="mt-1 h-3.5 text-[11px] leading-[14px]"
                />
              </li>
            );
          })}
        </ol>
      </div>
    </PageSection>
  );
}
