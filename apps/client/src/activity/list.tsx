import type {
  ActivityInfo,
  AppIcon as AppIconInfo,
  AppInfo,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  ArchiveRestore,
  BatteryFull,
  BatteryWarning,
  Circle,
  CircleAlert,
  CircleDot,
  Hand,
  Plus,
  Power,
  RefreshCw,
  TabletSmartphone,
  Unlink,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { memo, useId, useState } from "react";

import { AppIcon } from "../app-icon";
import { automationsApp } from "../automations/page";
import { productName } from "../brand";
import { Avatar } from "../components";
import { timeText } from "../device-history-data";
import type { ActivityState, Folded } from "./data";
import { activityWords, type RoomNames, type Where } from "./words";

// The rows of an activity list: who or what did it by its mark, a person by
// their avatar, an app by its icon; what happened and who, a problem with an
// icon and red words; and the time. On a device's glass the rows sit
// straight on it, on an app's page in a filled card a day.

const zigbee: AppIconInfo = { glyph: "radio-tower", color: "graphite" };

// The icon an entry shows when no person or app did it.
function iconOf(entry: ActivityInfo): LucideIcon {
  switch (entry.action) {
    case "device.changed":
      return Hand;
    case "device.press":
      return CircleDot;
    case "device.offline":
      return WifiOff;
    case "device.online":
      return Wifi;
    case "device.left":
      return Unlink;
    case "device.quiet":
    case "device.battery.low":
      return BatteryWarning;
    case "device.battery.new":
      return BatteryFull;
    case "device.register":
      return Plus;
    case "sanctum.start":
      return Power;
    case "restore":
    case "restore.dismiss":
      return ArchiveRestore;
  }
  if (entry.action.startsWith("update.")) return RefreshCw;
  if (entry.who.kind === "client") return TabletSmartphone;
  if (entry.who.kind === "device") return Hand;
  return Circle;
}

function Mark(props: { entry: ActivityInfo; apps: readonly AppInfo[] }) {
  const { entry } = props;
  const { who } = entry;
  if (who.kind === "person" && who.name) {
    return <Avatar name={who.name} colour={who.colour ?? "var(--pewter)"} />;
  }
  const appId =
    entry.app?.id ??
    entry.run?.app ??
    (who.kind === "app" ? who.id : null) ??
    (entry.source.includes(".") ? entry.source : null);
  const icon =
    props.apps.find((app) => app.id === appId)?.icon ??
    (entry.action.startsWith("service.") || entry.action.startsWith("zigbee.")
      ? zigbee
      : entry.run || entry.action === "workflow.run"
        ? automationsApp.icon
        : null);
  if (icon) {
    return (
      <AppIcon icon={icon} className="size-8 shrink-0 [&_svg]:size-[18px]" />
    );
  }
  const Icon = iconOf(entry);
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/10">
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
    </span>
  );
}

export type ListContext = {
  where: Where;
  apps: readonly AppInfo[];
  rooms: RoomNames;
};

// A row renders again only when its entry or the list's context changes, so
// an older page or an entry arriving live renders its own rows, not all.
export const ActivityRow = memo(function ActivityRow(props: {
  entry: ActivityInfo;
  context: ListContext;
}) {
  const { entry, context } = props;
  const words = activityWords(entry, context.where, context.rooms);
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-3">
      <Mark entry={entry} apps={context.apps} />
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-sm font-medium",
            words.problem && "text-destructive",
          )}
        >
          {words.problem && (
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{words.title}</span>
        </span>
        {words.detail && (
          <span className="truncate text-[13px] font-medium text-muted-foreground">
            {words.detail}
          </span>
        )}
      </span>
      <time
        dateTime={entry.at}
        className="shrink-0 text-[13px] font-medium text-muted-foreground tabular-nums"
      >
        {timeText(Date.parse(entry.at))}
      </time>
    </div>
  );
});

/** A run's row, with what it did under it once someone opens it. */
export function FoldedRow(props: { row: Folded; context: ListContext }) {
  const { row, context } = props;
  const [open, setOpen] = useState(false);
  const id = useId();
  if (row.under.length === 0) {
    return <ActivityRow entry={row.entry} context={context} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <ActivityRow entry={row.entry} context={context} />
      <Button
        variant="link"
        size="label"
        className="ms-11 self-start"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? "Hide what it did" : `Show what it did (${row.under.length})`}
      </Button>
      {open && (
        <ul id={id} className="m-0 ms-11 flex list-none flex-col gap-3 p-0">
          {row.under.map((entry) => (
            <li key={entry.id}>
              <ActivityRow entry={entry} context={context} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Three rows' shape at once while the log loads, never a blank page. */
export function ActivitySkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading activity"
      className="flex flex-col gap-3"
    >
      {[62, 48, 56].map((width) => (
        <div key={width} className="flex min-h-9 items-center gap-3">
          <span className="size-8 shrink-0 rounded-full bg-foreground/8" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span
              className="h-3 rounded-sm bg-foreground/8"
              style={{ width: `${width}%` }}
            />
            <span className="h-2.5 w-1/4 rounded-sm bg-foreground/8" />
          </span>
          <span className="h-2.5 w-9 rounded-sm bg-foreground/8" />
        </div>
      ))}
    </div>
  );
}

/** Why the log is not shown, and how to try again. */
export function ActivityProblem(props: { what: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p
        role="alert"
        className="m-0 flex items-center gap-1.5 text-sm font-medium text-destructive"
      >
        <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        {props.what}
      </p>
      <p className="m-0 text-[13px] font-medium text-muted-foreground">
        {productName} didn't answer in time. Try again in a moment.
      </p>
      <Button variant="outline" size="sm" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** What a list says at its end: Show older, or how far back it goes. */
export function ActivityEnd(props: {
  more: boolean;
  older: ActivityState;
  end: string;
  onOlder: () => void;
}) {
  if (props.older === "failed") {
    return (
      <ActivityProblem
        what="Older activity didn't load"
        onRetry={props.onOlder}
      />
    );
  }
  if (props.more) {
    return (
      <Button
        variant="outline"
        className="self-center"
        disabled={props.older === "loading"}
        onClick={props.onOlder}
      >
        {props.older === "loading" ? "Loading older activity" : "Show older"}
      </Button>
    );
  }
  return (
    <p className="m-0 text-center text-[13px] font-medium text-muted-foreground">
      {props.end}
    </p>
  );
}
