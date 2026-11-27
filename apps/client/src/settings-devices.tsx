import {
  historyFields,
  type AppInfo,
  type CapabilityInfo,
  type DeviceInfo,
  type DeviceType,
  type FirmwareState,
  type HistoryKept,
  type MotionCommand,
  type Places,
  type ProbeResult,
} from "@meetsanctum/app-sdk";
import { Button, type LiveFeed, useHomeClock } from "@meetsanctum/ui-sdk";
import { Radio } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AddDevices } from "./add-devices";
import { categoryLooks } from "./category-looks";
import { RepairDevice } from "./repair-device";
import { Row, Section } from "./components";
import { coreDevice, coreDevices } from "./core-devices";
import { coreJson } from "./core-fetch";
import type { OnHome } from "./dashboards";
import {
  firmwareProblem,
  firmwareStatus,
  updateButton,
  UpdateDialog,
  updatesHint,
  useMinuteClock,
  type CheckResult,
} from "./device-firmware";
import {
  deviceGroupOf,
  deviceGroupTitle,
  groupNoun,
  unknownGroup,
  upperFirst,
} from "./device-groups";
import {
  deviceDetail,
  DeviceLine,
  deviceStatus,
  pressShownMs,
} from "./device-line";
import { DeviceMenu } from "./device-menu";
import { EditDevice, keepHistory, type Editing } from "./edit-device";
import { foundHint, useAdding } from "./found-devices";
import { deviceProblem, DeviceIcon, updateDevice } from "./device-parts";
import { MotionSettings } from "./motion-settings";
import { DeviceGroupList } from "./settings-device-groups";
import type { ServiceNotSetUp } from "./system-status";

// Settings → Devices, where the household manages its hardware: first a
// list of the categories the home has devices in (settings-device-groups),
// then a page for each with its devices and their rooms, for every client,
// a shared one too, to add devices, rename
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

const byName = (a: DeviceInfo, b: DeviceInfo) => a.name.localeCompare(b.name);

