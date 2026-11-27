import {
  lowBattery,
  lowCharge,
  maintenanceOf,
  type DeviceInfo,
  type Places,
} from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import { pressLabel } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";

import { attentionText } from "./attention";
import { Progress } from "./components/ui/progress";
import type { Status } from "./device-firmware";
import { roomName } from "./device-parts";
import { lowBatteryText, quietText } from "./maintenance";

// A device's line, as Settings → Devices, Maintenance and Needs attention
// draw it: its name over its room and the rest, led by what is going on
// with it.

// How long a press stays on a remote's line.
export const pressShownMs = 4_000;

export function deviceDetail(
  device: DeviceInfo,
  rooms: Places["rooms"],
  // The action it was pressed with just now, if any.
  pressed?: string,
): string {
  return [
    roomName(rooms, device.roomId) ?? "No room",
    device.driverName !== device.name ? device.driverName : null,
    device.battery !== null && device.battery >= lowBattery
      ? `Battery ${device.battery}%`
      : null,
    // One that left its network says so first instead.
    device.availability === "offline" && device.leftAt === null
      ? "Offline"
      : null,
    pressed ? `${pressLabel(pressed)} just now` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What leads a device's line: that its network no longer has it or what its
 * driver says is wrong with it, its firmware's or a check's news, or else
 * that it went quiet or its battery is low.
 */
export function deviceStatus(
  clock: HomeClock,
  device: DeviceInfo,
  firmware: Status | null,
  now: number,
): Status | null {
  if (device.leftAt !== null) {
    return { text: attentionText("left", device), tone: "problem" };
  }
  if (device.problem) {
    return { text: attentionText("problem", device), tone: "problem" };
  }
  if (firmware) return firmware;
  const need = maintenanceOf(device, now);
  if (need === "quiet")
    return { text: quietText(clock, device, now), tone: "problem" };
  if (need === "battery") {
    return { text: lowBatteryText(lowCharge(device)), tone: "problem" };
  }
  return null;
}

// A device's name, and its line: what is going on with its firmware or a
// check first, in red with a sign when something went wrong, then its room
// and the rest, with an update's progress under it. Maintenance's rows
// are drawn the same.
export function DeviceLine(props: {
  device: DeviceInfo;
  status: Status | null;
  detail: string;
}) {
  const { status } = props;
  const Icon =
    status?.tone === "busy"
      ? LoaderCircle
      : status?.tone === "problem"
        ? CircleAlert
        : status?.tone === "done"
          ? Check
          : null;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
      <span className="truncate text-sm font-medium">{props.device.name}</span>
      <span className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted-foreground">
        {Icon && (
          <Icon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0",
              status?.tone === "busy" && "animate-spin",
              status?.tone === "problem" && "text-destructive",
            )}
          />
        )}
        <span className="truncate">
          {status && (
            <span
              className={cn(status.tone === "problem" && "text-destructive")}
            >
              {status.text}
            </span>
          )}
          {status?.then && ` · ${status.then}`}
          {status && " · "}
          {props.detail}
        </span>
      </span>
      {status?.progress !== undefined && (
        <Progress
          value={status.progress}
          aria-label={`${props.device.name}'s update`}
          className="mt-1.5 max-w-105"
        />
      )}
    </span>
  );
}
