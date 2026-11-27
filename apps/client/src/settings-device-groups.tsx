import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { useHomeClock } from "@meetsanctum/ui-sdk";
import { CircleAlert, Radio } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";

import { categoryLooks } from "./category-looks";
import { AreaGroup, AreaRow } from "./components";
import { firmwareStatus } from "./device-firmware";
import { deviceGroups, groupCounts, unknownGroup } from "./device-groups";
import { deviceStatus } from "./device-line";

// Settings → Devices' first page: a row for each category the home has
// devices in, with the sidebar's icon and colour, saying how many devices
// it has and, before that, how many need attention or have an update, so
// nothing that needs someone is hidden a level down. A row opens the
// category's page. Back from there puts the keyboard's focus on the row it
// came from, which is the only time this page moves focus.

let returningFrom: string | undefined;

/** Puts focus on a group's row when the list shows next, after Back. */
export function returnToGroup(id: string) {
  returningFrom = id;
}

export function DeviceGroupList(props: {
  devices: readonly DeviceInfo[];
  now: number;
  onOpen: (group: string) => void;
  focusFallback: RefObject<HTMLButtonElement | null>;
}) {
  const clock = useHomeClock();
  const { now, focusFallback } = props;
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const groups = deviceGroups(props.devices);

  useEffect(() => {
    const id = returningFrom;
    returningFrom = undefined;
    if (id) (rows.current.get(id) ?? focusFallback.current)?.focus();
  }, [focusFallback]);

  // Update blocking only changes the wording, which the counts don't show.
  const needsAttention = (device: DeviceInfo) =>
    deviceStatus(clock, device, firmwareStatus(device, [], undefined, now), now)
      ?.tone === "problem";

  if (groups.length === 0) {
    return (
      <p className="m-0 text-[13px] font-medium text-muted-foreground">
        No devices yet.
      </p>
    );
  }

  return (
    <AreaGroup>
      {groups.map((group) => {
        const counts = groupCounts(group.devices, needsAttention);
        const plain = [counts.updates, counts.count]
          .filter(Boolean)
          .join(" · ");
        const look =
          group.id === unknownGroup ? undefined : categoryLooks[group.id];
        return (
          <AreaRow
            key={group.id}
            ref={(button) => {
              if (button) rows.current.set(group.id, button);
              else rows.current.delete(group.id);
            }}
            icon={look?.icon ?? Radio}
            colour={look?.colour}
            title={group.title}
            detail={
              counts.attention ? (
                <span className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted-foreground">
                  <CircleAlert
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-destructive"
                  />
                  <span className="truncate">
                    <span className="text-destructive">{counts.attention}</span>
                    {` · ${plain}`}
                  </span>
                </span>
              ) : (
                plain
              )
            }
            spoken={[counts.attention, counts.updates, counts.count]
              .filter(Boolean)
              .join(", ")}
            onOpen={() => props.onOpen(group.id)}
          />
        );
      })}
    </AreaGroup>
  );
}
