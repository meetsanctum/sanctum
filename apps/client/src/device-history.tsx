import type {
  CapabilityInfo,
  DeviceHistory,
  DeviceInfo,
  DeviceStatistics,
} from "@meetsanctum/app-sdk";
import type { SwipePage } from "@meetsanctum/ui-sdk";
import { History } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { productName } from "./brand";
import { coreJson } from "./core-fetch";
import {
  dayHeadline,
  dayMs,
  daysOf,
  durationText,
  midnight,
  sentence,
  spansOf,
  spanText,
  timeText,
  weekday,
  weekHeadline,
  type Day,
  type Live,
  type Span,
} from "./device-history-data";

// A light's or a switch's History page in its detail, from core History: the
// last 24 hours as a strip, filled in the light's own colour as high as its
// brightness while it was on, and the last 7 days as a column a day of how
// long it was on. Each shows its value under the pointer or, with the
// arrow keys, under a cursor, and lists its values for screen readers. It
// reads the history when it opens and every 5 minutes, and carries what
// the device is now to the end of the strip meanwhile.

const minute = 60_000;
const refreshMs = 5 * minute;
// The strip's and the columns' heights, and the gutter for their scale.
const stripHeight = 88;
const bandHeight = 40;
const columnsHeight = 96;
const gutter = 40;
// As wide as it may be, and no wider than an overlay's content on a phone
// (overlay.tsx): a swipe page is only as wide as what it holds, so it
// cannot make the page narrower itself. The Activity page is as wide.
export const width =
  "w-[min(var(--history-width),calc(100vw-80px-env(safe-area-inset-left)-env(safe-area-inset-right)))]";

/**
 * The History page for a light or a switch, or none. A sensor's detail
 * charts its readings itself (sensor-detail.tsx).
 */
export function historyPage(
  device: DeviceInfo,
  capability: CapabilityInfo,
): SwipePage | null {
  if (capability.kind !== "light" && capability.kind !== "switch") return null;
  return {
    id: "history",
    label: "History",
    icon: History,
    content: (
      <DeviceHistoryPage
        key={`${device.id}/${capability.id}`}
        device={device}
        capability={capability}
      />
    ),
  };
}

type Loaded = { states: DeviceHistory; statistics: DeviceStatistics };

/**
 * A capability's changes over the last 24 hours and its hourly roll-ups
 * over the last 7 days, read when it is shown and every 5 minutes, with
 * every change seen live since, and the page's sense of now, a minute
 * fresh. A motion sensor's Motion page reads them too (motion-detail.tsx).
 */
export function useDayAndWeek(device: DeviceInfo, capability: CapabilityInfo) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    const load = async () => {
      const to = Date.now();
      const query = (more: Record<string, string>) =>
        new URLSearchParams({
          device: device.id,
          capability: capability.id,
          to: new Date(to).toISOString(),
          ...more,
        });
      try {
        const [states, statistics] = await Promise.all([
          coreJson<DeviceHistory>(
            `/api/history/states?${query({ from: new Date(to - dayMs).toISOString() })}`,
          ),
          coreJson<DeviceStatistics>(
            `/api/history/statistics?${query({
              period: "hour",
              from: new Date(midnight(to, 6)).toISOString(),
            })}`,
          ),
        ]);
        if (!current) return;
        setLoaded({ states, statistics });
        setLive((changes) =>
          changes.filter((change) => change.since >= Date.parse(states.to)),
        );
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
  }, [device.id, capability.id]);

  // Keep every change seen since the last history read. The next read
  // replaces these with the core's recorded times.
  const liveKey = JSON.stringify([device.availability, capability.observed]);
  const [live, setLive] = useState<Live[]>([]);
  useEffect(() => {
    const [availability, state] = JSON.parse(liveKey) as [
      Live["availability"],
      Live["state"],
    ];
    const at = Date.now();
    setLive((changes) => [
      ...changes.filter(
        (_, index) => (changes[index + 1]?.since ?? at) > at - dayMs,
      ),
      { availability, state, since: at },
    ]);
    setNow(at);
  }, [liveKey]);

  return { loaded, failed, now, live };
}

