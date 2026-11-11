import {
  maintenanceOf,
  onBattery,
  type AppInfo,
  type DeviceInfo,
  type Room,
} from "@meetsanctum/app-sdk";
import { Button, PageBar } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  Battery,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  EllipsisVertical,
  RefreshCw,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Row, Section } from "./components";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { coreJson } from "./core-fetch";
import {
  ago,
  firmwareProblem,
  firmwareStatus,
  updateButton,
  UpdateDialog,
  useMinuteClock,
  type Status,
} from "./device-firmware";
import { DeviceIcon, roomName } from "./device-parts";
import {
  batteryOrder,
  dueBatteries,
  lowBatteryText,
  maintenanceHint,
  quietText,
  updatesLine,
  updatesOf,
} from "./maintenance";
import { DeviceLine } from "./settings-devices";

// Maintenance: what the home's devices need from the household, the same on
// every client. Settings has a section of what's due, second after Needs
// attention: a device on a battery gone quiet and a low battery each a row,
// updates one row that opens the Maintenance page, a page of Settings with
// Done, which the dashboard's Batteries tile opens too. The page lists every
// device on a battery, the next to replace first, and every update, each
// with its button. A row shown here keeps its place until the page closes,
// saying how it was put right, so nothing moves under the pointer.

export const maintenanceSettingsPage = "maintenance";

// A charge that rises this much at once is a new battery, as the core
// reckons it for the activity log.
const newBatteryRise = 25;

