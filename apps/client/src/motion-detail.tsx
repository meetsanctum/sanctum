import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

import { productName } from "./brand";
import {
  Columns,
  Notice,
  Part,
  Readout,
  useDayAndWeek,
  useWidth,
  width,
  type ColumnWords,
} from "./device-history";
import {
  dayMs,
  daysOf,
  midnight,
  spansOf,
  timeText,
  type Span,
} from "./device-history-data";
import { motionText } from "./motion";
import {
  motionSentence,
  motionSpans,
  motionSpanText,
  motionWeekHeadline,
  spanTimes,
} from "./motion-history-data";
import { Battery } from "./sensor-detail";

// A motion sensor's Motion page, the first of its detail, from core History:
// under "Last 24 hours", what it says now and a sentence that says what the
// band shows on its own; the day as a band, motion as White spans, quiet as
// a hairline and nothing where nothing was known; and the week as a column
// of motion time a day, as a light's History has. The pointer or the arrow
// keys show a readout of a span or a day, and screen readers get each as a
// list. Its battery is at the foot, as on a sensor's Readings.

type Occupancy = Extract<CapabilityInfo, { kind: "occupancy" }>;

const minute = 60_000;
const bandHeight = 40;
// How near a span of motion the pointer has to be to show it, in px: a
// minute of motion is narrower than a pixel.
const snap = 4;

const motionWords: ColumnWords = {
  label: "How long there was motion each day",
  none: "No motion",
  spoken: (duration) => `${duration} of motion`,
};

/** What it says now, as its tile does. */
function nowText(device: DeviceInfo, capability: Occupancy, now: number) {
  if (device.availability === "offline") return "Offline";
  if (!capability.state) return "Waiting for a reading";
  return motionText(capability.state.occupied, capability.changedAt, now);
}

export function MotionPage(props: {
  device: DeviceInfo;
  capability: Occupancy;
}) {
  const { device, capability } = props;
  const { loaded, failed, now, live } = useDayAndWeek(device, capability);
  const dayId = useId();
  const from = now - dayMs;
  const spans = loaded ? spansOf(loaded.states, from, now, live) : [];
  const days = loaded ? daysOf(loaded.statistics, spans, now, "occupied") : [];

  return (
    <div
      data-loading={loaded || failed ? undefined : ""}
      className={`${width} flex flex-col gap-10 transition-opacity [--history-width:480px] data-loading:opacity-0`}
    >
      <section aria-labelledby={dayId} className="flex flex-col gap-1">
        <h3
          id={dayId}
          className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)"
        >
          Last 24 hours
        </h3>
        <p className="m-0 text-2xl leading-8 font-light">
          {nowText(device, capability, now)}
        </p>
        {loaded && !loaded.states.kept ? (
          <div className="mt-4">
            <Notice>
              {productName} doesn't keep this device's history. You can change
              that in Settings → Devices.
            </Notice>
          </div>
        ) : failed && !loaded ? (
          <div className="mt-4">
            <Notice>Its history can't be read right now.</Notice>
          </div>
        ) : (
          <>
            <p className="m-0 mb-4 text-[15px] leading-[22px] text-(--silver)">
              {motionSentence(spans, from, now)}
            </p>
            <Band spans={motionSpans(spans)} from={from} to={now} />
          </>
        )}
      </section>
      {loaded?.states.kept && (
        <Part title="Last 7 days" headline={motionWeekHeadline(days, now)}>
          <Columns days={days} now={now} words={motionWords} />
        </Part>
      )}
      <Battery level={device.battery} />
    </div>
  );
}

// Where the band's readout is: a span, and the pointer's place over it, or
// none for the arrow keys, which show it at its middle.
type Cursor = { index: number; x: number | null };