function DeviceHistoryPage(props: {
  device: DeviceInfo;
  capability: CapabilityInfo;
}) {
  const { capability } = props;
  const { loaded, failed, now, live } = useDayAndWeek(props.device, capability);

  if (loaded && !loaded.states.kept) {
    return (
      <Notice>
        {productName} doesn't keep this device's history. You can change that in
        Settings → Devices.
      </Notice>
    );
  }
  if (failed && !loaded) {
    return <Notice>Its history can't be read right now.</Notice>;
  }

  const from = now - dayMs;
  const spans = loaded ? spansOf(loaded.states, from, now, live) : [];
  const dims =
    capability.kind === "light" && capability.features.brightness === true;
  const days = loaded ? daysOf(loaded.statistics, spans, now) : [];

  return (
    <div
      data-loading={loaded ? undefined : ""}
      className={`${width} flex flex-col gap-10 transition-opacity [--history-width:520px] data-loading:opacity-0`}
    >
      <Part title="Last 24 hours" headline={dayHeadline(spans, from, now)}>
        <Strip spans={spans} from={from} to={now} dims={dims} />
      </Part>
      <Part title="Last 7 days" headline={weekHeadline(days, now)}>
        <Columns days={days} now={now} />
      </Part>
    </div>
  );
}

export function Notice(props: { children: ReactNode }) {
  return (
    <p
      className={`${width} m-0 text-center text-[15px] leading-[22px] text-(--silver) [--history-width:400px]`}
    >
      {props.children}
    </p>
  );
}

export function Part(props: {
  title: string;
  headline: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h3
        id={id}
        className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)"
      >
        {props.title}
      </h3>
      <p className="m-0 text-2xl leading-8 font-light">{props.headline}</p>
      <div className="mt-4">{props.children}</div>
    </section>
  );
}

// The width a chart has, in whole pixels, so its marks sit on them at 1×.
export function useWidth<Box extends HTMLElement = HTMLDivElement>() {
  const box = useRef<Box>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { box, width };
}

/** A readout over a chart, its value first and what it is about after. */
export function Readout(props: {
  x: number;
  width: number;
  value: string;
  about: string;
  colour?: string;
}) {
  // Kept within the chart, whatever side of it the pointer is on.
  const left = Math.max(0, Math.min(props.x - 64, props.width - 128));
  return (
    <div
      aria-hidden="true"
      style={{ left }}
      className="pointer-events-none absolute -top-14 z-10 flex w-32 flex-col rounded-md whitespace-nowrap border border-white/14 bg-(--carbon) px-2.5 py-1.5"
    >
      <span className="flex items-center gap-1.5 text-[15px] leading-5">
        {props.colour && (
          <span
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: props.colour }}
          />
        )}
        {props.value}
      </span>
      <span className="text-[13px] leading-[18px] text-(--silver)">
        {props.about}
      </span>
    </div>
  );
}

// Where a pointer or the arrow keys point along a chart, in its own steps.
export function useCursor(
  steps: number,
  // Which step a pointer at x falls on, where the steps aren't all as wide.
  stepAt?: (x: number, width: number) => number,
) {
  const [at, setAt] = useState<number | null>(null);
  const fromPointer =
    (width: number) => (event: PointerEvent<HTMLDivElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(width - 1, event.clientX - box.left));
      setAt(
        Math.min(
          steps - 1,
          stepAt ? stepAt(x, width) : Math.floor((x / width) * steps),
        ),
      );
    };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? 4 : 1;
    const current = at ?? steps - 1;
    const next =
      event.key === "ArrowLeft"
        ? current - by
        : event.key === "ArrowRight"
          ? current + by
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? steps - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setAt(Math.max(0, Math.min(steps - 1, next)));
  };
  return {
    at,
    handlers: (width: number) => ({
      onPointerMove: fromPointer(width),
      onPointerDown: fromPointer(width),
      onPointerLeave: () => setAt(null),
      onFocus: () => setAt((current) => current ?? steps - 1),
      onBlur: () => setAt(null),
      onKeyDown,
    }),
  };
}

// The strip's cursor moves in quarter hours.
const quarters = 24 * 4;