/** Where a device is and what its driver calls it, after what leads its line. */
function whereLine(device: DeviceInfo, rooms: readonly Room[]) {
  return [
    roomName(rooms, device.roomId) ?? "No room",
    device.driverName !== device.name ? device.driverName : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// How a row was when its latest battery problem started.
type First = {
  need: ReturnType<typeof maintenanceOf>;
  battery: number | null;
  lastSeenAt: string | null;
};

/**
 * Rows in the order they were first shown, new ones after them, each with
 * how it was then: a row stays while the page is open, even once it is put
 * right, unless its device is removed.
 */
function useKept(
  shown: readonly DeviceInfo[],
  devices: readonly DeviceInfo[],
  now: number,
) {
  const kept = useRef(new Map<string, { first: First; need: First["need"] }>());
  for (const device of shown) {
    if (!kept.current.has(device.id)) {
      const need = maintenanceOf(device, now);
      kept.current.set(device.id, {
        first: { need, battery: device.battery, lastSeenAt: device.lastSeenAt },
        need,
      });
    }
  }
  return [...kept.current].flatMap(([id, row]) => {
    const device = devices.find((each) => each.id === id);
    if (!device) {
      kept.current.delete(id);
      return [];
    }
    const need = maintenanceOf(device, now);
    if (
      (need === "quiet" || need === "battery") &&
      row.need !== "quiet" &&
      row.need !== "battery"
    ) {
      row.first = {
        need,
        battery: device.battery,
        lastSeenAt: device.lastSeenAt,
      };
    }
    row.need = need;
    return [{ device, first: row.first }];
  });
}

/** What leads a battery's line: why it is to replace, how it was put right, or that its charge isn't known yet. */
function batteryStatus(
  device: DeviceInfo,
  first: First,
  now: number,
  // Whether its charge sits beside the line, so the line leaves it out.
  isBeside: boolean,
): Status | null {
  const need = maintenanceOf(device, now);
  if (need === "quiet")
    return { text: quietText(device, now), tone: "problem" };
  if (need === "battery") {
    return {
      text: lowBatteryText(isBeside ? undefined : device.battery!),
      tone: "problem",
    };
  }
  if (first.need === "quiet" || first.need === "battery") {
    if (
      device.battery !== null &&
      first.battery !== null &&
      device.battery - first.battery >= newBatteryRise
    ) {
      return { text: `New battery, up from ${first.battery}%`, tone: "done" };
    }
    if (
      first.need === "quiet" &&
      device.lastSeenAt !== null &&
      first.lastSeenAt !== null &&
      Date.parse(device.lastSeenAt) > Date.parse(first.lastSeenAt)
    ) {
      return {
        text: `Heard from ${ago(device.lastSeenAt, now)}`,
        tone: "done",
      };
    }
  }
  if (device.battery === null) {
    const kinds = new Set(device.capabilities.map((each) => each.kind));
    return {
      text: kinds.has("sensor")
        ? "Says its charge with its next reading"
        : kinds.has("button")
          ? "Says its charge when it's next pressed"
          : "Says its charge when it next reports",
      tone: "plain",
    };
  }
  return null;
}

/** What an update's row says once a check found none to start, while it stays. */
function upToDateStatus(device: DeviceInfo, now: number): Status | null {
  const { firmware } = device;
  if (firmware?.state !== "current") return null;
  return {
    text: firmware.checkedAt
      ? `Up to date, checked ${ago(firmware.checkedAt, now)}`
      : "Up to date",
    tone: "done",
  };
}

/** The charge at the end of a battery's row, with a glyph of how full it is. */
function Charge(props: { device: DeviceInfo; now: number }) {
  const { device } = props;
  const isQuiet = maintenanceOf(device, props.now) === "quiet";
  if (device.battery === null || isQuiet) {
    return (
      <span
        className="w-16 shrink-0 text-end text-[15px] font-medium text-muted-foreground tabular-nums"
        aria-label={
          device.battery === null
            ? "Charge not known yet"
            : `Last at ${device.battery}%`
        }
      >
        {device.battery === null ? "–" : `${device.battery}%`}
      </span>
    );
  }
  const isLow = maintenanceOf(device, props.now) === "battery";
  const Glyph = isLow
    ? BatteryWarning
    : device.battery < 50
      ? BatteryLow
      : device.battery < 80
        ? BatteryMedium
        : BatteryFull;
  return (
    <span
      className={cn(
        "flex w-16 shrink-0 items-center justify-end gap-1.5 text-[15px] font-medium tabular-nums",
        isLow && "text-destructive",
      )}
    >
      <Glyph
        aria-hidden="true"
        className={cn("size-5", !isLow && "text-muted-foreground")}
      />
      {device.battery}%
    </span>
  );
}

// A row that says there is nothing here, with a check or a glyph in a round.
function QuietRow(props: { icon: ReactNode; title: string; detail: string }) {
  return (
    <li className="flex items-center gap-3">
      {props.icon}
      <Row title={props.title} detail={props.detail} />
    </li>
  );
}

const doneRound = (
  <span
    aria-hidden="true"
    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
  >
    <Check className="size-4" strokeWidth={2.5} />
  </span>
);

const plainRound = (Icon: typeof Battery) => (
  <span
    aria-hidden="true"
    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
  >
    <Icon className="size-4" />
  </span>
);

/** What Settings' section says under "Nothing to do": what is fine, and firmware not checked yet. */
function nothingDue(
  hasBatteries: boolean,
  hasUpdates: boolean,
  hasUnchecked: boolean,
) {
  const words = [
    hasBatteries ? "no battery to replace" : null,
    hasUpdates
      ? hasUnchecked
        ? "not every device has been checked for updates yet"
        : "every device is up to date"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return words
    ? words.charAt(0).toUpperCase() + words.slice(1)
    : "Batteries to replace and firmware updates show here";
}

/** Settings' Maintenance section: what's due, with Show all for the page. */
export function MaintenanceSection(props: {
  devices: readonly DeviceInfo[];
  rooms: readonly Room[];
  onShowAll: () => void;
}) {
  const { devices, rooms } = props;
  const now = useMinuteClock();
  const batteries = useKept(dueBatteries(devices, now), devices, now);
  const updates = updatesOf(devices);
  if (devices.length === 0) return null;
  const hasBatteries = devices.some(onBattery);
  const hasUpdates = devices.some((device) => device.firmware?.updatable);
  const hasUnchecked = devices.some(
    (device) => device.firmware?.updatable && device.firmware.state === null,
  );
  return (
    <Section
      id="settings-maintenance"
      title="Maintenance"
      hint={maintenanceHint(devices, now)}
      action={
        <Button variant="outline" size="sm" onClick={props.onShowAll}>
          Show all
        </Button>
      }
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {batteries.map(({ device, first }) => {
          const status = batteryStatus(device, first, now, false);
          const isQuiet = maintenanceOf(device, now) === "quiet";
          return (
            <li key={device.id} className="flex items-center gap-3">
              <DeviceIcon device={device} />
              <DeviceLine
                device={device}
                status={status}
                detail={[
                  whereLine(device, rooms),
                  isQuiet && device.battery !== null
                    ? `last at ${device.battery}%`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            </li>
          );
        })}
        {updates.length > 0 && (
          <li>
            <Button
              variant="row"
              size="row"
              type="button"
              onClick={props.onShowAll}
              aria-label={`${updates.length === 1 ? "1 update" : `${updates.length} updates`}: ${updatesLine(updates)}. Opens Maintenance`}
              className="-mx-2.5 w-[calc(100%+20px)]"
            >
              {plainRound(RefreshCw)}
              <Row
                title={
                  updates.length === 1
                    ? "1 update"
                    : `${updates.length} updates`
                }
                detail={updatesLine(updates)}
              />
              <ChevronRight
                aria-hidden="true"
                className="ms-auto size-4 shrink-0 text-muted-foreground"
              />
            </Button>
          </li>
        )}
        {batteries.length === 0 && updates.length === 0 && (
          <QuietRow
            icon={doneRound}
            title="Nothing to do"
            detail={nothingDue(hasBatteries, hasUpdates, hasUnchecked)}
          />
        )}
      </ul>
    </Section>
  );
}

// An update under way or waiting stops from its menu, never where Update
// was.
function RunningMenu(props: { device: DeviceInfo; onStop: () => void }) {
  const { device } = props;
  const state = device.firmware?.state;
  if (state !== "updating" && state !== "waiting") return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${device.name}: more`}
          className="ms-auto"
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {device.firmware?.version && (
          <DropdownMenuLabel>
            Firmware {device.firmware.version}
          </DropdownMenuLabel>
        )}
        <DropdownMenuItem onSelect={props.onStop}>
          <CircleStop />
          {state === "waiting" ? "Cancel update" : "Stop update"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Maintenance page: every device on a battery, the next to replace
 * first, with its charge at the end, and every update, each with Update or
 * Try again, and Check for updates for the rest.
 */
export function MaintenancePage(props: {
  devices: readonly DeviceInfo[];
  rooms: readonly Room[];
  apps: readonly AppInfo[];
  onDone: () => void;
}) {
  const { devices, rooms } = props;
  const now = useMinuteClock();
  const batteries = useKept(batteryOrder(devices, now), devices, now);
  const pendingUpdates = updatesOf(devices);
  const updates = useKept(pendingUpdates, devices, now);
  // The device whose update someone is about to start.
  const [updating, setUpdating] = useState<DeviceInfo>();
  // Whether Check for updates is under way, and what it couldn't check.
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  // What a screen reader hears of an outcome.
  const [announcement, setAnnouncement] = useState("");

  const appName = (device: DeviceInfo) =>
    props.apps.find((app) => app.id === device.driver)?.name ?? null;
  const updatable = devices.filter((device) => device.firmware?.updatable);
  const current = updatable.filter(
    (device) => device.firmware?.state === "current",
  );
  const upToDate = current.length;
  const hasUnchecked = updatable.some(
    (device) => device.firmware?.state === null,
  );
  const checked = current
    .map((device) => device.firmware?.checkedAt)
    .filter((at): at is string => !!at)
    .sort();
  // The group was checked only as recently as its least recent member.
  const lastChecked =
    checked.length === current.length ? checked[0] : undefined;
  const updatesHint = [
    pendingUpdates.length > 0
      ? pendingUpdates.length === 1
        ? "1 update"
        : `${pendingUpdates.length} updates`
      : null,
    upToDate > 0
      ? `${upToDate === 1 ? "1 device" : `${upToDate} devices`} up to date${
          lastChecked && now - Date.parse(lastChecked) < 24 * 60 * 60_000
            ? `, checked ${ago(lastChecked, now)}`
            : ""
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Each device that can be asked, one after another; one that sleeps is
  // asked by its driver when it wakes.
  const checkAll = async () => {
    setChecking(true);
    setProblem(undefined);
    const asked = updatable.filter(
      (device) =>
        !device.firmware?.sleeps &&
        device.firmware?.state !== "updating" &&
        device.firmware?.state !== "waiting",
    );
    const failed: string[] = [];
    for (const device of asked) {
      try {
        await coreJson<DeviceInfo>("/api/devices/firmware/check", {
          method: "POST",
          json: { id: device.id },
        });
      } catch (error) {
        failed.push(
          `${device.name}: ${firmwareProblem(error, "check", appName(device))}`,
        );
      }
    }
    setChecking(false);
    setProblem(failed.length > 0 ? failed.join(" ") : undefined);
    setAnnouncement(
      failed.length > 0 ? failed.join(" ") : "Checked for updates.",
    );
  };

  const stop = async (device: DeviceInfo) => {
    try {
      await coreJson<DeviceInfo>("/api/devices/firmware/stop", {
        method: "POST",
        json: { id: device.id },
      });
      setAnnouncement(`${device.name}'s update is stopped.`);
    } catch (error) {
      const text = firmwareProblem(error, "stop", appName(device));
      setProblem(`${device.name}: ${text}`);
      setAnnouncement(text);
    }
  };

  return (
    <>
      <PageBar title="Maintenance">
        <Button variant="outline" onClick={props.onDone}>
          Done
        </Button>
      </PageBar>
      <Section
        id="maintenance-batteries"
        title="Batteries"
        hint={
          batteries.length > 0
            ? `${batteries.length === 1 ? "1 device" : `${batteries.length} devices`} · lowest first`
            : undefined
        }
      >
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {batteries.length === 0 && (
            <QuietRow
              icon={plainRound(Battery)}
              title="No devices on batteries yet"
              detail="Remotes and sensors show their charge here once they join"
            />
          )}
          {batteries.map(({ device, first }) => (
            <li key={device.id} className="flex items-center gap-3">
              <DeviceIcon device={device} />
              <DeviceLine
                device={device}
                status={batteryStatus(device, first, now, true)}
                detail={whereLine(device, rooms)}
              />
              <Charge device={device} now={now} />
            </li>
          ))}
        </ul>
      </Section>
      {updatable.length > 0 && (
        <Section
          id="maintenance-updates"
          title="Updates"
          hint={updatesHint || undefined}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={checking}
              onClick={() => void checkAll()}
            >
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          }
        >
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {updates.length === 0 && (
              <QuietRow
                // No check while one isn't known to be up to date.
                icon={hasUnchecked ? plainRound(RefreshCw) : doneRound}
                title={
                  hasUnchecked ? "Not checked yet" : "Everything's up to date"
                }
                detail={
                  hasUnchecked
                    ? "Check for updates to see whether new firmware is offered"
                    : "New firmware shows here when a device's maker offers it"
                }
              />
            )}
            {updates.map(({ device }) => {
              const button = updateButton(device, devices);
              return (
                <li key={device.id} className="flex items-center gap-3">
                  <DeviceIcon device={device} />
                  <DeviceLine
                    device={device}
                    status={
                      firmwareStatus(device, devices, undefined, now) ??
                      upToDateStatus(device, now)
                    }
                    detail={whereLine(device, rooms)}
                  />
                  {button && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ms-auto shrink-0"
                      disabled={button.disabled}
                      onClick={() => setUpdating(device)}
                    >
                      {button.label}
                    </Button>
                  )}
                  <RunningMenu
                    device={device}
                    onStop={() => void stop(device)}
                  />
                </li>
              );
            })}
            {problem && (
              <li
                role="alert"
                className="flex items-center gap-1 text-[13px] font-medium text-destructive"
              >
                <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                {problem}
              </li>
            )}
          </ul>
        </Section>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <UpdateDialog
        device={updating}
        appName={updating ? appName(updating) : null}
        onClose={() => setUpdating(undefined)}
        onUpdate={async (device) => {
          await coreJson<DeviceInfo>("/api/devices/firmware/update", {
            method: "POST",
            json: { id: device.id },
          });
          setAnnouncement(`${device.name}'s update is on its way.`);
        }}
      />
    </>
  );
}
