import type {
  AppInfo,
  AttentionReason,
  DeviceInfo,
  ProbeResult,
  Room,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { CircleAlert } from "lucide-react";
import { useState } from "react";

import { AppIcon } from "./app-icon";
import { plainIcon } from "./app-settings";
import { isGivenUp, RestartButton } from "./app-state";
import {
  appAttentionText,
  appsNotRunning,
  attentionDetail,
  attentionText,
  isProblem,
  needingAttention,
  rankOf,
} from "./attention";
import { productName } from "./brand";
import { Section } from "./components";
import { coreJson } from "./core-fetch";
import {
  answeredIn,
  firmwareProblem,
  noAnswer,
  type CheckResult,
  type Status,
} from "./device-firmware";
import {
  DeviceIcon,
  deviceProblem,
  roomName,
  RoomPicker,
  updateDevice,
} from "./device-parts";
import { DeviceLine, EditDevice, type Editing } from "./settings-devices";
import { SanctumAttentionRow } from "./settings-status";
import type { SystemStatus } from "./system-status";

// Settings' Needs attention: first on the page while Sanctum itself, any app
// or any device needs someone. Sanctum leads, with its first problem, and
// opens Status, where each says what to do. Each app that isn't running
// follows: a paused one opens its settings, where the permission it needs
// is, and one that stopped opens Status, where Restart is. Each device has
// its fix in its row: Remove for one its network no longer has, Check
// connection for one that is offline, a room for one in none. The same on
// every client, a shared one too. A row fixed from here stays, with a check
// and what was done, until Settings closes, so every fix is answered where
// it was asked; one that clears by itself, as a light switched back on at
// the wall, just goes. Nothing is dismissed: every row clears itself.
// Upkeep, such as a battery to replace, is not among them.

// A row's fix: the first of its reasons that has one.
type Fix = "remove" | "probe" | "room";

function fixOf(
  device: DeviceInfo,
  reasons: readonly AttentionReason[],
): Fix | null {
  for (const reason of reasons) {
    if (reason === "left") return "remove";
    if (reason === "offline" && device.probe) return "probe";
    if (reason === "room") return "room";
  }
  return null;
}

// What a fix from here did, shown with a check once nothing else is left.
type Done = { text: string; reason: AttentionReason };

type Position = { reason: AttentionReason; name: string };

type Row = {
  device: DeviceInfo;
  reasons: AttentionReason[];
  done?: Done;
};

const plural = (count: number) => `${count} device${count === 1 ? "" : "s"}`;

// "Sanctum, Moods and 2 devices", "Sanctum", "2 apps", "2 devices".
function hintOf(sanctum: boolean, apps: readonly AppInfo[], devices: number) {
  const parts = [
    ...(sanctum ? [productName] : []),
    ...(apps.length === 1
      ? [apps[0]!.name]
      : apps.length > 1
        ? [`${apps.length} apps`]
        : []),
    ...(devices > 0 ? [plural(devices)] : []),
  ];
  if (parts.length <= 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// A row: its icon, its words and its fix, which a phone puts under them.
const rowLayout =
  "grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 max-[520px]:grid-cols-[32px_minmax(0,1fr)] max-[520px]:items-start";
const fixPlace =
  "flex justify-end max-[520px]:col-start-2 max-[520px]:mt-2 max-[520px]:justify-start";

function RowButton(props: {
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <span className={fixPlace}>
      <Button
        variant="outline"
        size="sm"
        aria-label={props.label}
        onClick={props.onClick}
      >
        {props.children}
      </Button>
    </span>
  );
}

// An app's name over what is wrong: in red with a sign for one that
// stopped, plain for one paused.
function AppLine(props: { app: AppInfo }) {
  const stopped = isGivenUp(props.app);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
      <span className="truncate text-sm font-medium">{props.app.name}</span>
      <span
        className={`flex min-w-0 items-center gap-1 text-[13px] font-medium ${
          stopped ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {stopped && (
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{appAttentionText(props.app)}</span>
      </span>
    </span>
  );
}

export function NeedsAttentionSection(props: {
  devices: readonly DeviceInfo[];
  rooms: readonly Room[];
  apps: AppInfo[];
  // The host's status: Sanctum leads while it has a problem.
  status?: SystemStatus;
  onOpenStatus?: () => void;
  /** Opens an app's settings, for one that is paused. */
  onOpenApp?: (id: string) => void;
}) {
  const [done, setDone] = useState<Record<string, Done>>({});
  // A fix can change both the leading reason and the device's automatic
  // name. Keep its original sort position while it runs and afterwards.
  const [positions, setPositions] = useState<Record<string, Position>>({});
  // What Check connection found for each device, until the next check.
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  // A room being saved, by device.
  const [moving, setMoving] = useState<Record<string, boolean>>({});
  // The device someone is about to remove, as the dialog takes it.
  const [removing, setRemoving] = useState<Editing>();
  const [announcement, setAnnouncement] = useState("");

  const needing = needingAttention(props.devices, props.rooms, props.apps);
  // Keep an in-flight fix too: the live update can precede its response.
  const rows: Row[] = [
    ...needing.map((each) => ({ ...each, done: done[each.device.id] })),
    ...props.devices
      .filter(
        (device) =>
          (done[device.id] ||
            moving[device.id] ||
            results[device.id]?.kind === "probing") &&
          !needing.some((each) => each.device.id === device.id),
      )
      .map((device) => ({ device, reasons: [], done: done[device.id] })),
  ];
  const positionOf = (row: Row): Position =>
    positions[row.device.id] ?? {
      reason: row.reasons[0]!,
      name: row.device.name,
    };
  rows.sort((a, b) => {
    const first = positionOf(a);
    const second = positionOf(b);
    return (
      rankOf(first.reason) - rankOf(second.reason) ||
      first.name.localeCompare(second.name)
    );
  });
  const sanctum =
    props.status && props.status.problems.length > 0 && props.onOpenStatus
      ? props.status
      : null;
  const apps = appsNotRunning(props.apps);
  if (rows.length === 0 && !sanctum && apps.length === 0) {
    // The last row's outcome is still heard once the section has gone.
    return announcement ? (
      <p role="status" className="sr-only">
        {announcement}
      </p>
    ) : null;
  }

  const appName = (device: DeviceInfo) =>
    props.apps.find((app) => app.id === device.driver)?.name ?? null;
  const found = (id: string, result?: CheckResult) =>
    setResults(({ [id]: _, ...rest }) =>
      result ? { ...rest, [id]: result } : rest,
    );

  const keepPosition = (device: DeviceInfo) => {
    const row = needing.find((each) => each.device.id === device.id)!;
    setPositions((current) => ({
      ...current,
      [device.id]: current[device.id] ?? {
        reason: row.reasons[0]!,
        name: device.name,
      },
    }));
  };

  const probe = async (device: DeviceInfo) => {
    keepPosition(device);
    found(device.id, { kind: "probing" });
    try {
      const { answeredInMs } = await coreJson<ProbeResult>(
        "/api/devices/probe",
        { method: "POST", json: { id: device.id } },
      );
      if (answeredInMs === null) {
        found(device.id, { kind: "probed", answeredInMs });
        setAnnouncement(`${device.name} didn't answer.`);
        return;
      }
      found(device.id);
      setDone((current) => ({
        ...current,
        [device.id]: {
          text: `Connected, answered in ${answeredIn(answeredInMs)}`,
          reason: "offline",
        },
      }));
      setAnnouncement(`${device.name} is connected.`);
    } catch (error) {
      const text = firmwareProblem(error, "probe", appName(device));
      found(device.id, { kind: "problem", text });
      setAnnouncement(text);
    }
  };

  const move = async (device: DeviceInfo, roomId: string | null) => {
    if (!roomId) return;
    keepPosition(device);
    setMoving((current) => ({ ...current, [device.id]: true }));
    found(device.id);
    try {
      // The core may rename a device after its room, so the note says the
      // name it has now.
      const moved = await updateDevice(device.id, { roomId });
      const room = roomName(props.rooms, roomId) ?? "another room";
      setDone((current) => ({
        ...current,
        [device.id]: { text: `Moved to ${room}`, reason: "room" },
      }));
      setAnnouncement(`${moved.name} is in ${room} now.`);
    } catch (error) {
      const text = deviceProblem(error);
      found(device.id, { kind: "problem", text });
      setAnnouncement(text);
    } finally {
      setMoving(({ [device.id]: _, ...rest }) => rest);
    }
  };

  // Whether what a fix from here did leads its row: once the device no
  // longer has the reason it fixed, unless a problem remains, which leads
  // instead, the room it was moved to on its line. One that comes back,
  // as a light that goes offline again, leads again.
  const answers = (row: Row) =>
    row.done !== undefined &&
    !row.reasons.includes(row.done.reason) &&
    !row.reasons.some(isProblem);

  // What leads a row's line: a check under way or what it found, what a fix
  // from here did, or its most pressing reason.
  const statusOf = (row: Row): Status => {
    const result = results[row.device.id];
    if (result?.kind === "probing") {
      return { text: "Checking connection…", tone: "busy" };
    }
    if (moving[row.device.id]) {
      return { text: "Saving room…", tone: "busy" };
    }
    if (result?.kind === "problem") {
      return { text: result.text, tone: "problem" };
    }
    if (answers(row)) return { text: row.done!.text, tone: "done" };
    const lead = row.reasons[0]!;
    if (lead === "offline" && result?.kind === "probed") {
      return { text: noAnswer, tone: "problem" };
    }
    return {
      text: attentionText(lead),
      tone: isProblem(lead) ? "problem" : "plain",
    };
  };

  const needed = rows.filter((row) => row.reasons.length > 0).length;
  return (
    <Section
      id="settings-attention"
      title="Needs attention"
      hint={hintOf(!!sanctum, apps, needed)}
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {sanctum && (
          <li>
            <SanctumAttentionRow
              status={sanctum}
              onOpen={props.onOpenStatus!}
            />
          </li>
        )}
        {apps.map((app) => (
          <li key={app.id} className={rowLayout}>
            <AppIcon
              icon={app.icon ?? plainIcon}
              className="size-8 [&_svg]:size-4"
            />
            <AppLine app={app} />
            {app.state === "failed" ? (
              <span className={fixPlace}>
                <RestartButton app={app} variant="outline" size="sm" />
              </span>
            ) : app.state === "stopped" ? (
              props.onOpenStatus && (
                <RowButton
                  label={`Open Status, to restart ${productName}`}
                  onClick={props.onOpenStatus}
                >
                  Open Status
                </RowButton>
              )
            ) : (
              props.onOpenApp && (
                <RowButton
                  label={`Open ${app.name} settings`}
                  onClick={() => props.onOpenApp!(app.id)}
                >
                  Open settings
                </RowButton>
              )
            )}
          </li>
        ))}
        {rows.map((row) => {
          const { device } = row;
          const fix = fixOf(device, row.reasons);
          const result = results[device.id];
          return (
            <li key={device.id} className={rowLayout}>
              <DeviceIcon device={device} />
              <DeviceLine
                device={device}
                status={statusOf(row)}
                detail={attentionDetail(
                  device,
                  answers(row) ? row.reasons : row.reasons.slice(1),
                  // A device moved from here says where already.
                  answers(row) && row.done!.reason === "room"
                    ? []
                    : props.rooms,
                )}
              />
              {fix && (
                <span className={fixPlace}>
                  {fix === "remove" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Remove ${device.name}`}
                      onClick={() => setRemoving({ action: "remove", device })}
                    >
                      Remove
                    </Button>
                  ) : fix === "probe" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Check ${device.name}'s connection`}
                      disabled={result?.kind === "probing"}
                      onClick={() => void probe(device)}
                    >
                      {result?.kind === "probed"
                        ? "Check again"
                        : "Check connection"}
                    </Button>
                  ) : (
                    <RoomPicker
                      device={device}
                      rooms={props.rooms}
                      unset="Choose a room"
                      disabled={moving[device.id]}
                      onChange={(roomId) => void move(device, roomId)}
                    />
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {/* The shell's devices follow the removal live. */}
      <EditDevice
        editing={removing}
        appName={removing ? appName(removing.device) : null}
        onClose={() => setRemoving(undefined)}
        onChanged={() => undefined}
        onRemoved={() => {
          if (removing) setAnnouncement(`${removing.device.name} is removed.`);
          // Its row may have been the last, so nothing waits to reopen.
          setRemoving(undefined);
        }}
        onForgotten={() => undefined}
      />
    </Section>
  );
}