function Strip(props: {
  spans: readonly Span[];
  from: number;
  to: number;
  dims: boolean;
}) {
  const { spans, from, to, dims } = props;
  const { box, width } = useWidth();
  const cursor = useCursor(quarters);
  const plot = Math.max(0, width - (dims ? gutter : 0));
  const height = dims ? stripHeight : bandHeight;
  const x = (at: number) => Math.round(((at - from) / (to - from)) * plot);
  const spanAt = (at: number) =>
    spans.find((span) => span.from <= at && at < span.to);
  const pointed =
    cursor.at === null
      ? null
      : from + ((cursor.at + 0.5) / quarters) * (to - from);
  const pointedSpan = pointed === null ? undefined : spanAt(pointed);
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
        aria-label={`${dims ? "Brightness" : "On and off"} over the last 24 hours`}
        className="relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ width: plot, height }}
        {...cursor.handlers(plot)}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={height}
          className="block overflow-visible"
        >
          {dims && (
            <rect
              x={0}
              y={0}
              width={plot}
              height={1}
              className="fill-white/8"
            />
          )}
          {spans.map((span) => {
            const left = x(span.from);
            const right = Math.max(left + 1, x(span.to));
            if (!span.known) return null;
            if (!span.on) {
              return (
                <rect
                  key={span.from}
                  x={left}
                  y={height - 1}
                  width={right - left}
                  height={1}
                  className="fill-white/14"
                />
              );
            }
            const level =
              span.brightness === null
                ? height
                : Math.max(2, Math.round((height * span.brightness) / 100));
            return (
              <g key={span.from}>
                <rect
                  x={left}
                  y={height - level}
                  width={right - left}
                  height={level}
                  fill={span.colour}
                  fillOpacity={0.4}
                />
                <rect
                  x={left}
                  y={height - level}
                  width={right - left}
                  height={2}
                  fill={span.colour}
                />
              </g>
            );
          })}
          {pointed !== null && (
            <rect
              x={Math.min(plot - 1, x(pointed))}
              y={0}
              width={1}
              height={height}
              className="fill-white/40"
            />
          )}
        </svg>
        {pointed !== null && (
          <Readout
            x={x(pointed)}
            width={plot}
            value={spanText(pointedSpan)}
            about={timeText(pointed)}
            colour={pointedSpan?.on ? pointedSpan.colour : undefined}
          />
        )}
      </div>
      {dims && (
        <span
          aria-hidden="true"
          className="absolute top-0 right-0 -translate-y-1/2 text-[13px] leading-[18px] text-(--pewter) tabular-nums"
        >
          100%
        </span>
      )}
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
            {timeText(span.from)} to {timeText(span.to)}: {spanText(span)}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The columns' scale: the least of these hours that holds the longest day.
const scales = [1, 2, 4, 6, 8, 12, 16, 24];

const dayAndDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** What the columns call a day: a light's or a switch's, unless said. */
export type ColumnWords = {
  /** What the chart shows, for a screen reader. */
  label: string;
  /** A known day without any. */
  none: string;
  /** A day's time, as a screen reader's list says it. */
  spoken: (duration: string) => string;
};

const onWords: ColumnWords = {
  label: "How long it was on each day",
  none: "Off",
  spoken: (duration) => `on for ${duration}`,
};

/** The week as a column a day, as tall as the time it was on that day. */
export function Columns(props: {
  days: readonly Day[];
  now: number;
  words?: ColumnWords;
}) {
  const { days, now, words = onWords } = props;
  const { box, width } = useWidth();
  const cursor = useCursor(days.length || 1);
  const plot = Math.max(0, width - gutter);
  const slot = plot / Math.max(1, days.length);
  const columnWidth = Math.max(4, Math.min(24, Math.floor(slot - 8)));
  const longest = Math.max(0, ...days.map((each) => each.on / 3600));
  const scale = scales.find((hours) => hours >= longest) ?? 24;
  const today = midnight(now);
  const nameOf = (day: Day) =>
    day.start === today ? "Today" : weekday.format(day.start);
  const valueOf = (day: Day) =>
    day.known === 0
      ? "Not known"
      : day.on === 0
        ? words.none
        : sentence(durationText(day.on));
  const pointed = cursor.at === null ? undefined : days[cursor.at];

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={words.label}
        className="relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ width: plot, height: columnsHeight }}
        {...cursor.handlers(plot)}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={columnsHeight}
          className="block"
        >
          <rect x={0} y={0} width={plot} height={1} className="fill-white/8" />
          <rect
            x={0}
            y={columnsHeight - 1}
            width={plot}
            height={1}
            className="fill-white/14"
          />
          {days.map((day, index) => {
            if (day.on === 0) return null;
            const height = Math.max(
              2,
              Math.round((columnsHeight * day.on) / 3600 / scale),
            );
            const left = Math.round(slot * index + (slot - columnWidth) / 2);
            const top = columnsHeight - height;
            const radius = Math.min(4, height);
            return (
              <path
                key={day.start}
                d={`M${left},${columnsHeight}V${top + radius}Q${left},${top} ${left + radius},${top}H${left + columnWidth - radius}Q${left + columnWidth},${top} ${left + columnWidth},${top + radius}V${columnsHeight}Z`}
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
      <span
        aria-hidden="true"
        className="absolute top-0 right-0 -translate-y-1/2 text-[13px] leading-[18px] text-(--pewter) tabular-nums"
      >
        {scale} h
      </span>
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
            {dayAndDate.format(day.start)}:{" "}
            {day.on > 0 ? words.spoken(durationText(day.on)) : valueOf(day)}
          </li>
        ))}
      </ul>
    </div>
  );
}