export function DevicesSection(props: {
  apps: AppInfo[];
  live: LiveFeed;
  // What is on Home, which a device's menu changes.
  home: OnHome;
  // Opens with Add devices, as the dashboard's setup does.
  adding?: boolean;
  // The services the home never set up, for Add devices to say what to do.
  notSetUp?: readonly ServiceNotSetUp[];
  // The way back of Settings' Devices page, which it is the whole of.
  page?: ReactNode;
  // The group whose page this is, a category's id or the unknown one;
  // without one, the list of groups.
  group?: string;
  // Opens a group's page from the list.
  onOpenGroup?: (group: string) => void;
  // The devices the shell already has, which the page shows until its own
  // read answers, so it never opens blank.
  known?: readonly DeviceInfo[];
  knownRooms?: Places["rooms"];
}) {
  const clock = useHomeClock();
  const [devices, setDevices] = useState<DeviceInfo[] | undefined>(() =>
    props.known?.length ? [...props.known].sort(byName) : undefined,
  );
  const [rooms, setRooms] = useState<Places["rooms"]>(
    () => props.knownRooms ?? [],
  );
  // Whether each device with a history keeps it.
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const [initialReadDone, setInitialReadDone] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<Editing>();
  // What drivers found and could add, which the heading says.
  const addable = useAdding(props.live);
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
  // Each device's latest save of its room or what it is shown as, until it
  // answers or a live message for the device arrives; and the latest of
  // each kind of menu save, whatever has arrived live since.
  const saveAttempts = useRef(new Map<string, symbol>());
  const saveLatest = useRef(new Map<string, symbol>());
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
    const devicesRead = coreDevices();
    const placesRead = coreJson<Places>("/api/places");
    // Without them, the menus leave the choice out.
    const historiesRead = coreJson<HistoryKept[]>("/api/history/devices").catch(
      () => [],
    );
    try {
      const [nextDevices, places, histories] = await Promise.all([
        devicesRead,
        placesRead,
        historiesRead,
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
      // If another read failed first, let this one finish before retrying it.
      await historiesRead;
      if (pending.current === request) {
        pending.current = undefined;
        setInitialReadDone(true);
      }
    }
  }, []);

  // A device can arrive over the live feed after the initial read. Fetch
  // its recording choice before offering it in the menu.
  useEffect(() => {
    if (
      !initialReadDone ||
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
  }, [devices, kept, initialReadDone]);

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
          saveAttempts.current.delete(message.id);
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

  // What a device's menu could not do says so on the device's line and is
  // announced, as a failed check is, until the next try.
  const failed = (device: DeviceInfo, error: unknown) => {
    const text = deviceProblem(error);
    found(device.id, { kind: "problem", text });
    setAnnouncement(text);
  };
  const trying = (device: DeviceInfo) => {
    setAnnouncement("");
    if (results[device.id]?.kind === "problem") found(device.id);
  };

  // Saves a device's room or what it is shown as. A newer save of the
  // device or a live message for it takes precedence over a late reply,
  // and only the latest choice of its kind says that it failed: an earlier
  // one failing after it says nothing.
  const saveChoice = async (
    device: DeviceInfo,
    changes: { roomId: string | null } | { shownAs: DeviceType | null },
  ) => {
    const attempt = Symbol();
    const kind = `${device.id}/${"roomId" in changes ? "room" : "shownAs"}`;
    saveAttempts.current.set(device.id, attempt);
    saveLatest.current.set(kind, attempt);
    trying(device);
    try {
      const response = await updateDevice(device.id, changes);
      if (saveAttempts.current.get(device.id) === attempt) changed(response);
    } catch (error) {
      if (saveLatest.current.get(kind) === attempt) failed(device, error);
    } finally {
      if (saveAttempts.current.get(device.id) === attempt) {
        saveAttempts.current.delete(device.id);
      }
      if (saveLatest.current.get(kind) === attempt) {
        saveLatest.current.delete(kind);
      }
    }
  };

  // Whether it shows on Home and whether its history is kept are not the
  // device's own: they say when they could not be changed.
  const attempted = (
    device: DeviceInfo,
    choice: "home" | "history",
    work: Promise<unknown>,
  ) => {
    const attempt = Symbol();
    const kind = `${device.id}/${choice}`;
    saveLatest.current.set(kind, attempt);
    trying(device);
    void work
      .catch((error: unknown) => {
        if (saveLatest.current.get(kind) === attempt) failed(device, error);
      })
      .finally(() => {
        if (saveLatest.current.get(kind) === attempt) {
          saveLatest.current.delete(kind);
        }
      });
  };

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
    asked: MotionCommand,
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
  // A category's page, or the list of categories without one.
  const groupTitle = deviceGroupTitle(props.group);
  const listed =
    devices && groupTitle
      ? devices.filter((device) => deviceGroupOf(device) === props.group)
      : devices;
  const isList = !groupTitle;

  return (
    <Section
      id="settings-devices"
      title={groupTitle ?? "Devices"}
      hint={
        listed &&
        ([updatesHint(listed), foundHint(addable)]
          .filter(Boolean)
          .join(" · ") ||
          undefined)
      }
      action={
        <Button ref={addButton} onClick={() => setAdding(true)}>
          Add devices
        </Button>
      }
      page={props.page ?? null}
      hideBody={!listed}
      bare={isList && !!devices?.length}
    >
      {devices &&
        listed &&
        (isList ? (
          <DeviceGroupList
            devices={devices}
            now={now}
            onOpen={(group) => props.onOpenGroup?.(group)}
            focusFallback={addButton}
          />
        ) : listed.length === 0 ? (
          // Its last device went while its page was open: the page stays
          // until someone goes back.
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            <li className="flex items-center gap-3">
              <GroupRound group={props.group!} />
              <Row
                title={`No ${groupNoun(props.group)} any more`}
                detail={`${upperFirst(groupNoun(props.group))} you add show here`}
              />
            </li>
          </ul>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {listed.map((device) => {
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
                      clock,
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
                      attempted(
                        device,
                        "home",
                        on
                          ? props.home.add(device.id)
                          : props.home.remove(device.id),
                      )
                    }
                    onKeep={() =>
                      attempted(
                        device,
                        "history",
                        keepHistory(device.id, true).then(() =>
                          keepChanged(device.id, true),
                        ),
                      )
                    }
                    onEdit={(action) => setEditing({ action, device })}
                    onRoom={(roomId) => void saveChoice(device, { roomId })}
                    onShowAs={(shownAs) => void saveChoice(device, { shownAs })}
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
        apps={props.apps}
        adding={addable}
        notSetUp={props.notSetUp}
        live={props.live}
        onChanged={changed}
        onRemoved={(id) =>
          update((current) => current.filter((each) => each.id !== id))
        }
      />
    </Section>
  );
}

// A group's icon in the plain round, for its page's quiet row.
function GroupRound(props: { group: string }) {
  const Icon =
    props.group === unknownGroup
      ? Radio
      : (categoryLooks[props.group as keyof typeof categoryLooks]?.icon ??
        Radio);
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/12"
    >
      <Icon className="size-4" />
    </span>
  );
}
