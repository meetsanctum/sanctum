import type { Forecast, TemperatureUnit } from "@meetsanctum/app-sdk";
import {
  Card,
  formatNumber,
  icons,
  type LucideIcon,
} from "@meetsanctum/ui-sdk";

import { daysFromToday, homeDate } from "../days";
import { weatherNow } from "../hours";
import { fallLine, fallOf, uvLine, windLine } from "../measures";
import { daySummary } from "../summary";
import { Heading } from "./parts";
import { clock, degrees } from "./words";

// Today's measures, a small card each: what falls today, rain in
// millimetres or snow in centimetres, the wind now, the UV index now and the
// humidity now, each with one short line under its number.

type Measure = {
  name: string;
  icon: LucideIcon;
  /** The number, or a dash while there is none. */
  value: string;
  unit?: string;
  line: string;
};

const dash = "–";
const whole = (value: number | null) =>
  value === null ? dash : String(Math.round(value));

export function TodayCards(props: {
  forecast: Forecast;
  unit: TemperatureUnit;
  now: Date;
}) {
  const { forecast, unit, now } = props;
  const current = weatherNow(forecast, now);
  const today = daysFromToday(forecast, now).find(
    (day) => day.date === homeDate(forecast.timeZone, now),
  );
  const fall = fallOf(today);
  const measures: Measure[] = [
    {
      name: fall.kind === "snow" ? "Snow" : "Rain",
      icon: fall.kind === "snow" ? icons.Snowflake : icons.Umbrella,
      value: fall.amount === null ? dash : formatNumber(fall.amount),
      ...(fall.amount !== null && {
        unit: fall.kind === "snow" ? "cm" : "mm",
      }),
      line: fallLine(fall, daySummary(forecast, now), (instant) =>
        clock(instant, forecast.timeZone),
      ),
    },
    {
      name: "Wind",
      icon: icons.Wind,
      value: whole(current.windSpeedKmh),
      ...(current.windSpeedKmh !== null && { unit: "km/h" }),
      line: windLine(current),
    },
    {
      name: "UV index",
      icon: icons.Sun,
      value: whole(current.uvIndex),
      line: uvLine(today?.uvIndexMax),
    },
    {
      name: "Humidity",
      icon: icons.Droplet,
      value:
        current.relativeHumidity === null
          ? dash
          : `${Math.round(current.relativeHumidity)}%`,
      line:
        current.dewPointC === null
          ? ""
          : `Dew point ${degrees(current.dewPointC, unit)}`,
    },
  ];
  return (
    <section
      aria-labelledby="weather-today"
      className="flex min-w-0 shrink-0 flex-col gap-2"
    >
      <Heading id="weather-today">Today</Heading>
      <div className="grid grid-cols-2 gap-3">
        {measures.map(({ name, icon: Icon, value, unit: measured, line }) => (
          <Card key={name} className="h-[118px] p-3 ps-3.5">
            <h3 className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
              {name}
            </h3>
            <p className="m-0 mt-auto flex items-baseline gap-[5px] whitespace-nowrap">
              <Icon
                aria-hidden="true"
                className="me-[3px] size-5 shrink-0 self-center"
                strokeWidth={1.6}
              />
              <span className="text-[30px] leading-9 font-light tracking-[-0.02em]">
                {value}
              </span>
              {measured && (
                <span className="text-[15px] leading-[22px] text-muted-foreground">
                  {measured}
                </span>
              )}
            </p>
            <p className="m-0 min-h-[18px] truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
              {line}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}
