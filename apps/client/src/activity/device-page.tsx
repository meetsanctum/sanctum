import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { Button, type LiveFeed, type SwipePage } from "@meetsanctum/ui-sdk";
import { List } from "lucide-react";
import { useId } from "react";

import { width } from "../device-history";
import { daysOf, useActivity } from "./data";
import {
  ActivityProblem,
  ActivityRow,
  ActivitySkeleton,
  type ListContext,
} from "./list";
import { lastChangeWords } from "./words";

// A device's Activity page in its detail, after History: its last change, or
// a remote's last press, then what happened to it lately, by day, straight
// on the glass, and Show all in Activity for the rest. History says what it
// was; this says who did what.

// As many as the detail shows; Activity has the rest.
const shown = 8;

export type DeviceActivityContext = ListContext & {
  live: LiveFeed;
  onShowAll: (device: string) => void;
};

/** The Activity page for a device's detail, opened from one of its capabilities' tiles or, for a device with none, from its own. */
export function activityPage(
  device: DeviceInfo,
  capability: CapabilityInfo | undefined,
  context: DeviceActivityContext,
): SwipePage {
  return {
    id: "activity",
    label: "Activity",
    icon: List,
    content: (
      <DeviceActivity
        key={device.id}
        device={device}
        isRemote={capability?.kind === "button"}
        context={context}
      />
    ),
  };
}

function DeviceActivity(props: {
  device: DeviceInfo;
  isRemote: boolean;
  context: DeviceActivityContext;
}) {
  const { device, isRemote, context } = props;
  const activity = useActivity({ device: device.id }, context.live, {
    limit: shown,
  });
  const headingId = useId();
  const entries = activity.entries.slice(0, shown);
  const last = entries.find((entry) =>
    isRemote
      ? entry.action === "device.press"
      : (entry.action === "device.command" && entry.outcome === "ok") ||
        entry.action === "device.changed",
  );

  return (
    <div className={`${width} flex flex-col gap-8 [--history-width:520px]`}>
      <section aria-labelledby={headingId} className="flex flex-col gap-1">
        <h3
          id={headingId}
          className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)"
        >
          {isRemote ? "Last press" : "Last change"}
        </h3>
        <p className="m-0 text-2xl leading-8 font-light">
          {activity.state === "loading"
            ? " "
            : last
              ? lastChangeWords(last)
              : isRemote
                ? "Not pressed lately"
                : "Nothing changed it lately"}
        </p>
      </section>
      {activity.state === "loading" ? (
        <ActivitySkeleton />
      ) : activity.state === "failed" ? (
        <ActivityProblem
          what="Its activity didn't load"
          onRetry={activity.retry}
        />
      ) : (
        daysOf(entries).map((day) => (
          <section key={day.key} className="flex flex-col gap-2">
            <h3 className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)">
              {day.heading}
            </h3>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {day.entries.map((entry) => (
                <li key={entry.id}>
                  <ActivityRow
                    entry={entry}
                    context={{ ...context, where: "device" }}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <Button
        variant="outline"
        className="self-center"
        onClick={() => context.onShowAll(device.id)}
      >
        Show all in Activity
      </Button>
    </div>
  );
}
