import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import { useHomeClock } from "@meetsanctum/ui-sdk";
import { LineChart } from "@meetsanctum/ui-sdk/charts";
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { productName } from "./brand";
import { Row, Section } from "./components";
import { Skeleton } from "./components/ui/skeleton";
import { hotCelsius, type HostInfo, type HostProblem } from "./system-status";
import {
  memoryChart,
  memoryNow,
  processorChart,
  processorNow,
  readingDay,
  temperatureChart,
  temperatureNow,
  useHostDay,
} from "./system-status-day";

// System's last 24 hours: the processor, its temperature and the memory in
// use, stacked on one time axis as iOS's Battery page stacks its own, so a
// spike reads across all three at once. Each is headed by its name, with
// the latest reading under it; the chart is a sensor's day, drawn in the
// page's ink. While the day is on its way or can't be read, what each
// reads now still heads it.

const chartHeight = 72;
// Half of the 5 minutes each kept reading stands for.
const halfOfFive = 150_000;
const lastDayTitle = "Last 24 Hours";

function Reading(props: {
  name: string;
  // What it reads now, in red with a sign where the verdict counts it as a
  // problem.
  now: string | null;
  nowProblem?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 text-sm font-medium">{props.name}</h3>
        {props.now && (
          <p
            className={cn(
              "m-0 flex min-w-0 items-center gap-1 text-sm text-muted-foreground tabular-nums",
              props.nowProblem && "text-destructive",
            )}
          >
            {props.nowProblem && (
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            {props.now}
          </p>
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
  // When the host was last read, which the lines are carried on to.
  checkedAt: string;
}) {
  const { host, unit } = props;
  const clock = useHomeClock();
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
      <Skeleton
        aria-hidden={false}
        aria-busy="true"
        className="h-18 rounded-xs"
      />
    );
    return (
      <Section id="status-day" title={lastDayTitle}>
        <div className={cn("flex flex-col", failed ? "gap-3" : "gap-6")}>
          <Reading {...heading.processor}>{shape}</Reading>
          {host.processor.celsius !== null && (
            <Reading {...heading.temperature}>{shape}</Reading>
          )}
          {host.memory && <Reading {...heading.memory}>{shape}</Reading>}
          {failed && (
            <Row
              title="Not known right now"
              detail={`Shows again once ${productName}'s updater answers`}
            />
          )}
        </div>
      </Section>
    );
  }
  const { points, through } = day;
  const usage = readingDay(points, "usage", now, host.processor.usage, through);
  const celsius = readingDay(
    points,
    "celsius",
    now,
    host.processor.celsius,
    through,
  );
  const memory = readingDay(
    points,
    "memoryUsed",
    now,
    host.memory && host.memory.total - host.memory.available,
    through,
  );
  const showsTemperature = celsius.max !== null;
  const temperature = temperatureChart(unit);
  // The hourly averages a screen reader gets can hide a hot five minutes, so
  // its label says when it was too hot: from the start of the first hot
  // 5 minutes kept to the end of the last, each drawn at its middle.
  const hot = celsius.runs
    .flat()
    .filter((point) => point.at < now && point.value >= hotCelsius);
  const temperatureLabel = hot.length
    ? `Temperature over the last 24 hours. Too hot from ${clock.timeText(hot[0]!.at - halfOfFive)} to ${clock.timeText(hot.at(-1)!.at + halfOfFive)}.`
    : undefined;
  const total = host.memory?.total;
  const memoryScale = total ? memoryChart(total) : null;
  // The hours show once, under the last chart.
  const last = memoryScale
    ? "memory"
    : showsTemperature
      ? "temperature"
      : "processor";

  return (
    <Section id="status-day" title={lastDayTitle}>
      <div className="flex flex-col gap-6">
        <Reading {...heading.processor}>
          {usage.runs.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              Nothing read yet
            </p>
          ) : (
            <LineChart
              runs={usage.runs}
              now={now}
              name="Processor in use"
              height={chartHeight}
              tone="page"
              hours={last === "processor"}
              {...processorChart}
            />
          )}
        </Reading>
        {showsTemperature && (
          <Reading {...heading.temperature}>
            <LineChart
              runs={celsius.runs}
              now={now}
              name="Temperature"
              label={temperatureLabel}
              height={chartHeight}
              tone="page"
              hours={last === "temperature"}
              {...temperature}
            />
          </Reading>
        )}
        {memoryScale && (
          <Reading {...heading.memory}>
            <LineChart
              runs={memory.runs}
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
