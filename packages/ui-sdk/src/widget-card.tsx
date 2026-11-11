import type {
  AppColor,
  TemperatureUnit,
  WidgetBlock,
  WidgetContent,
  WidgetSize,
  WidgetValue,
} from "@meetsanctum/app-sdk";
import { Check } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { Button } from "./components/ui/button";
import { useHomeTimeZone } from "./home-time-zone";
import { showFailed } from "./show-failed";
import { useTemperatureUnit } from "./temperature-unit";
import { formatLightLevel, formatNumber, formatTemperature } from "./units";
import { widgetIconOf } from "./widget-icons";

// A widget's card, which the shell draws from what its app shows, on
// dashboards and on the app's own pages alike: frosted Carbon glass, its
// title in the app's colour, then its blocks in the app's order. Values
// arrive typed and are written here, in the household's unit, the home's
// time zone and this device's language, so no app writes a unit, a time or a
// weekday itself. While it can't be used, as when its app isn't running, it
// says so beside its title and what it shows dims.

/** How the shell writes a card's values. */
type Shown = { unit: TemperatureUnit; timeZone: string | undefined };

/** A card's value as the household reads it, such as "8°", "07:04" or "Wed". */
export function formatWidgetValue(value: WidgetValue, shown: Shown) {
  if (typeof value === "string") return value;
  if ("temperature" in value) {
    // Whole degrees, the unit clear from the card, as a forecast shows them.
    return formatTemperature(value.temperature, shown.unit, {
      compact: true,
      whole: true,
    });
  }
  if ("time" in value) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: shown.timeZone,
    }).format(new Date(value.time));
  }
  if ("date" in value) {
    return new Intl.DateTimeFormat(
      undefined,
      value.as === "day"
        ? { day: "numeric", month: "short", timeZone: "UTC" }
        : { weekday: "short", timeZone: "UTC" },
    ).format(new Date(`${value.date}T12:00:00Z`));
  }
  if ("percent" in value) return `${Math.round(value.percent)}%`;
  return value.unit === "lux"
    ? formatLightLevel(value.number)
    : formatNumber(value.number);
}

// A line's words with its {name} values written in.
function lineText(block: Extract<WidgetBlock, { kind: "line" }>, shown: Shown) {
  return block.text.replace(/\{(\w+)\}/g, (token, name: string) => {
    const value = block.values?.[name];
    return value === undefined ? token : formatWidgetValue(value, shown);
  });
}

const muted = "text-[13px] leading-[18px] font-medium text-(--glass-secondary)";

/** Runs one of the card's app's actions, through the gate, as whoever pressed it. */
export type RunWidgetAction = (
  action: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export function WidgetCard(props: {
  title: string;
  /** The app's colour, for its title; Graphite for an app without one. */
  color: AppColor | null;
  size: WidgetSize;
  /** What the app shows; only the title while it has shown nothing. */
  content: WidgetContent | null;
  /** Runs a check's or the button's action; without it, they cannot be pressed. */
  run?: RunWidgetAction;
  /** Opens one of the app's pages, for a button that opens one. */
  open?: (page: string) => void;
  /**
   * Why it can't be used now, such as Paused while its app isn't running:
   * said beside its title, while what it shows dims and can't be pressed.
   */
  unavailable?: string;
}) {
  const titleId = useId();
  const unit = useTemperatureUnit();
  const timeZone = useHomeTimeZone();
  // Until the unit is known, no temperature shows in the other one.
  const shown = unit === undefined ? null : { unit, timeZone };
  return (
    <article
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-3 rounded-lg bg-(--glass) p-4 text-(--glass-ink) shadow-[inset_0_0_0_1px_var(--glass-line)] backdrop-blur-[24px]"
      style={{
        gridColumn: `span ${props.size.columns} / span ${props.size.columns}`,
        gridRow: `span ${props.size.rows} / span ${props.size.rows}`,
      }}
    >
      <h2
        id={titleId}
        className="m-0 flex items-baseline gap-2 text-[15px] leading-5 font-medium"
        style={{ color: `var(--${props.color ?? "graphite"}-text)` }}
      >
        {props.title}
        {props.unavailable && (
          <span className="ms-auto truncate text-[13px] leading-[18px] text-(--glass-secondary)">
            <span className="sr-only">, </span>
            {props.unavailable}
          </span>
        )}
      </h2>
      {/* Always there, so a screen reader hears why the card stopped
          answering as it happens, not only when it reaches the title. */}
      <span role="status" className="sr-only">
        {props.unavailable && `${props.title}, ${props.unavailable}`}
      </span>
      {/* Always there, so a card that becomes unavailable keeps its place. */}
      <div
        inert={props.unavailable !== undefined}
        className={`flex min-h-0 flex-1 flex-col gap-3${props.unavailable ? " opacity-50" : ""}`}
      >
        {shown &&
          props.content &&
          grouped(props.content.blocks).map((group, index) => (
            <Blocks
              key={index}
              group={group}
              shown={shown}
              run={props.run}
              open={props.open}
            />
          ))}
      </div>
    </article>
  );
}

// A line right after the headline is its detail, close under it; every
// other block keeps the card's gap.
function grouped(blocks: readonly WidgetBlock[]) {
  const groups: WidgetBlock[][] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (
      block.kind === "line" &&
      last?.length === 1 &&
      last[0]!.kind === "headline"
    ) {
      last.push(block);
    } else {
      groups.push([block]);
    }
  }
  return groups;
}

