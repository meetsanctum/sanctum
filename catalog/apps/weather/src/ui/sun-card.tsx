import type { SunTimes } from "@meetsanctum/app-sdk";
import { PageSection } from "@meetsanctum/ui-sdk";

import { sunToday } from "../days";
import { arcPoint, daylightWords, sunArc, sunPath } from "../sun-path";
import { clock } from "./words";

// The sun's day in one card: a dashed arc from sunrise to sunset over the
// horizon, with a dot where the sun is, filled while it is up and hollow at
// the arc's end once it is down, and both times at the foot. The times are
// the home's own, from the sun Weather publishes for it.

const label = "text-[13px] leading-[18px] font-medium";

export function SunCard(props: { sun: SunTimes; now: Date }) {
  const { sun, now } = props;
  const today = sunToday(sun, now);
  const path = sunPath(today, now);
  if (!path) {
    // A polar day or night, or the day one begins or ends.
    const time = (instant: string | null | undefined) =>
      instant ? clock(instant, sun.timeZone) : "–";
    return (
      <PageSection id="weather-sun" title="Sun">
        <p className="m-0 px-2 py-1.5 text-[15px] leading-[22px]">
          {today?.sunrise || today?.sunset
            ? `Sunrise ${time(today.sunrise)} · Sunset ${time(today.sunset)}`
            : "The sun neither rises nor sets today."}
        </p>
      </PageSection>
    );
  }
  const { start, control, end, horizon, width, height } = sunArc;
  const dot = arcPoint(path.progress);
  const where = path.isUp
    ? `The sun is up, ${Math.round(path.progress * 100)}% of the way from sunrise to sunset`
    : path.progress === 0
      ? "The sun has not risen yet"
      : "The sun has set";
  return (
    <PageSection
      id="weather-sun"
      title="Sun"
      action={
        <span className={`${label} text-muted-foreground`}>
          {daylightWords(path.daylightMinutes)} of daylight
        </span>
      }
    >
      <div className="flex flex-col gap-1.5 px-2 py-1.5">
        {/* As high as brings the card's foot level with the ten days' beside it. */}
        <svg
          role="img"
          aria-label={where}
          viewBox={`0 0 ${width} ${height}`}
          fill="none"
          className="block h-[106px] w-full max-sm:h-24"
        >
          <path
            d={`M${start.x} ${start.y} Q${control.x} ${control.y} ${end.x} ${end.y}`}
            className="stroke-foreground/60"
            strokeWidth={1.5}
            strokeDasharray="3 5"
            strokeLinecap="round"
          />
          <path
            d={`M0 ${horizon} H${width}`}
            className="stroke-foreground/12"
            strokeWidth={1}
          />
          <circle
            cx={dot.x}
            cy={dot.y}
            r={6}
            className={`stroke-foreground ${path.isUp ? "fill-foreground" : "fill-card"}`}
            strokeWidth={1.5}
          />
        </svg>
        <div className={`flex justify-between whitespace-nowrap ${label}`}>
          <span>
            <span className="text-muted-foreground">Sunrise</span>{" "}
            {clock(path.sunrise, sun.timeZone)}
          </span>
          <span>
            <span className="text-muted-foreground">Sunset</span>{" "}
            {clock(path.sunset, sun.timeZone)}
          </span>
        </div>
      </div>
    </PageSection>
  );
}
