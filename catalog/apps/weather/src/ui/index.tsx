import {
  PageBar,
  defineAppUi,
  useHomeClock,
  type PageProps,
} from "@meetsanctum/ui-sdk";

import { DaysCard } from "./days-card";
import { HoursCard } from "./hours-card";
import { NowBlock } from "./now-block";
import { SunCard } from "./sun-card";
import { TodayCards } from "./today-cards";
import { useWeather } from "./use-weather";
import { updatedWords } from "./words";
import { version } from "../../sanctum-app.json";

// Weather's UI, in a frame the core serves: its one page. Where there is the
// room, the weather now stands on the left with when the forecast was
// fetched at its foot, and the next 24 hours run across the right, over the
// next ten days beside today's measures and the sun; narrower, the same
// follow one another in one column, with when it was fetched last. Nothing
// on it can be pressed, and it has no settings of its own: the unit is the
// home's, in Settings → Household. Weather is the household's, so every
// client shows the same.

const words = "m-0 max-w-md text-[15px] leading-[22px] text-muted-foreground";

// The page's width decides the columns, since the sidebar beside it may be
// docked or not: two from 60rem, and the ten days beside today's measures
// wherever they have 39rem between them.
const page =
  "grid grow grid-cols-1 gap-y-6 @[60rem]:grid-cols-[18.5rem_minmax(0,1fr)] @[60rem]:grid-rows-[1fr_auto] @[60rem]:gap-x-7 @[60rem]:gap-y-4";
const rest =
  "@container flex min-w-0 flex-col gap-6 @[60rem]:col-start-2 @[60rem]:row-span-2 @[60rem]:row-start-1 @[60rem]:gap-3";
const lower =
  "grid grid-cols-1 gap-6 @[39rem]:grid-cols-[330px_minmax(0,1fr)] @[39rem]:gap-3";
const beside = "flex min-w-0 flex-col gap-6 @[39rem]:gap-3";

function MainPage(_props: PageProps) {
  const weather = useWeather();
  const { forecast, sun, unit, now } = weather;
  const clock = useHomeClock();
  return (
    <>
      <PageBar title="Weather" />
      {weather.loaded && !sun && !forecast && (
        // Weather publishes nothing before the home has a location.
        <p className={words}>
          Weather starts once the home’s location is set in Settings.
        </p>
      )}
      {weather.loaded && sun && !forecast && (
        <div className="flex max-w-md flex-col gap-6">
          <p className={words}>No forecast yet.</p>
          <SunCard sun={sun} now={now} />
        </div>
      )}
      {weather.loaded && forecast && (
        <div className="@container flex shrink-0 grow flex-col tabular-nums">
          <div className={page}>
            <NowBlock forecast={forecast} unit={unit} now={now} />
            <div className={rest}>
              <HoursCard forecast={forecast} unit={unit} now={now} />
              <div className={lower}>
                <DaysCard forecast={forecast} unit={unit} now={now} />
                <div className={beside}>
                  <TodayCards forecast={forecast} unit={unit} now={now} />
                  {sun && <SunCard sun={sun} now={now} />}
                </div>
              </div>
            </div>
            <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground @[60rem]:col-start-1 @[60rem]:row-start-2">
              {updatedWords(clock, forecast.updatedAt, forecast.timeZone, now)}{" "}
              · Forecast by Open-Meteo
            </p>
          </div>
        </div>
      )}
    </>
  );
}

export default defineAppUi({
  id: "sanctum.weather",
  version,
  pages: { main: MainPage },
});
