import {
  historyFields,
  lowBattery,
  maintenanceOf,
  type AppInfo,
  type CapabilityInfo,
  type DeviceInfo,
  type FirmwareState,
  type HistoryKept,
  type OccupancyCommand,
  type Places,
  type ProbeResult,
} from "@meetsanctum/app-sdk";
import { Button, Input, pressLabel, type LiveFeed } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AddDevices } from "./add-devices";
import { attentionText } from "./attention";
import { productName } from "./brand";
import { RepairDevice } from "./repair-device";
import { Section } from "./components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Progress } from "./components/ui/progress";
import { coreDevice, coreDevices } from "./core-devices";
import { CoreError, coreJson } from "./core-fetch";
import type { OnHome } from "./dashboards";
import {
  firmwareProblem,
  firmwareStatus,
  updateButton,
  UpdateDialog,
  updatesHint,
  useMinuteClock,
  type CheckResult,
  type Status,
} from "./device-firmware";
import { DeviceMenu, type EditAction } from "./device-menu";
import { lowBatteryText, quietText } from "./maintenance";
import {
  DeviceIcon,
  deviceProblem,
  roomName,
  updateDevice,
} from "./device-parts";
import { MotionSettings } from "./motion-settings";

// Settings → Devices, where the household manages its hardware: every device
// with its room, for every client, a shared one too, to add devices, rename
// them, move them between rooms, choose whether its history is kept, which
// deletes it when not, and remove them. A device that joined again or whose
// driver cannot take it off its network can still be removed by force. A
// remote's press shows on its line for a few seconds, so pressing it shows
// that Sanctum hears it. A motion sensor's settings are changed from its
// menu, each sent at once (motion-settings.tsx). Every client checks for
// firmware updates, starts and stops them and checks a device's connection,
// and its line says how that goes (device-firmware.tsx). A device on a
// battery says its charge on its line; one gone quiet or low leads it, in
// red with a sign, unless an update or a check has something to say, as
// Maintenance says it (maintenance.ts).

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
    return { text: quietText(device, now), tone: "problem" };
  if (need === "battery") {
    return { text: lowBatteryText(device.battery!), tone: "problem" };
  }
  return null;
}

const byName = (a: DeviceInfo, b: DeviceInfo) => a.name.localeCompare(b.name);

export type Editing = {
  action: EditAction;
  device: DeviceInfo;
};

