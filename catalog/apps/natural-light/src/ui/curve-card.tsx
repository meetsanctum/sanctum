import type { Preview } from "../preview.js";
import { kelvinLabel, timeOfDay } from "./use-natural-light";

// Today's curve, from v1's preview banner: frosted Carbon glass, its title
// in Sun, what lights that follow it show now as its headline, sunrise, peak
// and sunset, and the day drawn as a line in Sun with a mark for now. Colour
// temperature and brightness ease alike between their ends, so one line
// draws both. Before the home has a location it says where to set one.

const muted = "text-[13px] leading-[18px] font-medium text-(--glass-secondary)";
const width = 320;
const height = 96;

export function CurveCard(props: { preview: Preview | null | undefined }) {
  const { preview } = props;
  return (
    <article
      aria-labelledby="natural-light-curve-title"
      className="col-span-5 row-span-3 flex min-w-0 flex-col gap-3 rounded-lg bg-(--glass) p-4 text-(--glass-ink) shadow-[inset_0_0_0_1px_var(--glass-line)] backdrop-blur-[24px]"
    >
      <h2
        id="natural-light-curve-title"
        className="m-0 text-[15px] leading-5 font-medium text-(--sun-text)"
      >
        Today
      </h2>
      {preview === null && (
        <p className={`m-0 ${muted}`}>
          Natural light follows the sun once the home’s location is set in
          Settings.
        </p>
      )}
      {preview && <Curve preview={preview} />}
    </article>
  );
}

function Curve(props: { preview: Preview }) {
  const { preview } = props;
  const { curve, timeZone } = preview;
  return (
    <>
      <p className="m-0 flex items-baseline gap-3">
        <span className="text-[40px] leading-none font-light">
          {kelvinLabel(preview.now.kelvin)}
        </span>
        <span className="text-[17px] font-light">
          {preview.now.brightness}%
        </span>
      </p>
      <p className={`m-0 ${muted}`}>
        Sunrise {timeOfDay(preview.sunrise, timeZone)} · Peak{" "}
        {timeOfDay(preview.peak, timeZone)} · Sunset{" "}
        {timeOfDay(preview.sunset, timeZone)}
      </p>
      <div className="relative h-24 w-full">
        <svg
          role="img"
          aria-label={`From ${curve.lowKelvin.toLocaleString()} K at ${curve.lowBrightness}% at night to ${curve.highKelvin.toLocaleString()} K at ${curve.highBrightness}% at its peak`}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <polyline
            points={line(preview, (point) =>
              share(point.kelvin, curve.lowKelvin, curve.highKelvin),
            )}
            fill="none"
            stroke="var(--sun-text)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* Now, on the colour temperature's line; round, as a status dot. */}
        <span
          aria-hidden="true"
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--glass-ink)"
          style={{
            left: `${(x(preview, preview.now.at) / width) * 100}%`,
            top: `${(y(share(preview.now.kelvin, curve.lowKelvin, curve.highKelvin)) / height) * 100}%`,
          }}
        />
      </div>
    </>
  );
}

// How far a value is between the curve's ends, from 0 to 1. The household
// may choose a cooler night than peak, so order the ends by temperature.
function share(value: number, night: number, peak: number) {
  const low = Math.min(night, peak);
  const high = Math.max(night, peak);
  return high > low
    ? Math.min(1, Math.max(0, (value - low) / (high - low)))
    : 0.5;
}

function x(preview: Preview, at: string) {
  const first = Date.parse(preview.points[0]!.at);
  const last = Date.parse(preview.points.at(-1)!.at);
  const instant = Math.min(last, Math.max(first, Date.parse(at)));
  return last > first ? ((instant - first) / (last - first)) * width : 0;
}

// The lines keep 4 units clear of the top and bottom for the mark for now.
const y = (share: number) => 4 + (1 - share) * (height - 8);

function line(
  preview: Preview,
  value: (point: Preview["points"][number]) => number,
) {
  return preview.points
    .map((point) => `${x(preview, point.at)},${y(value(point))}`)
    .join(" ");
}
