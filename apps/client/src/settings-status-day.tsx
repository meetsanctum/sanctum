import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Row, Section } from "./components";
import { DayLineChart } from "./day-line";
import { hotCelsius, type HostInfo, type HostProblem } from "./system-status";
import {
  memoryChart,
  memoryNow,
  memorySummary,
  processorChart,
  processorNow,
  processorSummary,
  readingDay,
  temperatureChart,
  temperatureNow,
  temperatureSummary,
  useHostDay,
} from "./system-status-day";

// Status' last 24 hours: the processor, its temperature and the memory in
// use, stacked on one time axis as iOS's Battery page stacks its own, so a
// spike reads across all three at once. Each is headed by what it reads now,
// as Status read it last, then what its day came to in words; the chart is a
// sensor's day, drawn in the page's ink. While the day is on its way or
// can't be read, what each reads now still heads it.

const chartHeight = 72;

// A line of what a reading says, in red with a sign where it's a problem.
function Said(props: {
  className: string;
  problem?: boolean;
  children: string;
}) {
  return (
    <p
      className={cn(
        "m-0 flex min-w-0 items-center gap-1 text-muted-foreground tabular-nums",
        props.className,
        props.problem && "text-destructive",
      )}
    >
      {props.problem && (
        <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      {props.children}
    </p>
  );
}

function Reading(props: {
  name: string;
  // What it reads now, and whether the verdict counts it as a problem.
  now: string | null;
  nowProblem?: boolean;
  // What its day came to, and whether it was a problem.
  summary?: string;
  problem?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <h3 className="m-0 text-sm font-medium">{props.name}</h3>
          {props.now && (
            <Said className="text-sm" problem={props.nowProblem}>
              {props.now}
            </Said>
          )}
        </div>
        {props.summary && (
          <Said className="text-[13px] font-medium" problem={props.problem}>
            {props.summary}
          </Said>
        )}
      </div>
      {props.children}
    </div>
  );
}

export function LastDaySection(props: {
  host: HostInfo;
  problems: HostProblem[];
  unit: TemperatureUnit;
  // When Status read the host last, which the lines are carried on to.
  checkedAt: string;
}) {
  const { host, unit } = props;
  const now = Date.parse(props.checkedAt);
  const { day, failed } = useHostDay(now);
  const heading = {
    processor: { name: "Processor", now: processorNow(host.processor.usage) },
    temperature: {
      name: "Temperature",
      now: temperatureNow(host.processor.celsius, unit),
      nowProblem: props.problems.some((each) => each.kind === "heat"),
    },
    memory: { name: "Memory in use", now: memoryNow(host.memory) },
  };
  if (!day) {
    const shape = failed ? undefined : (
      <div aria-busy="true" className="flex flex-col gap-2.5">
        <span className="block h-3 w-2/5 rounded-xs bg-foreground/8" />
        <span className="block h-18 rounded-xs bg-foreground/8" />
      </div>
    );
    return (
      <Section id="status-day" title="Last 24 hours">
        <div className={cn("flex flex-col", failed ? "gap-3" : "gap-6")}>
          <Reading {...heading.processor}>{shape}</Reading>
          {host.processor.celsius !== null && (
            <Reading {...heading.temperature}>{shape}</Reading>
          )}
          {host.memory && <Reading {...heading.memory}>{shape}</Reading>}
          {failed && (
            <Row
              title="Not known right now"
              detail="Shows again once Updates and services answers"
            />
          )}
        </div>
      </Section>
    );
  }
  const { points, through } = day;
  const usage = readingDay(
    points,
    "usage",
    now,
    undefined,
    host.processor.usage,
    through,
  );
  const celsius = readingDay(
    points,
    "celsius",
    now,
    hotCelsius,
    host.processor.celsius,
    through,
  );
  const memory = readingDay(
    points,
    "memoryUsed",
    now,
    undefined,
    host.memory && host.memory.total - host.memory.available,
    through,
  );
  const showsTemperature =
    host.processor.celsius !== null || celsius.mean !== null;
  const temperature = temperatureChart(unit);
  const total = host.memory?.total;
  const memoryScale = total ? memoryChart(total) : null;
  // The hours show once, under the last chart.
  const last = memoryScale
    ? "memory"
    : showsTemperature
      ? "temperature"
      : "processor";

  return (
    <Section id="status-day" title="Last 24 hours">
      <div className="flex flex-col gap-6">
        <Reading {...heading.processor} summary={processorSummary(usage)}>
          <DayLineChart
            line={usage.line}
            now={now}
            name="Processor in use"
            height={chartHeight}
            tone="page"
            hours={last === "processor"}
            {...processorChart}
          />
        </Reading>
        {showsTemperature && (
          <Reading
            {...heading.temperature}
            summary={temperatureSummary(celsius, unit)}
            problem={celsius.over !== null}
          >
            <DayLineChart
              line={celsius.line}
              now={now}
              name="Temperature"
              height={chartHeight}
              tone="page"
              hours={last === "temperature"}
              {...temperature}
            />
          </Reading>
        )}
        {memoryScale && (
          <Reading {...heading.memory} summary={memorySummary(memory)}>
            <DayLineChart
              line={memory.line}
              now={now}
              name="Memory in use"
              height={chartHeight}
              tone="page"
              {...memoryScale}
            />
          </Reading>
        )}
      </div>
    </Section>
  );
}
