import {
  PageBar,
  WidgetCard,
  defineAppUi,
  useAppClient,
  type PageProps,
} from "@meetsanctum/ui-sdk";

import { DayList } from "./day-list";
import { useWeather } from "./use-weather";
import { version } from "../../sanctum-app.json";

// Weather's UI, which the shell bundles: its main page, with its card as
// dashboards show it, which the shell draws from what Weather shows
// (../card.ts), and every day of the forecast. It has no settings of its
// own: the unit is the home's, in Settings → Household. Weather is the
// household's, so every client shows the same.

const grid =
  "grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)";

// Before the home has a location, Weather shows no card: its page says
// where to set one.
const noLocation = {
  blocks: [
    {
      kind: "note" as const,
      text: "Weather starts once the home’s location is set in Settings.",
    },
  ],
};

function MainPage(_props: PageProps) {
  const { app } = useAppClient();
  const weather = useWeather();
  const widget = app.provides.widgets.find(
    (each) => each.id === "weather.card",
  );
  return (
    <>
      <PageBar title="Weather" />
      {widget && (
        <div className={`shrink-0 ${grid}`}>
          <WidgetCard
            title={widget.title}
            color={app.icon?.color ?? null}
            size={widget.size}
            content={weather.card ?? (weather.loaded ? noLocation : null)}
          />
        </div>
      )}
      {weather.loaded && weather.forecast && (
        <DayList forecast={weather.forecast} unit={weather.unit} />
      )}
    </>
  );
}

export default defineAppUi({
  id: "sanctum.weather",
  version,
  pages: { main: MainPage },
});
