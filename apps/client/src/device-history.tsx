import type {
  CapabilityInfo,
  DeviceHistory,
  DeviceInfo,
  DeviceStatistics,
} from "@meetsanctum/app-sdk";
import { useHomeClock, type SwipePage } from "@meetsanctum/ui-sdk";
import {
  DayStripChart,
  WeekColumnsChart,
  type WeekColumnsChartProps,
} from "@meetsanctum/ui-sdk/charts";
import { History } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { productName } from "./brand";
import { coreJson } from "./core-fetch";
import {
  dayHeadline,
  dayMs,
  daysOf,
  durationText,
  hourMs,
  sentence,
  spansOf,
  spanText,
  stripSpan,
  weekHeadline,
  type Day,
  type Live,
} from "./device-history-data";
import { useChartClock } from "./use-chart-clock";
import { everyWhileShown } from "./while-shown";

// A light's or a switch's History page in its detail, from core History: the
// last 24 hours as a strip, filled in the light's own colour as high as its
// brightness while it was on, and the last 7 days as a column a day of how
// long it was on. Each shows its value under the pointer or, with the
// arrow keys, under a cursor, and lists its values for screen readers. It
// reads the history when it opens and every 5 minutes, and carries what
// the device is now to the end of the strip meanwhile.

const minute = 60_000;
const refreshMs = 5 * minute;
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
 * fresh, its days the home clock's. A motion sensor's Motion page reads
 * them too (motion-detail.tsx).
 * A page that counts changes by day reads its changes over the 7 days
 * (`weekOfChanges`), which the roll-ups do not hold.
 */
export function useDayAndWeek(
  device: DeviceInfo,
  capability: CapabilityInfo,
  weekOfChanges = false,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useChartClock(setNow);
  const clock = useHomeClock();

  useEffect(() => {
    let current = true;
    const load = async () => {
      const to = Date.now();
      const weekStart = clock.startOfDay(to, 6);
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
            `/api/history/states?${query({
              from: new Date(
                // Keep the preceding state for an opening at midnight.
                weekOfChanges ? weekStart - 1 : to - dayMs,
              ).toISOString(),
            })}`,
          ),
          coreJson<DeviceStatistics>(
            `/api/history/statistics?${query({
              period: "hour",
              // Include the UTC hour that overlaps the week's first midnight.
              from: new Date(
                Math.floor(weekStart / hourMs) * hourMs,
              ).toISOString(),
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
    const stopReloads = everyWhileShown(refreshMs, () => void load());
    return () => {
      current = false;
      stopReloads();
    };
  }, [device.id, capability.id, weekOfChanges, clock]);

  // Keep every change seen since the last history read. The next read
  // replaces these with the core's recorded times.
  const { kind, observed } = capability;
  const historyState =
    kind === "media" && observed
      ? { on: observed.on, activity: observed.activity }
      : observed;
  const liveKey = JSON.stringify([device.availability, historyState]);
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
  const clock = useHomeClock();

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
  const days = loaded ? daysOf(clock, loaded.statistics, spans, now) : [];

  return (
    <div
      data-loading={loaded ? undefined : ""}
      className={`${width} flex flex-col gap-10 transition-opacity [--history-width:520px] data-loading:opacity-0`}
    >
      <Part
        title="Last 24 hours"
        headline={dayHeadline(clock, spans, from, now)}
      >
        <DayStripChart
          spans={spans.map(stripSpan)}
          from={from}
          to={now}
          levels={dims}
          text={spanText}
        />
      </Part>
      <Part title="Last 7 days" headline={weekHeadline(clock, days, now)}>
        <WeekColumnsChart now={now} {...columnsOf(days)} />
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
  /** A line under the headline, as a media player's History says. */
  sentence?: string | null;
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
      {props.sentence && (
        <p className="m-0 text-[15px] leading-[22px] text-(--silver)">
          {props.sentence}
        </p>
      )}
      <div className="mt-4">{props.children}</div>
    </section>
  );
}

/** What the columns call a day: a light's or a switch's, unless said. */
export type ColumnWords = {
  /** What the chart shows, for a screen reader. */
  label: string;
  /** A known day without any. */
  none: string;
  /** A day's time, as a screen reader's list says it. */
  spoken: (duration: string) => string;
  /**
   * For a week of counts in place of times (`Day.count`): a day's count as
   * its readout says it, and as a screen reader's list does.
   */
  counts?: {
    value: (count: number) => string;
    spoken: (count: number) => string;
  };
};

const onWords: ColumnWords = {
  label: "How long it was on each day",
  none: "Off",
  spoken: (duration) => `on for ${duration}`,
};

/**
 * The week's days as a week's columns take them: each day's time on in
 * hours, or how often it came on where the words count that, and what the
 * words say of a day.
 */
export function columnsOf(
  days: readonly Day[],
  words: ColumnWords = onWords,
): Omit<WeekColumnsChartProps<Day & { value: number | null }>, "now"> {
  const { counts } = words;
  return {
    days: days.map((day) => {
      const amount = counts ? (day.count ?? 0) : day.on / 3600;
      return {
        ...day,
        value: day.known === 0 && amount === 0 ? null : amount,
      };
    }),
    scale: counts ? "counts" : "hours",
    label: words.label,
    none: words.none,
    text: (day) =>
      counts ? counts.value(day.count ?? 0) : sentence(durationText(day.on)),
    spoken: (day) =>
      counts
        ? counts.spoken(day.count ?? 0)
        : words.spoken(durationText(day.on)),
  };
}
