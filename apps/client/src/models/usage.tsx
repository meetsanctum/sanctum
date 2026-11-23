import type { AppInfo, ModelsInfo } from "@meetsanctum/app-sdk";
import { Button, SegmentedControl } from "@meetsanctum/ui-sdk";
import { useId, useState, type KeyboardEvent } from "react";

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

type Series = { key: string; name: string; tokens: number[] };

// Fixed by each one's place in the home's list, so a series keeps its
// colour whichever is shown or in use. Blue is for what can be pressed, and
// orange and red say what doesn't fit, so neither is a series colour. More
// than three fold into one.
const colours = [
  "text-[#1baf7a] dark:text-[#199e70]",
  "text-[#6250d6] dark:text-[#9085e9]",
  "text-[#e87ba4] dark:text-[#d55181]",
];

function withOthers(series: Series[], others: string): Series[] {
  if (series.length <= colours.length) return series;
  const kept = series.slice(0, colours.length - 1);
  const rest = series.slice(colours.length - 1);
  return [
    ...kept,
    {
      key: "others",
      name: others,
      tokens: rest[0]!.tokens.map((_, day) =>
        rest.reduce((sum, each) => sum + each.tokens[day]!, 0),
      ),
    },
  ];
}

const sum = (tokens: readonly number[]) =>
  tokens.reduce((total, each) => total + each, 0);
const count = (value: number) => value.toLocaleString();

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

function dayText(day: string, isToday: boolean) {
  if (isToday) return "Today";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function Chart(props: { series: Series[]; days: string[]; label: string }) {
  const { series, days } = props;
  const [day, setDay] = useState<number>();
  const [pinned, setPinned] = useState<number>();
  const last = days.length - 1;
  const top = niceTop(Math.max(...series.flatMap((each) => each.tokens)));
  const x = (at: number) => (at / last) * 100;
  const y = (value: number) => 100 - (value / top) * 100;
  const shown = day ?? pinned;

  const dayAt = (clientX: number, box: DOMRect) =>
    box.width > 0
      ? Math.round(
          Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * last,
        )
      : last;
  const keys = (event: KeyboardEvent) => {
    const from = shown ?? last + 1;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, from - 1)
        : event.key === "ArrowRight"
          ? Math.min(last, from + 1)
          : undefined;
    if (event.key === "Escape") {
      setPinned(undefined);
      setDay(undefined);
    }
    if (next === undefined) return;
    event.preventDefault();
    setDay(undefined);
    setPinned(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <div className="relative flex w-8 shrink-0 flex-col justify-between text-end text-[11px] leading-none text-muted-foreground tabular-nums">
          <span>{scaleText(top)}</span>
          <span>{scaleText(top / 2)}</span>
          <span>0</span>
        </div>
        <div
          role="group"
          aria-label={props.label}
          tabIndex={0}
          className="relative h-32 min-w-0 flex-1 cursor-crosshair rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onPointerMove={(event) =>
            event.pointerType === "mouse" &&
            setDay(
              dayAt(event.clientX, event.currentTarget.getBoundingClientRect()),
            )
          }
          onPointerLeave={() => setDay(undefined)}
          onClick={(event) =>
            setPinned(
              dayAt(event.clientX, event.currentTarget.getBoundingClientRect()),
            )
          }
          onKeyDown={keys}
          onBlur={() => setPinned(undefined)}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="absolute inset-0 size-full overflow-visible"
          >
            {[0, 50, 100].map((at) => (
              <line
                key={at}
                x1="0"
                x2="100"
                y1={at}
                y2={at}
                className="stroke-foreground/10"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {shown !== undefined && (
              <line
                x1={x(shown)}
                x2={x(shown)}
                y1="0"
                y2="100"
                className="stroke-muted-foreground"
                strokeWidth="1"
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {series.map((each, at) => (
              <path
                key={each.key}
                d={each.tokens
                  .map(
                    (value, index) =>
                      `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`,
                  )
                  .join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className={colours[at]}
              />
            ))}
          </svg>
          <div
            role="status"
            className={
              shown === undefined
                ? "sr-only"
                : "pointer-events-none absolute top-0 z-10 min-w-44 -translate-x-1/2 rounded-md bg-popover px-2.5 py-2 text-[12px] leading-4 text-popover-foreground shadow-md"
            }
            style={
              shown === undefined
                ? undefined
                : { left: `clamp(5.5rem, ${x(shown)}%, calc(100% - 5.5rem))` }
            }
          >
            {shown !== undefined && (
              <>
                <div className="mb-1 font-semibold">
                  {dayText(days[shown]!, shown === last)}
                </div>
                {series.map((each, at) => (
                  <div key={each.key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`h-[3px] w-3 shrink-0 rounded-xs bg-current ${colours[at]}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {each.name}
                    </span>
                    <span className="font-medium tabular-nums">
                      {count(each.tokens[shown]!)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex justify-between ps-10 text-[11px] leading-none text-muted-foreground">
        <span>{dayText(days[0]!, false)}</span>
        <span>{dayText(days[Math.floor(last / 2)]!, false)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

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
      tokens: each.tokens,
    })),
    "Other sources",
  );
  const byApp = withOthers(
    [
      ...(usage?.apps ?? []).map((each) => ({
        key: each.id,
        name: appNames.get(each.id) ?? each.id,
        tokens: each.tokens,
      })),
      ...(usage && sum(usage.checks) > 0
        ? [
            {
              key: "checks",
              name: "Checks in Settings",
              tokens: usage.checks,
            },
          ]
        : []),
    ],
    "Other apps",
  );
  const total = sum(bySource.flatMap((each) => each.tokens));
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
                  className={`h-[3px] w-3.5 shrink-0 rounded-xs bg-current ${colours[at]}`}
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {each.name}
                </span>
                <span className="font-medium tabular-nums">
                  {count(sum(each.tokens))}
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
                    <AppIcon icon={installed.icon} className="size-8" />
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
