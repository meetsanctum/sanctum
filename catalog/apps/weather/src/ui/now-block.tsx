import type { Forecast, TemperatureUnit } from "@meetsanctum/app-sdk";
import { widgetIconOf } from "@meetsanctum/ui-sdk";

import { condition } from "../conditions";
import { daysFromToday, homeDate } from "../days";
import { weatherNow } from "../hours";
import { daySummary, summarySentence } from "../summary";
import { Heading } from "./parts";
import { clock, degrees } from "./words";

// The weather now, on the page itself with no card: the temperature as a
// large numeral, the sky in words, what it feels like with today's high and
// low, and the rest of the day in one sentence.

export function NowBlock(props: {
  forecast: Forecast;
  unit: TemperatureUnit;
  now: Date;
}) {
  const { forecast, unit, now } = props;
  const current = weatherNow(forecast, now);
  const today = daysFromToday(forecast, now).find(
    (day) => day.date === homeDate(forecast.timeZone, now),
  );
  const { text, icon } = condition(current.weatherCode, current.isDay ?? true);
  const Icon = widgetIconOf[icon];
  const summary = daySummary(forecast, now);
  return (
    <section aria-labelledby="weather-now" className="flex min-w-0 flex-col">
      <Heading id="weather-now">Now</Heading>
      <p className="m-0 mt-2.5 text-[132px] leading-[120px] font-light tracking-[-0.035em] whitespace-nowrap max-sm:mt-1.5 max-sm:text-[112px] max-sm:leading-[104px]">
        {degrees(current.temperatureC, unit)}
      </p>
      <p className="m-0 mt-3 flex items-center gap-2.5 text-2xl leading-8 whitespace-nowrap max-sm:mt-2.5">
        <Icon
          aria-hidden="true"
          className="size-7 shrink-0"
          strokeWidth={1.5}
        />
        {text}
      </p>
      <p className="m-0 mt-1.5 text-[15px] leading-[22px] text-muted-foreground">
        {[
          `Feels like ${degrees(current.apparentTemperatureC, unit)}`,
          `High ${degrees(today?.temperatureMaxC ?? null, unit)}`,
          `Low ${degrees(today?.temperatureMinC ?? null, unit)}`,
        ].join(" · ")}
      </p>
      {summary && (
        <p className="m-0 mt-4 text-[15px] leading-[22px] text-balance max-sm:mt-3">
          {summarySentence(summary, (instant) =>
            clock(instant, forecast.timeZone),
          )}
        </p>
      )}
    </section>
  );
}
