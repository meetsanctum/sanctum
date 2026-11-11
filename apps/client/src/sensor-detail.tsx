import {
  lowBattery,
  type DeviceInfo,
  type DeviceStatistics,
  type SensorMeasure,
  type TemperatureUnit,
} from "@meetsanctum/app-sdk";
import {
  convertTemperature,
  formatLightLevel,
  formatLightLevelRange,
  formatNumber,
  formatTemperature,
  formatTemperatureRange,
  icons,
} from "@meetsanctum/ui-sdk";
import { useEffect, useId, useState } from "react";

import { productName } from "./brand";
import { coreJson } from "./core-fetch";
import { DayLineChart } from "./day-line";
import { Notice, Part, Readout, useCursor, useWidth } from "./device-history";
import { dayMs, midnight, weekday } from "./device-history-data";
import { measureNames } from "./device-tiles";
import { lowBatteryText } from "./maintenance";
import {
  dayLine,
  scaleOf,
  weekRange,
  weekRanges,
  type DayRange,
} from "./sensor-history-data";

// A sensor's detail: for each of its readings, what it reads now, its lowest
// and highest of the last 24 hours with the day as a line, and each day's
// lowest and highest of the week, from core History. Each chart shows its
// value under the pointer or, with the arrow keys, under a cursor, and
// lists its values for screen readers; the text above it says what it
// shows on its own. Its battery is at the foot, unless its Motion page has
// it (motion-detail.tsx). It reads the history when it opens and every 5
// minutes; what it reads now comes live.

const minute = 60_000;
const refreshMs = 5 * minute;
// The length of History's shorter roll-ups.
const fiveMinutes = 5 * minute;
const lineHeight = 108;
const barsHeight = 96;
const width =
  "w-[min(var(--history-width),calc(100vw-80px-env(safe-area-inset-left)-env(safe-area-inset-right)))]";

type Sensor = Extract<DeviceInfo["capabilities"][number], { kind: "sensor" }>;

/**
 * A reading as the page shows it: in the home's unit, a temperature to a
 * tenth, humidity in whole percent, a light level in lux; and the gutter
 * its gridlines' values take, on the right.
 */
function readingFormat(measure: SensorMeasure, unit: TemperatureUnit) {
  if (measure === "illuminance") {
    return {
      gutter: 60,
      shown: (value: number) => value,
      text: formatLightLevel,
      range: formatLightLevelRange,
      // A gridline's value: "1,000 lx".
      grid: formatLightLevel,
    };
  }
  if (measure === "temperature") {
    return {
      gutter: 36,
      shown: (value: number) => convertTemperature(value, "celsius", unit),
      text: (value: number) =>
        formatTemperature(value, unit, { compact: true }),
      range: (min: number, max: number) =>
        formatTemperatureRange(min, max, unit, { compact: true }),
      // A gridline's value, already in the unit shown: "22°".
      grid: (shownValue: number) => `${formatNumber(shownValue)}°`,
    };
  }
  const whole = (value: number) => Math.round(value);
  return {
    gutter: 36,
    shown: (value: number) => value,
    text: (value: number) => `${whole(value)}%`,
    range: (min: number, max: number) =>
      whole(min) === whole(max)
        ? `${whole(min)}%`
        : `${whole(min)}–${whole(max)}%`,
    grid: (shownValue: number) => `${whole(shownValue)}%`,
  };
}

type Format = ReturnType<typeof readingFormat>;

export function SensorDetail(props: {
  device: DeviceInfo;
  unit: TemperatureUnit;
  /** Whether its battery shows at the foot: not where another page has it. */
  battery?: boolean;
}) {
  const { device, unit } = props;
  const sensors = device.capabilities.filter(
    (each): each is Sensor => each.kind === "sensor",
  );
  const formats = sensors.map((sensor) =>
    readingFormat(sensor.features.measures, unit),
  );
  // One gutter for every column, so their charts line up.
  const gutter = Math.max(0, ...formats.map((format) => format.gutter));
  return (
    <div className="flex max-w-full flex-col items-center gap-10">
      <div className="flex max-w-full flex-wrap justify-center gap-x-14 gap-y-12">
        {sensors.map((sensor, index) => (
          <SensorReading
            key={sensor.id}
            device={device}
            sensor={sensor}
            format={{ ...formats[index]!, gutter }}
          />
        ))}
      </div>
      {props.battery !== false && <Battery level={device.battery} />}
    </div>
  );
}