// The day as a band 40 px tall: motion as White spans, quiet as a hairline
// along its foot, and nothing where nothing was known. The pointer shows
// the span under it, a span of motion within a few pixels before quiet;
// the arrow keys step from span to span.
function Band(props: { spans: readonly Span[]; from: number; to: number }) {
  const { spans, from, to } = props;
  const { box, width: plot } = useWidth();
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const x = (at: number) => ((at - from) / (to - from)) * plot;
  const index =
    cursor && spans.length > 0 ? Math.min(cursor.index, spans.length - 1) : -1;
  const pointed = index >= 0 ? spans[index] : undefined;

  const spanAt = (left: number) => {
    const near = spans.findIndex(
      (span) =>
        span.on && x(span.from) - snap <= left && left <= x(span.to) + snap,
    );
    if (near >= 0) return near;
    const at = from + (left / Math.max(1, plot)) * (to - from);
    return spans.findIndex((span) => span.from <= at && at < span.to);
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const left =
      event.clientX - event.currentTarget.getBoundingClientRect().left;
    const found = spanAt(Math.max(0, Math.min(plot, left)));
    setCursor(found >= 0 ? { index: found, x: left } : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (spans.length === 0) return;
    const current = index >= 0 ? index : spans.length - 1;
    const next =
      event.key === "ArrowLeft"
        ? current - 1
        : event.key === "ArrowRight"
          ? current + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? spans.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setCursor({
      index: Math.max(0, Math.min(spans.length - 1, next)),
      x: null,
    });
  };
  const markAt = pointed
    ? (cursor?.x ?? (x(pointed.from) + x(pointed.to)) / 2)
    : null;
  // Every 6 hours of the day, away from the ends.
  const ticks: number[] = [];
  for (let at = midnight(from); at < to; at += 6 * 60 * minute) {
    const left = x(at);
    if (at > from && left > 20 && left < plot - 20) ticks.push(at);
  }

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label="Motion over the last 24 hours"
        className="relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ width: plot, height: bandHeight }}
        onPointerMove={fromPointer}
        onPointerDown={fromPointer}
        onPointerLeave={() => setCursor(null)}
        onFocus={() =>
          setCursor(
            (current) =>
              current ??
              (spans.length > 0 ? { index: spans.length - 1, x: null } : null),
          )
        }
        onBlur={() => setCursor(null)}
        onKeyDown={onKeyDown}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={bandHeight}
          className="block overflow-visible"
        >
          {spans.map((span) => {
            if (!span.known) return null;
            const left = Math.round(x(span.from));
            const right = Math.round(x(span.to));
            if (!span.on) {
              return (
                <rect
                  key={span.from}
                  x={left}
                  y={bandHeight - 1}
                  width={Math.max(0, right - left)}
                  height={1}
                  className="fill-white/30"
                />
              );
            }
            const spanWidth = Math.max(2, right - left);
            return (
              <rect
                key={span.from}
                x={left}
                y={0}
                width={spanWidth}
                height={bandHeight}
                rx={Math.min(3, spanWidth / 2)}
                className={span === pointed ? "fill-white" : "fill-white/70"}
              />
            );
          })}
          {pointed && !pointed.on && markAt !== null && (
            <rect
              x={Math.min(plot - 1, Math.round(markAt))}
              y={0}
              width={1}
              height={bandHeight}
              className="fill-white/40"
            />
          )}
        </svg>
        {pointed && markAt !== null && (
          <Readout
            x={markAt}
            width={plot}
            value={motionSpanText(pointed)}
            about={spanTimes(pointed, to)}
          />
        )}
      </div>
      <div
        aria-hidden="true"
        className="relative mt-2 h-[18px]"
        style={{ width: plot }}
      >
        {ticks.map((at) => (
          <span
            key={at}
            style={{ left: x(at) }}
            className="absolute top-0 -translate-x-1/2 text-[13px] leading-[18px] text-(--pewter) tabular-nums"
          >
            {timeText(at)}
          </span>
        ))}
      </div>
      <ul className="sr-only">
        {spans.map((span) => (
          <li key={span.from}>
            {timeText(span.from)} to {timeText(span.to)}: {motionSpanText(span)}
          </li>
        ))}
      </ul>
    </div>
  );
}
