import type { AppInfo, ModelsInfo } from "@meetsanctum/app-sdk";
import { dayText } from "@meetsanctum/app-sdk/clock";
import { number } from "@meetsanctum/app-sdk/words";
import { Button, SegmentedControl } from "@meetsanctum/ui-sdk";
import { LineChart, type DaysLineChartProps } from "@meetsanctum/ui-sdk/charts";
import { useId, useState } from "react";

import { AppIcon } from "../app-icon";
import { Row, Section } from "../components";
import type { ModelsResponse } from "./data";
import { sourceName } from "./words";

// Settings → AI models' Tokens used: the last 30 days as a line for each
// model or each app, as Show chooses, with each one's total under it, and
// the apps that may use the home's AI model. Hover, a tap or the arrow keys
// read a day's tokens. A home that hasn't used any says so instead.

type Shown = "models" | "apps";

const shownOptions: { value: Shown; label: string }[] = [
  { value: "models", label: "Models" },
  { value: "apps", label: "Apps" },
];

type Series = { key: string; name: string; values: number[] };

// Each keeps the colour of its place in the home's list, the theme's
// --series-1 to --series-3, whichever is shown or in use. More than three
// fold into one.
function withOthers(
  series: Series[],
  others: string,
): DaysLineChartProps["series"] {
  const [first, second, third, ...rest] = series;
  if (!first) return [];
  if (!second) return [first];
  if (!third) return [first, second];
  if (rest.length === 0) return [first, second, third];
  return [
    first,
    second,
    {
      key: "others",
      name: others,
      values: third.values.map((value, day) =>
        rest.reduce((sum, each) => sum + each.values[day]!, value),
      ),
    },
  ];
}

const sum = (tokens: readonly (number | null)[]) =>
  tokens.reduce<number>((total, each) => total + (each ?? 0), 0);
const count = (value: number) => number("en", value);

// The top of the scale: 1, 2 or 5 times a power of ten, at least the most.
function niceTop(most: number) {
  if (most <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(most));
  return [1, 2, 5, 10].map((step) => step * power).find((top) => top >= most)!;
}

function scaleText(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  }
  return String(value);
}

// A day of the home's, 2026-11-03, as the chart takes it: its midnight in
// UTC, which says it whatever the device's own time zone.
const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`);

const dateText = (start: number) => dayText(start, "UTC");

function Chart(props: {
  series: DaysLineChartProps["series"];
  days: string[];
  label: string;
}) {
  const { series } = props;
  const top = niceTop(
    Math.max(
      ...series.flatMap((each) => each.values.map((value) => value ?? 0)),
    ),
  );
  return (
    <LineChart
      mode="days"
      days={props.days.map(startOf)}
      series={series}
      format={format}
      scale={{ min: 0, max: top, lines: [0, top / 2, top] }}
      name="Tokens used"
      label={props.label}
      height={128}
      date={dateText}
      tone="page"
    />
  );
}

const format = {
  gutter: 40,
  shown: (value: number) => value,
  text: count,
  grid: scaleText,
};

export function TokensUsed(props: {
  info: ModelsResponse;
  installed: readonly AppInfo[];
}) {
  const { info } = props;
  const { usage } = info;
  const [shown, setShown] = useState<Shown>("models");
  const showId = useId();
  const names = new Map(
    info.sources.map((each) => [each.id, sourceName(each)]),
  );
  const appNames = new Map(
    [...props.installed, ...info.apps].map((app) => [app.id, app.name]),
  );
  const bySource = withOthers(
    (usage?.sources ?? []).map((each) => ({
      key: each.id,
      name: names.get(each.id) ?? "A source",
      values: each.tokens,
    })),
    "Other sources",
  );
  const byApp = withOthers(
    [
      ...(usage?.apps ?? []).map((each) => ({
        key: each.id,
        name: appNames.get(each.id) ?? each.id,
        values: each.tokens,
      })),
      ...(usage && sum(usage.checks) > 0
        ? [
            {
              key: "checks",
              name: "Checks in Settings",
              values: usage.checks,
            },
          ]
        : []),
    ],
    "Other apps",
  );
  const total = sum(bySource.flatMap((each) => each.values));
  const series = shown === "models" ? bySource : byApp;

  return (
    <Section
      id="settings-models-tokens"
      title="Tokens Used"
      hint={
        total > 0 ? `${count(total)} tokens in the last 30 days` : undefined
      }
      action={
        total > 0 && (
          <div className="flex items-center gap-2">
            <span
              id={showId}
              className="text-[13px] font-medium text-muted-foreground"
            >
              Show
            </span>
            <SegmentedControl
              labelledBy={showId}
              options={shownOptions}
              value={shown}
              onValueChange={(value) => setShown(value)}
              size="sm"
            />
          </div>
        )
      }
    >
      {!usage ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {info.sources.map((source) => (
            <li key={source.id}>
              <Row
                title={sourceName(source)}
                detail={`Today ${count(source.tokens.today)} · last 30 days ${count(source.tokens.month)}`}
              />
            </li>
          ))}
        </ul>
      ) : total === 0 ? (
        <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
          None in the last 30 days. Tokens show here once an app asks your
          home's AI model something, or Settings checks a source.
        </p>
      ) : (
        <>
          <Chart
            key={shown}
            series={series}
            days={usage.days}
            label={`Tokens used each day of the last 30, by ${shown === "models" ? "model" : "app"}. The arrow keys read each day.`}
          />
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {series.map((each, at) => (
              <li key={each.key} className="flex items-center gap-2.5 text-sm">
                <span
                  aria-hidden="true"
                  className="h-[3px] w-3.5 shrink-0 rounded-xs"
                  style={{ background: `var(--series-${at + 1})` }}
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {each.name}
                </span>
                <span className="font-medium tabular-nums">
                  {count(sum(each.values))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
        What a provider charges, and any limit on it, is set with that provider.
      </p>
    </Section>
  );
}

export function AppsUsing(props: {
  apps: ModelsInfo["apps"];
  installed: readonly AppInfo[];
  onOpenApp?: (appId: string) => void;
}) {
  const { apps } = props;
  return (
    <Section id="settings-models-apps" title="Apps That Use It">
      {apps.length === 0 ? (
        <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
          No app uses your home's AI model yet. Apps that need it ask for
          permission when you add them.
        </p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {apps.map((app) => {
              const installed = props.installed.find(
                (each) => each.id === app.id,
              );
              return (
                <li key={app.id} className="flex items-center gap-3">
                  {installed?.icon && (
                    <AppIcon
                      appId={installed.id}
                      icon={installed.icon}
                      className="size-8"
                    />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
                    <span className="truncate text-sm font-medium">
                      {app.name}
                    </span>
                    <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                      {app.tokens.month > 0
                        ? "Uses your home's AI model"
                        : "Hasn't asked in the last 30 days"}
                    </span>
                  </span>
                  {props.onOpenApp &&
                    installed &&
                    installed.pages.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => props.onOpenApp?.(app.id)}
                      >
                        Open
                      </Button>
                    )}
                </li>
              );
            })}
          </ul>
          <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            An app uses your home's AI model with the permission Use your home's
            AI model, which you can turn off in its settings.
          </p>
        </>
      )}
    </Section>
  );
}