function Blocks(props: {
  group: WidgetBlock[];
  shown: Shown;
  run?: RunWidgetAction;
  open?: (page: string) => void;
}) {
  const { group } = props;
  if (group.length > 1) {
    return (
      <div className="flex flex-col gap-1">
        {group.map((block, index) => (
          <Block key={index} {...props} block={block} />
        ))}
      </div>
    );
  }
  return <Block {...props} block={group[0]!} />;
}

function Block(props: {
  block: WidgetBlock;
  shown: Shown;
  run?: RunWidgetAction;
  open?: (page: string) => void;
}) {
  const { block, shown } = props;
  const value = (each: WidgetValue) => formatWidgetValue(each, shown);
  switch (block.kind) {
    case "headline": {
      const Icon = block.icon ? widgetIconOf[block.icon] : null;
      return (
        <div className="flex items-center gap-3">
          {Icon &&
            (block.iconLabel ? (
              <Icon
                role="img"
                aria-label={block.iconLabel}
                className="size-10 shrink-0"
                strokeWidth={1.5}
              />
            ) : (
              <Icon
                aria-hidden="true"
                className="size-10 shrink-0"
                strokeWidth={1.5}
              />
            ))}
          <span className="text-[48px] leading-none font-light">
            {value(block.value)}
          </span>
        </div>
      );
    }
    case "line":
      return (
        <p className={`m-0 truncate ${muted}`}>{lineText(block, shown)}</p>
      );
    case "note":
      return <p className={`m-0 ${muted}`}>{block.text}</p>;
    case "facts":
      return (
        <p className={`m-0 flex gap-4 ${muted}`}>
          {block.items.map((item, index) => {
            const Icon = widgetIconOf[item.icon];
            return (
              <span key={index} className="flex items-center gap-1.5">
                <Icon aria-hidden="true" className="size-4" />
                <span className="sr-only">{item.label}</span>
                {value(item.value)}
              </span>
            );
          })}
        </p>
      );
    case "columns":
      return (
        <ul
          className="m-0 mt-auto grid list-none gap-1 p-0"
          // Five at least, so a short forecast keeps its columns' width.
          style={{
            gridTemplateColumns: `repeat(${Math.max(5, block.items.length)}, minmax(0, 1fr))`,
          }}
        >
          {block.items.map((item, index) => {
            const Icon = widgetIconOf[item.icon];
            return (
              <li
                key={index}
                className="flex flex-col items-center gap-1 text-[13px] leading-[18px] font-medium"
              >
                <span className="text-(--glass-secondary)">
                  {value(item.label)}
                </span>
                <Icon
                  role="img"
                  aria-label={item.iconLabel}
                  className="size-5"
                  strokeWidth={1.75}
                />
                <span>{value(item.value)}</span>
                {item.detail !== undefined && (
                  <span className="text-(--glass-secondary)">
                    {value(item.detail)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      );
    case "rows":
      return (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {block.items.map((item, index) => (
            <li key={index} className="flex min-w-0 items-center gap-3">
              {item.check && (
                <Checkbox
                  checked={item.check.checked}
                  label={value(item.text)}
                  run={
                    props.run &&
                    (() => props.run!(item.check!.action, item.check!.input))
                  }
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] leading-5 font-medium">
                  {value(item.text)}
                </span>
                {item.detail !== undefined && (
                  <span className={`truncate ${muted}`}>
                    {value(item.detail)}
                  </span>
                )}
              </span>
              {item.value !== undefined && (
                <span className={`shrink-0 tabular-nums ${muted}`}>
                  {value(item.value)}
                </span>
              )}
            </li>
          ))}
        </ul>
      );
    case "action": {
      const Icon = block.icon ? widgetIconOf[block.icon] : null;
      const { page, action } = block;
      const run =
        page !== undefined
          ? props.open && (async () => props.open!(page))
          : action !== undefined && props.run
            ? () => props.run!(action, block.input ?? {})
            : undefined;
      return (
        <Pressable run={run}>
          {(press, ref) => (
            <Button
              ref={ref}
              disabled={!run}
              onClick={press}
              size="lg"
              className="mt-auto w-full"
            >
              {Icon && <Icon aria-hidden="true" />}
              {block.label}
            </Button>
          )}
        </Pressable>
      );
    }
  }
}

// What runs an action from a card: pressed once until it settles, and
// shaking when it fails, as a tile does.
function Pressable(props: {
  run: (() => Promise<unknown>) | undefined;
  children: (
    press: () => void,
    ref: (element: HTMLButtonElement | null) => void,
  ) => ReactNode;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const [pending, setPending] = useState(false);
  const press = () => {
    if (!props.run || pending) return;
    setPending(true);
    props
      .run()
      .catch(() => showFailed(button.current, null))
      .finally(() => setPending(false));
  };
  return props.children(press, (element) => {
    button.current = element;
  });
}

// A row's check: a hairline square, filled in Electric blue once done.
function Checkbox(props: {
  checked: boolean;
  label: string;
  run: (() => Promise<unknown>) | undefined;
}) {
  return (
    <Pressable run={props.run}>
      {(press, ref) => (
        <button
          ref={ref}
          type="button"
          role="checkbox"
          aria-checked={props.checked}
          aria-label={props.label}
          disabled={!props.run}
          onClick={press}
          className="-m-1 grid size-7 shrink-0 place-items-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span
            className={
              props.checked
                ? "grid size-5 place-items-center rounded-xs bg-(--action) text-(--white)"
                : "size-5 rounded-xs shadow-[inset_0_0_0_1px_var(--glass-line)]"
            }
          >
            {props.checked && (
              <Check
                aria-hidden="true"
                className="size-3.5"
                strokeWidth={2.5}
              />
            )}
          </span>
        </button>
      )}
    </Pressable>
  );
}