/** A sensor's battery at the foot of its page; under 20% in red with a sign. */
export function Battery(props: { level: number | null }) {
  const { level } = props;
  if (level === null) return null;
  return (
    <p
      className={`m-0 flex items-center gap-1.5 text-[13px] leading-[18px] font-medium ${level < lowBattery ? "text-(--danger)" : "text-(--silver)"}`}
    >
      {level < lowBattery && (
        <icons.TriangleAlert aria-hidden="true" className="size-3.5" />
      )}
      {level < lowBattery ? lowBatteryText(level) : `Battery ${level}%`}
    </p>
  );
}

type Loaded = { day: DeviceStatistics; week: DeviceStatistics };

function SensorReading(props: {
  device: DeviceInfo;
  sensor: Sensor;
  format: Format;
}) {
  const { device, sensor, format } = props;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const titleId = useId();

  useEffect(() => {
    let current = true;
    const load = async () => {
      const to = Date.now();
      const query = (more: Record<string, string>) =>
        new URLSearchParams({
          device: device.id,
          capability: sensor.id,
          to: new Date(to).toISOString(),
          ...more,
        });
      try {
        const [day, week] = await Promise.all([
          coreJson<DeviceStatistics>(
            `/api/history/statistics?${query({
              period: "5m",
              // History answers the periods that start from `from`, so
              // the day is asked from the start of the 5 minutes it
              // begins in.
              from: new Date(
                Math.floor((to - dayMs) / fiveMinutes) * fiveMinutes,
              ).toISOString(),
            })}`,
          ),
          coreJson<DeviceStatistics>(
            `/api/history/statistics?${query({
              period: "hour",
              from: new Date(midnight(to, 6)).toISOString(),
            })}`,
          ),
        ]);
        if (!current) return;
        setLoaded({ day, week });
        setFailed(false);
        setNow(Date.now());
      } catch {
        if (current) setFailed(true);
      }
    };
    void load();
    const reload = setInterval(() => void load(), refreshMs);
    const tick = setInterval(() => setNow(Date.now()), minute);
    return () => {
      current = false;
      clearInterval(reload);
      clearInterval(tick);
    };
  }, [device.id, sensor.id]);

  const reading =
    device.availability === "offline" ? null : (sensor.state?.value ?? null);
  const line = dayLine(loaded?.day ?? null, now, reading);
  const days = weekRanges(loaded?.week ?? null, now, reading);
  const week = weekRange(days);
  const name = measureNames[sensor.features.measures];

  return (
    <section
      aria-labelledby={titleId}
      data-loading={loaded || failed ? undefined : ""}
      className={`${width} flex flex-col gap-1.5 transition-opacity [--history-width:360px] data-loading:opacity-0`}
    >
      <h3
        id={titleId}
        className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)"
      >
        {name}
      </h3>
      <p className="m-0 text-[40px] leading-[48px] font-light tracking-[-0.02em] tabular-nums">
        {reading === null ? "–" : format.text(reading)}
      </p>
      {loaded && !loaded.day.kept ? (
        <Notice>
          {productName} doesn't keep this device's history. You can change that
          in Settings → Devices.
        </Notice>
      ) : failed && !loaded ? (
        <Notice>Its history can't be read right now.</Notice>
      ) : (
        <>
          <p className="m-0 mb-2.5 text-[15px] leading-[22px] text-(--silver)">
            {line.min === null || line.max === null
              ? "Nothing read in the last 24 hours"
              : `${format.range(line.min, line.max)} in the last 24 hours`}
          </p>
          <DayLineChart
            line={line}
            now={now}
            format={format}
            name={name}
            height={lineHeight}
          />
          <div className="mt-6">
            <Part
              title="Last 7 days"
              headline={
                week ? format.range(week.min, week.max) : "Not known yet"
              }
            >
              <Bars days={days} now={now} format={format} name={name} />
            </Part>
          </div>
        </>
      )}
    </section>
  );
}

const dayAndDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

// Each day of the week as a bar from its lowest to its highest.
function Bars(props: {
  days: readonly DayRange[];
  now: number;
  format: Format;
  name: string;
}) {
  const { days, now, format } = props;
  const { box, width } = useWidth();
  const cursor = useCursor(days.length || 1);
  const plot = Math.max(0, width - format.gutter);
  const slot = plot / Math.max(1, days.length);
  const barWidth = Math.max(4, Math.min(24, Math.floor(slot - 8)));
  const known = days.filter((day) => day.min !== null && day.max !== null);
  const shown = known.flatMap((day) => [
    format.shown(day.min!),
    format.shown(day.max!),
  ]);
  const scale =
    shown.length > 0 ? scaleOf(Math.min(...shown), Math.max(...shown)) : null;
  const y = (shownValue: number) =>
    scale
      ? barsHeight -
        ((shownValue - scale.min) / (scale.max - scale.min)) * barsHeight
      : 0;
  const today = midnight(now);
  const nameOf = (day: DayRange) =>
    day.start === today ? "Today" : weekday.format(day.start);
  const valueOf = (day: DayRange) =>
    day.min === null || day.max === null
      ? "Not known"
      : format.range(day.min, day.max);
  const pointed = cursor.at === null ? undefined : days[cursor.at];

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={`Each day's lowest and highest ${props.name.toLowerCase()}`}
        className="relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ width: plot, height: barsHeight }}
        {...cursor.handlers(plot)}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={barsHeight}
          className="block"
        >
          {scale?.lines.map((value) => (
            <rect
              key={value}
              x={0}
              y={Math.round(y(value))}
              width={plot}
              height={1}
              className="fill-white/12"
            />
          ))}
          {days.map((day, index) => {
            if (day.min === null || day.max === null) return null;
            const top = Math.round(y(format.shown(day.max)));
            const height = Math.max(
              4,
              Math.round(y(format.shown(day.min))) - top,
            );
            const left = Math.round(slot * index + (slot - barWidth) / 2);
            return (
              <rect
                key={day.start}
                x={left}
                y={top}
                width={barWidth}
                height={height}
                rx={4}
                className={pointed === day ? "fill-white" : "fill-white/70"}
              />
            );
          })}
        </svg>
        {pointed && (
          <Readout
            x={Math.round(slot * (cursor.at! + 0.5))}
            width={plot}
            value={valueOf(pointed)}
            about={dayAndDate.format(pointed.start)}
          />
        )}
      </div>
      {scale?.lines.map((value) => (
        <span
          key={value}
          aria-hidden="true"
          style={{ top: Math.round(y(value)) }}
          className="absolute right-0 -translate-y-1/2 text-[13px] leading-[18px] text-(--pewter) tabular-nums"
        >
          {format.grid(value)}
        </span>
      ))}
      <div
        aria-hidden="true"
        className="relative mt-2 h-[18px]"
        style={{ width: plot }}
      >
        {days.map((day, index) => (
          <span
            key={day.start}
            style={{ left: Math.round(slot * (index + 0.5)) }}
            className="absolute top-0 -translate-x-1/2 text-[13px] leading-[18px] text-(--pewter)"
          >
            {nameOf(day)}
          </span>
        ))}
      </div>
      <ul className="sr-only">
        {days.map((day) => (
          <li key={day.start}>
            {dayAndDate.format(day.start)}: {valueOf(day)}
          </li>
        ))}
      </ul>
    </div>
  );
}
