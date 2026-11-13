import type {
  ActivityKind,
  AppInfo,
  DeviceInfo,
  Places,
} from "@meetsanctum/app-sdk";
import { Button, PageBar, type LiveFeed } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Section } from "../components";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { coreDevices } from "../core-devices";
import { coreJson } from "../core-fetch";
import { daysOf, foldCauses, useActivity, type Folded } from "./data";
import {
  ActivityEnd,
  ActivityProblem,
  ActivityRow,
  ActivitySkeleton,
  FoldedRow,
  type ListContext,
} from "./list";

// Activity: the home's whole log, a page of Settings with its title in the
// top bar and Done beside it. It shows everything or one kind, devices,
// automations, setup or the system, and one device's when opened from its
// detail, as a token that clears. Days are cards, newest first; what a
// press, a run or an app's action led to folds under it. Settings shows the
// newest few in a section of its own, with Show all.

export const activitySettingsPage = "activity";

const kindOptions: { value: ActivityKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "devices", label: "Devices" },
  { value: "automations", label: "Automations" },
  { value: "setup", label: "Setup" },
  { value: "system", label: "System" },
];

const onLook =
  "data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground/90 data-[state=on]:hover:text-background";

// Room names, for "Moved to Office", and device names for the token.
function usePlacesAndDevices() {
  const [places, setPlaces] = useState<Places>();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  useEffect(() => {
    let isCurrent = true;
    coreJson<Places>("/api/places")
      .then((next) => isCurrent && setPlaces(next))
      .catch(() => undefined);
    coreDevices()
      .then((next) => isCurrent && setDevices(next))
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, []);
  return { places, devices };
}

function roomNames(places: Places | undefined) {
  return (id: string) =>
    places?.rooms.find((room) => room.id === id)?.name ?? null;
}

// How far back a list goes, for its end.
function endWords(kind: ActivityKind | "all") {
  return kind === "setup" || kind === "system"
    ? "That's the last year."
    : kind === "all"
      ? "That's the last 30 days of devices and automations, and the last year of setup and the system."
      : "That's the last 30 days. Setup and the system go back a year: choose Setup or System to see them.";
}

export function ActivityPage(props: {
  device?: string;
  apps: readonly AppInfo[];
  live: LiveFeed;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const [device, setDevice] = useState(props.device);
  const { places, devices } = usePlacesAndDevices();
  const activity = useActivity(
    { device, kind: kind === "all" ? undefined : kind },
    props.live,
  );
  // The same context while nothing in it changes, so rows that have not
  // changed are not rendered again.
  const context = useMemo<ListContext>(
    () => ({ where: "home", apps: props.apps, rooms: roomNames(places) }),
    [props.apps, places],
  );
  // What a press, run or app's action led to folds under it, on its day.
  const days = useMemo(() => {
    const rows = foldCauses(activity.entries);
    const byEntry = new Map<string, Folded>(
      rows.map((row) => [row.entry.id, row]),
    );
    return daysOf(rows.map((row) => row.entry)).map((day) => ({
      ...day,
      rows: day.entries.map((entry) => byEntry.get(entry.id)!),
    }));
  }, [activity.entries]);
  const deviceName =
    devices.find((each) => each.id === device)?.name ??
    activity.entries.find((entry) => entry.subject?.id === device)?.subject
      ?.name ??
    "One device";

  return (
    <>
      <PageBar title="Activity">
        <Button variant="outline" onClick={props.onDone}>
          Done
        </Button>
      </PageBar>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          aria-label="Show"
          value={kind}
          onValueChange={(value: string) =>
            value && setKind(value as ActivityKind | "all")
          }
          spacing={1}
          className="rounded-md bg-foreground/8 p-0.75"
        >
          {kindOptions.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className={cn(
                "h-7.5 rounded-sm px-3 text-[13px] hover:bg-foreground/5",
                onLook,
              )}
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {device && (
          <span className="flex h-8 items-center gap-1 rounded-md bg-card ps-3 pe-1 text-sm font-medium">
            {deviceName}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Show the whole home"
              onClick={() => setDevice(undefined)}
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>
      {activity.state === "loading" ? (
        <Section id="activity-loading" title="Today">
          <ActivitySkeleton />
        </Section>
      ) : activity.state === "failed" ? (
        <Section id="activity-problem" title="Activity">
          <ActivityProblem
            what="Activity didn't load"
            onRetry={activity.retry}
          />
        </Section>
      ) : days.length === 0 ? (
        <Section id="activity-empty" title="Activity">
          <p className="m-0 text-sm font-medium">Nothing here yet</p>
          <p className="m-0 text-[13px] font-medium text-muted-foreground">
            What people, automations and devices do shows here: a light turned
            on, a remote pressed, a room added.
          </p>
        </Section>
      ) : (
        <>
          {days.map((day) => (
            <Section
              key={day.key}
              id={`activity-${day.key}`}
              title={day.heading}
            >
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {day.rows.map((row) => (
                  <li key={row.entry.id}>
                    <FoldedRow row={row} context={context} />
                  </li>
                ))}
              </ul>
            </Section>
          ))}
          <ActivityEnd
            more={activity.more}
            older={activity.older}
            end={endWords(kind)}
            onOlder={activity.loadOlder}
          />
        </>
      )}
    </>
  );
}

// How many entries Settings shows.
const newest = 5;

/** Settings → Activity: the newest few, and Show all. */
export function ActivitySection(props: {
  apps: readonly AppInfo[];
  live: LiveFeed;
  onShowAll: () => void;
}) {
  const activity = useActivity({}, props.live, { limit: newest });
  const context: ListContext = {
    where: "home",
    apps: props.apps,
    rooms: () => null,
  };
  return (
    <Section
      id="settings-activity"
      title="Activity"
      hint="Who did what in the home"
      action={
        <Button variant="outline" size="sm" onClick={props.onShowAll}>
          Show all
        </Button>
      }
    >
      {activity.state === "loading" ? (
        <ActivitySkeleton />
      ) : activity.state === "failed" ? (
        <ActivityProblem what="Activity didn't load" onRetry={activity.retry} />
      ) : activity.entries.length === 0 ? (
        <p className="m-0 text-[13px] font-medium text-muted-foreground">
          Nothing has happened yet.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {activity.entries.slice(0, newest).map((entry) => (
            <li key={entry.id}>
              <ActivityRow entry={entry} context={context} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
