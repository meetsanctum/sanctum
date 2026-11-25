import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import { useHomeClock } from "@meetsanctum/ui-sdk";
import { DayBandChart, WeekColumnsChart } from "@meetsanctum/ui-sdk/charts";
import { useId } from "react";

import { productName } from "./brand";
import {
  columnsOf,
  Notice,
  Part,
  useDayAndWeek,
  width,
  type ColumnWords,
} from "./device-history";
import {
  bandSpan,
  countedDays,
  dayMs,
  daysOf,
  joinedSpans,
  spansOf,
  type Day,
  type Span,
} from "./device-history-data";
import { Battery } from "./sensor-detail";

// The first page of a sensor that says one thing or its opposite over
// time, a motion sensor's motion or a contact sensor's being open, from
// core History: under "Last 24 hours", what it says now and a sentence
// that says what the band shows on its own; the day as a band, the one as
// White spans, the other as a hairline and nothing where nothing was known;
// and the week as a column of that time a day, as a light's History has,
// or of how often it came on where the sensor's words count that.
// The pointer or the arrow keys show a readout of a span or a day, and
// screen readers get each as a list. Its battery is at the foot, as on a
// sensor's Readings. Which value of its history it reads and every word it
// says are the sensor's own (motion-detail.tsx, contact-detail.tsx).

/** What such a page reads and says for one kind of sensor, by the home clock. */
export type DayAndWeekWords = {
  /** The value of its history that the band draws White. */
  field: "motion" | "open";
  /** What it says now. */
  now: (clock: HomeClock, now: number) => string;
  /** The line under that, which says what the band shows on its own. */
  sentence: (
    clock: HomeClock,
    spans: readonly Span[],
    from: number,
    now: number,
  ) => string;
  /** What the band is, for a screen reader. */
  band: string;
  /** What a span is, in the band's readout. */
  span: (span: Span) => string;
  /** What the last 7 days come to. */
  week: (clock: HomeClock, days: readonly Day[], now: number) => string;
  columns: ColumnWords;
  /**
   * Whether the week counts how often it came on each day, as a door's
   * openings, in place of for how long: its changes are then read over the
   * 7 days.
   */
  counted?: boolean;
};

export function DayAndWeek(props: {
  device: DeviceInfo;
  capability: CapabilityInfo;
  words: DayAndWeekWords;
}) {
  const { device, capability, words } = props;
  const { loaded, failed, now, live } = useDayAndWeek(
    device,
    capability,
    words.counted,
  );
  const dayId = useId();
  const clock = useHomeClock();
  const from = now - dayMs;
  const spans = loaded ? spansOf(loaded.states, from, now, live) : [];
  const timed = loaded
    ? daysOf(clock, loaded.statistics, spans, now, words.field)
    : [];
  const days =
    loaded && words.counted
      ? countedDays(
          clock,
          timed,
          spansOf(loaded.states, clock.startOfDay(now, 6) - 1, now, live),
        )
      : timed;

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
          {words.now(clock, now)}
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
              {words.sentence(clock, spans, from, now)}
            </p>
            <DayBandChart
              spans={joinedSpans(spans)
                .filter((span) => span.to > span.from)
                .map(bandSpan)}
              from={from}
              to={now}
              label={words.band}
              text={words.span}
            />
          </>
        )}
      </section>
      {loaded?.states.kept && (
        <Part title="Last 7 days" headline={words.week(clock, days, now)}>
          <WeekColumnsChart now={now} {...columnsOf(days, words.columns)} />
        </Part>
      )}
      <Battery device={device} />
    </div>
  );
}