export function DevicesSection(props: {
  apps: AppInfo[];
  live: LiveFeed;
  // What is on Home, which a device's menu changes.
  home: OnHome;
  // Opens with Add devices, as the dashboard's setup does.
  adding?: boolean;
}) {
  const [devices, setDevices] = useState<DeviceInfo[]>();
  const [rooms, setRooms] = useState<Places["rooms"]>([]);
  // Whether each device with a history keeps it.
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Editing>();
  // The device someone is repairing.
  const [repairing, setRepairing] = useState<DeviceInfo>();
  const [adding, setAdding] = useState(props.adding ?? false);
  // The device whose update someone is about to start.
  const [updating, setUpdating] = useState<DeviceInfo>();
  // The motion sensor whose settings are open, by its id, so the dialog
  // follows it live.
  const [tuning, setTuning] = useState<string>();
  // What each check run from here found, by device, until the next one.
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  // What a screen reader hears of an outcome: a check's, or an update's
  // that ended (never each percent).
  const [announcement, setAnnouncement] = useState("");
  // Live device messages received during a request take precedence over its response.
  const liveDevices = useRef(new Map<string, DeviceInfo | null>());
  const now = useMinuteClock();
  // Each remote's press of the last few seconds, by device.
  const [pressed, setPressed] = useState<Record<string, string>>({});
  const pressTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // What changed while a refresh was on its way is newer than its answer,
  // so it is applied on top of it, as Settings → Rooms does.
  type Update = (current: DeviceInfo[]) => DeviceInfo[];
  type Pending = {
    updates: Update[];
    rooms?: Places["rooms"];
    kept: Record<string, boolean>;
  };
  const pending = useRef<Pending>(undefined);
  const update = useCallback((change: Update) => {
    pending.current?.updates.push(change);
    setDevices((current) => change(current ?? []));
  }, []);
  const keepChanged = useCallback((device: string, value: boolean) => {
    if (pending.current) pending.current.kept[device] = value;
    setKept((current) => ({ ...current, [device]: value }));
  }, []);

  const refresh = useCallback(async () => {
    const request: Pending = { updates: [], kept: {} };
    pending.current = request;
    try {
      const [nextDevices, places, histories] = await Promise.all([
        coreDevices(),
        coreJson<Places>("/api/places"),
        // Without them, the menus leave the choice out.
        coreJson<HistoryKept[]>("/api/history/devices").catch(() => []),
      ]);
      if (pending.current !== request) return;
      setKept({
        ...Object.fromEntries(
          histories.map((each) => [each.device, each.kept]),
        ),
        ...request.kept,
      });
      setDevices(
        request.updates.reduce(
          (current, change) => change(current),
          [...nextDevices],
        ),
      );
      setRooms(request.rooms ?? places.rooms);
    } finally {
      if (pending.current === request) pending.current = undefined;
    }
  }, []);

  // A device can arrive over the live feed after the initial read. Fetch
  // its recording choice before offering it in the menu.
  useEffect(() => {
    if (
      !devices?.some(
        (device) =>
          kept[device.id] === undefined &&
          device.capabilities.some(
            (capability) => historyFields[capability.kind].length > 0,
          ),
      )
    )
      return;
    let current = true;
    void coreJson<HistoryKept[]>("/api/history/devices")
      .then((histories) => {
        if (!current) return;
        // A choice already made here is newer than this read.
        setKept((known) => {
          const added = histories.filter(
            (each) => known[each.device] === undefined,
          );
          if (added.length === 0) return known;
          return {
            ...known,
            ...Object.fromEntries(
              added.map((each) => [each.device, each.kept]),
            ),
          };
        });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [devices, kept]);

  const changed = useCallback(
    (device: DeviceInfo) =>
      update((current) =>
        [...current.filter((each) => each.id !== device.id), device].sort(
          byName,
        ),
      ),
    [update],
  );

  useEffect(() => {
    const timers = pressTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    return props.live.subscribe({
      message(message) {
        if (message.type === "press") {
          const { device, action } = message;
          setPressed((current) => ({ ...current, [device]: action }));
          clearTimeout(pressTimers.current.get(device));
          pressTimers.current.set(
            device,
            setTimeout(() => {
              pressTimers.current.delete(device);
              setPressed(({ [device]: _, ...rest }) => rest);
            }, pressShownMs),
          );
        } else if (message.type === "places") {
          if (pending.current) pending.current.rooms = message.places.rooms;
          setRooms(message.places.rooms);
        } else if (message.type === "device") {
          liveDevices.current.set(message.id, message.device);
          update((current) => {
            const others = current.filter((each) => each.id !== message.id);
            return message.device
              ? [...others, message.device].sort(byName)
              : others;
          });
        }
      },
      refresh: () => void refresh().catch(() => undefined),
    });
  }, [refresh, update, props.live]);

  const appName = (device: DeviceInfo) =>
    props.apps.find((app) => app.id === device.driver)?.name ?? null;

  const found = (id: string, result?: CheckResult) =>
    setResults(({ [id]: _, ...rest }) =>
      result ? { ...rest, [id]: result } : rest,
    );

  // An update that ended while this page was open is announced, and how
  // it ended takes the place of what a check found before.
  const firmwareStates = useRef(new Map<string, FirmwareState | null>());
  useEffect(() => {
    for (const device of devices ?? []) {
      const was = firmwareStates.current.get(device.id);
      const state = device.firmware?.state ?? null;
      firmwareStates.current.set(device.id, state);
      if (
        (was !== "updating" && was !== "waiting") ||
        state === "updating" ||
        state === "waiting"
      )
        continue;
      setResults(({ [device.id]: _, ...rest }) => rest);
      if (state === "current") {
        setAnnouncement(`${device.name} is updated.`);
      } else if (state === "failed") {
        setAnnouncement(`${device.name}'s update didn't finish.`);
      }
    }
  }, [devices]);

  const requestFirmware = async (
    device: DeviceInfo,
    hook: "check" | "update" | "stop",
  ) => {
    const before = liveDevices.current.get(device.id);
    const response = await coreDevice(`/api/devices/firmware/${hook}`, {
      method: "POST",
      json: { id: device.id },
    });
    const latest = liveDevices.current.get(device.id);
    if (latest === before) {
      changed(response);
      return response;
    }
    return latest ?? null;
  };

  // A motion sensor's setting, sent as the tiles send theirs: the answer
  // shows it pending, unless the device has changed live since, which is
  // newer.
  const commandAttempts = useRef(new Map<string, symbol>());
  const command = async (
    device: DeviceInfo,
    capability: string,
    asked: OccupancyCommand,
  ) => {
    const key = `${device.id}/${capability}`;
    const attempt = Symbol();
    commandAttempts.current.set(key, attempt);
    const before = liveDevices.current.get(device.id);
    try {
      const answer = await coreJson<CapabilityInfo>("/api/devices/command", {
        method: "POST",
        json: { device: device.id, capability, command: asked },
      });
      if (
        commandAttempts.current.get(key) !== attempt ||
        liveDevices.current.get(device.id) !== before
      )
        return;
      update((current) =>
        current.map((each) =>
          each.id === device.id
            ? {
                ...each,
                capabilities: each.capabilities.map((other) =>
                  other.id === answer.id ? answer : other,
                ),
              }
            : each,
        ),
      );
    } finally {
      if (commandAttempts.current.get(key) === attempt) {
        commandAttempts.current.delete(key);
      }
    }
  };

  const check = async (device: DeviceInfo) => {
    found(device.id, { kind: "checking" });
    try {
      const checked = await requestFirmware(device, "check");
      if (!checked) {
        found(device.id);
        return;
      }
      found(device.id, { kind: "checked" });
      setAnnouncement(
        checked.firmware?.state === "available" ||
          checked.firmware?.state === "failed"
          ? `An update is available for ${device.name}.`
          : `${device.name} is up to date.`,
      );
    } catch (error) {
      const text = firmwareProblem(error, "check", appName(device));
      found(device.id, { kind: "problem", text });
      setAnnouncement(text);
    }
  };

  const probe = async (device: DeviceInfo) => {
    found(device.id, { kind: "probing" });
    try {
      const { answeredInMs } = await coreJson<ProbeResult>(
        "/api/devices/probe",
        { method: "POST", json: { id: device.id } },
      );
      found(device.id, { kind: "probed", answeredInMs });
      setAnnouncement(
        answeredInMs === null
          ? `${device.name} didn't answer.`
          : `${device.name} is connected.`,
      );
    } catch (error) {
      const text = firmwareProblem(error, "probe", appName(device));
      found(device.id, { kind: "problem", text });
      setAnnouncement(text);
    }
  };

  const stop = async (device: DeviceInfo) => {
    found(device.id);
    try {
      await requestFirmware(device, "stop");
      setAnnouncement(`${device.name}'s update is stopped.`);
    } catch (error) {
      const text = firmwareProblem(error, "stop", appName(device));
      found(device.id, { kind: "problem", text });
      setAnnouncement(text);
    }
  };

  const tuned = devices?.find((each) => each.id === tuning);

  return (
    <Section
      id="settings-devices"
      title="Devices"
      hint={devices && updatesHint(devices)}
      action={
        <Button size="sm" onClick={() => setAdding(true)}>
          Add devices
        </Button>
      }
    >
      {devices &&
        (devices.length === 0 ? (
          <p className="m-0 text-[13px] font-medium text-muted-foreground">
            No devices yet.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {devices.map((device) => {
              const button = updateButton(device, devices);
              const hasHistory = device.capabilities.some(
                (capability) => historyFields[capability.kind].length > 0,
              );
              return (
                <li key={device.id} className="flex items-center gap-3">
                  <DeviceIcon device={device} />
                  <DeviceLine
                    device={device}
                    status={deviceStatus(
                      device,
                      firmwareStatus(device, devices, results[device.id], now),
                      now,
                    )}
                    detail={deviceDetail(device, rooms, pressed[device.id])}
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
                  <DeviceMenu
                    device={device}
                    rooms={rooms}
                    result={results[device.id]}
                    kept={hasHistory ? kept[device.id] : undefined}
                    home={
                      props.home.devices && {
                        name: props.home.name,
                        on: props.home.devices.includes(device.id),
                      }
                    }
                    onHome={(on) =>
                      void (
                        on
                          ? props.home.add(device.id)
                          : props.home.remove(device.id)
                      ).catch(() => undefined)
                    }
                    onKeep={() =>
                      void keepHistory(device.id, true)
                        .then(() => keepChanged(device.id, true))
                        .catch(() => undefined)
                    }
                    onEdit={(action) => setEditing({ action, device })}
                    onRoom={(roomId) =>
                      void updateDevice(device.id, { roomId })
                        .then(changed)
                        .catch(() => undefined)
                    }
                    onMotion={() => setTuning(device.id)}
                    onCheck={() => void check(device)}
                    onProbe={() => void probe(device)}
                    onStop={() => void stop(device)}
                    onRepair={() => setRepairing(device)}
                  />
                </li>
              );
            })}
          </ul>
        ))}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <UpdateDialog
        device={updating}
        appName={updating ? appName(updating) : null}
        onClose={() => setUpdating(undefined)}
        // The newest action leads the line, not an earlier check.
        onUpdate={async (device) => {
          await requestFirmware(device, "update");
          found(device.id);
        }}
      />
      <MotionSettings
        device={tuned}
        appName={tuned ? appName(tuned) : null}
        onClose={() => setTuning(undefined)}
        onCommand={command}
      />
      <RepairDevice
        device={repairing}
        appName={repairing ? appName(repairing) : null}
        onClose={() => setRepairing(undefined)}
        // The device's live updates bring its state, which a reply that
        // arrives later must not undo.
        onRepaired={(device) => setAnnouncement(`${device.name} is repaired.`)}
      />
      <EditDevice
        editing={editing}
        appName={editing ? appName(editing.device) : null}
        onClose={() => setEditing(undefined)}
        onChanged={changed}
        onRemoved={(id) =>
          update((current) => current.filter((each) => each.id !== id))
        }
        onForgotten={(id) => keepChanged(id, false)}
      />
      <AddDevices
        open={adding}
        onOpenChange={setAdding}
        devices={devices ?? []}
        rooms={rooms}
        live={props.live}
        onChanged={changed}
      />
    </Section>
  );
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

function keepHistory(device: string, kept: boolean) {
  return coreJson<HistoryKept>("/api/history/keep", {
    method: "POST",
    json: { device, kept },
  });
}

// Renaming a device, no longer keeping its history or removing it, after
// saying what that does. When its driver cannot take it off its network, as
// when the device does not answer, the dialog offers to remove it anyway.
// One its network no longer has is only forgotten.
export function EditDevice(props: {
  editing?: Editing;
  appName: string | null;
  onClose: () => void;
  onChanged: (device: DeviceInfo) => void;
  onRemoved: (id: string) => void;
  onForgotten: (id: string) => void;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<Editing>(undefined);
  const current = useRef(props.editing);
  current.current = props.editing;
  useEffect(
    () => () => {
      current.current = undefined;
    },
    [],
  );
  if (props.editing) last.current = props.editing;
  const editing = last.current;
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  // Why removing it needs force, once a removal could not take it off.
  const [stuck, setStuck] = useState<"unanswered" | "unavailable">();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setName(props.editing?.device.name ?? "");
    setProblem(undefined);
    setStuck(undefined);
    setWorking(false);
  }, [props.editing]);

  const device = editing?.device;
  const network = props.appName
    ? `the ${props.appName} network`
    : "its network";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !device) return;
    setWorking(true);
    setProblem(undefined);
    try {
      if (editing.action === "rename") {
        props.onChanged(
          await updateDevice(device.id, { name: name.trim() || null }),
        );
      } else if (editing.action === "forget") {
        await keepHistory(device.id, false);
        props.onForgotten(device.id);
      } else {
        await coreJson("/api/devices/remove", {
          method: "POST",
          json: { id: device.id, force: stuck !== undefined },
        });
        props.onRemoved(device.id);
      }
      if (current.current === editing) props.onClose();
    } catch (error) {
      if (current.current !== editing) return;
      setWorking(false);
      if (
        editing.action === "remove" &&
        !stuck &&
        error instanceof CoreError &&
        error.status >= 500
      ) {
        setStuck(error.code === "unavailable" ? "unavailable" : "unanswered");
        return;
      }
      setProblem(deviceProblem(error));
    }
  };

  const title =
    editing?.action === "rename"
      ? "Rename this device"
      : editing?.action === "forget"
        ? `Stop keeping ${device?.name}'s history?`
        : stuck === "unanswered"
          ? `${device?.name} did not answer`
          : stuck === "unavailable"
            ? `${device?.name} cannot leave ${network}`
            : `Remove ${device?.name}?`;
  const description =
    editing?.action === "rename"
      ? "Left empty, it is named after its room."
      : editing?.action === "forget"
        ? `${productName} deletes what it has kept of it, and keeps nothing more until you turn this on again.`
        : stuck
          ? `${
              stuck === "unanswered"
                ? "It may be switched off or out of range."
                : `${props.appName ?? "Its app"} is not running.`
            } Remove it anyway? ${productName} forgets it, but the device may still try to join until it is reset.`
          : device?.leftAt
            ? `It isn't paired with ${network} any more, as after a reset, so nothing reaches it. ${productName} forgets it, with its room and name. To keep it instead, reset it and add it again.`
            : `It leaves ${network} and ${productName} forgets it, with its room and name. To use it again, reset it and add it again.`;

  return (
    <Dialog
      open={!!props.editing}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {editing?.action === "rename" && (
            <Input
              aria-label="Name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          )}
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={editing?.action === "rename" ? "default" : "destructive"}
              disabled={working}
            >
              {editing?.action === "rename"
                ? "Save"
                : editing?.action === "forget"
                  ? working
                    ? "Deleting…"
                    : "Delete history"
                  : working
                    ? "Removing…"
                    : stuck
                      ? "Remove anyway"
                      : "Remove"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
