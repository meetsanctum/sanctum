import type { DeviceInfo, FirmwareInfo } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError } from "./core-fetch";
import { deviceProblem } from "./device-parts";

// A device's firmware and Check connection in Settings → Devices: what the
// line says of an update and of the checks run from this page, which comes
// first on it, and the dialog that asks before an update starts. It is the
// same on every client, a shared one too.

/** A check run from this page, and what it found, until the next one. */
export type CheckResult =
  | { kind: "checking" }
  | { kind: "probing" }
  // Whether an update is available, as the device's firmware now says.
  | { kind: "checked" }
  | { kind: "probed"; answeredInMs: number | null }
  | { kind: "problem"; text: string };

/** What a device's line starts with: what it says, and how. */
export type Status = {
  text: string;
  tone: "busy" | "plain" | "problem" | "done";
  // What follows it in the line's own colour, as an update under way
  // after what a check just found.
  then?: string;
  // An update's progress, while it runs.
  progress?: number;
};

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
// How long the line says a device was updated.
const updatedShownMs = 24 * hourMs;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** How long ago something happened, as a line says it. */
export function ago(at: string, now: number) {
  const ms = Math.max(0, now - Date.parse(at));
  if (ms < minuteMs) return "just now";
  if (ms < hourMs) return `${plural(Math.floor(ms / minuteMs), "minute")} ago`;
  return `${plural(Math.floor(ms / hourMs), "hour")} ago`;
}

/** About how long an update has left. */
export function timeLeft(seconds: number) {
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${plural(minutes, "minute")} left`;
  return `about ${plural(Math.round(minutes / 60), "hour")} left`;
}

/** What a line says of a device that didn't answer Check connection. */
export const noAnswer =
  "No connection: it didn't answer. Check it's switched on and in range.";

/** How long a device took to answer, such as "0.2 seconds". */
export function answeredIn(ms: number) {
  const seconds = Math.max(0.1, Number((ms / 1000).toFixed(1)));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

/** Another device of the same driver whose update is under way, if any. */
export function updatingBesides(
  device: DeviceInfo,
  devices: readonly DeviceInfo[],
) {
  return devices.find(
    (other) =>
      other.id !== device.id &&
      other.driver === device.driver &&
      other.firmware?.state === "updating",
  );
}

function updateStatus(
  firmware: FirmwareInfo,
  busy: DeviceInfo | undefined,
  now: number,
): Status | null {
  switch (firmware.state) {
    case "updating": {
      const progress = firmware.progress ?? 0;
      // Nothing has come from the device yet.
      const isStarting = progress === 0 && firmware.remainingSeconds === null;
      return {
        text: isStarting
          ? "Updating · starting"
          : [
              "Updating",
              `${Math.floor(progress)}%`,
              firmware.remainingSeconds === null
                ? null
                : timeLeft(firmware.remainingSeconds),
            ]
              .filter(Boolean)
              .join(" · "),
        tone: "plain",
        progress,
      };
    }
    case "waiting":
      return { text: "Updates when it wakes", tone: "plain" };
    case "failed":
      return {
        text: `The update didn't finish: ${lowerFirst(firmware.problem ?? "it stopped partway.")}`,
        tone: "problem",
      };
    case "available":
      return {
        text: busy
          ? `Update available once ${busy.name} has finished`
          : "Update available",
        tone: "plain",
      };
    case "current": {
      const { endedAt, checkedAt } = firmware;
      const isRecent =
        endedAt !== null &&
        now - Date.parse(endedAt) < updatedShownMs &&
        (checkedAt === null || checkedAt <= endedAt);
      return isRecent
        ? { text: `Updated ${ago(endedAt, now)}`, tone: "done" }
        : null;
    }
    default:
      return null;
  }
}

/**
 * What a device's line starts with, if anything: a check under way, then
 * what the last check here found, so every check is answered where
 * it was asked, with an update under way or waiting after it, then what is
 * known of its firmware. The rest of the line follows.
 */
export function firmwareStatus(
  device: DeviceInfo,
  devices: readonly DeviceInfo[],
  result: CheckResult | undefined,
  now: number,
): Status | null {
  if (result?.kind === "checking") {
    return { text: "Checking for an update…", tone: "busy" };
  }
  if (result?.kind === "probing") {
    return { text: "Checking connection…", tone: "busy" };
  }
  const firmware = device.firmware;
  const update =
    firmware && updateStatus(firmware, updatingBesides(device, devices), now);
  const isRunning =
    firmware?.state === "updating" || firmware?.state === "waiting";
  const found: Status | null =
    result?.kind === "probed"
      ? result.answeredInMs === null
        ? { text: noAnswer, tone: "problem" }
        : {
            text: `Connected, answered in ${answeredIn(result.answeredInMs)}`,
            tone: "plain",
          }
      : result?.kind === "problem"
        ? { text: result.text, tone: "problem" }
        : null;
  if (found) {
    return isRunning && update
      ? { ...found, then: update.text, progress: update.progress }
      : found;
  }
  if (isRunning) {
    return update;
  }
  if (
    result?.kind === "checked" &&
    firmware?.state === "current" &&
    firmware.checkedAt
  ) {
    return {
      text: `Up to date, checked ${ago(firmware.checkedAt, now)}`,
      tone: "plain",
    };
  }
  return update ?? null;
}

/** The number of devices with an update to start, for the section's heading. */
export function updatesHint(devices: readonly DeviceInfo[]) {
  const count = devices.filter(
    (device) =>
      device.firmware?.state === "available" ||
      device.firmware?.state === "failed",
  ).length;
  return count ? plural(count, "update") : undefined;
}

/** What the row's own button does, if it has one: start an update or try again. */
export function updateButton(
  device: DeviceInfo,
  devices: readonly DeviceInfo[],
) {
  const state = device.firmware?.state;
  if (state !== "available" && state !== "failed") return null;
  return {
    label: state === "failed" ? "Try again" : "Update",
    disabled: updatingBesides(device, devices) !== undefined,
  };
}

/** Why a menu's firmware or connection check cannot run for a device, if it cannot. */
export function whyNot(device: DeviceInfo, check: "update" | "probe") {
  if (check === "probe") {
    if (device.probe) return null;
    if (device.capabilities.every((each) => each.kind === "button")) {
      return "It sleeps between presses";
    }
    // Its driver says it sleeps, as one on a battery does, before it has
    // said how full the battery is.
    return device.capabilities.every(
      (each) => each.kind === "sensor" || each.kind === "occupancy",
    ) && device.firmware?.sleeps === true
      ? "It sleeps between readings"
      : "It can't be asked how it is";
  }
  return device.firmware?.updatable ? null : "No updates are offered for it";
}

/** Words for a firmware call that failed. */
export function firmwareProblem(
  error: unknown,
  what: "check" | "update" | "stop" | "probe",
  appName: string | null,
) {
  if (error instanceof CoreError) {
    if (error.code === "unavailable") {
      return `${appName ?? "Its app"} isn't running.`;
    }
    if (error.code === "conflict") {
      return what === "update"
        ? "It can't be updated right now. Try again once nothing else is updating."
        : "That can't be done right now.";
    }
    if (error.code === "app_failed" || error.code === "timeout") {
      return what === "check"
        ? "Couldn't check for an update: it didn't answer. Check it's switched on."
        : what === "probe"
          ? "Couldn't check the connection. Try again."
          : what === "stop"
            ? "Couldn't stop the update. Try again."
            : "Couldn't start the update. Try again.";
    }
  }
  return deviceProblem(error);
}

/**
 * Asks before an update starts: how long it takes, what the device does
 * meanwhile and at the end, and that losing power is safe. A device that
 * sleeps updates once it wakes. Starting it is the dialog's one primary
 * action; Cancel or Escape leave it.
 */
export function UpdateDialog(props: {
  device?: DeviceInfo;
  appName: string | null;
  onClose: () => void;
  onUpdate: (device: DeviceInfo) => Promise<void>;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<DeviceInfo>(undefined);
  if (props.device) last.current = props.device;
  const device = last.current;
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const shown = useRef(props.device);
  shown.current = props.device;

  useEffect(() => {
    setProblem(undefined);
    setWorking(false);
  }, [props.device?.id]);

  const firmware = device?.firmware;
  const sleeps = firmware?.sleeps ?? false;
  const isLight = device?.capabilities.some((each) => each.kind === "light");
  const isRemote = device?.capabilities.every((each) => each.kind === "button");
  const again =
    firmware?.state === "failed"
      ? `Last time it didn't finish: ${lowerFirst(firmware.problem ?? "it stopped partway.")}`
      : null;
  const paragraphs = sleeps
    ? [
        again,
        `It sleeps${isRemote ? " between presses" : ""}, so the update starts when it next wakes, which can take a day.${isRemote ? " Pressing one of its buttons wakes it sooner." : ""}`,
        `Then it takes an hour or more, and ${isRemote ? "its buttons work" : "it works"} as usual meanwhile.`,
      ]
    : [
        again,
        `This is slow: it can take an hour or more. ${isLight ? "The light works" : "It works"} as usual meanwhile, then restarts once at the end, so it may ${isLight ? "go off or flash" : "switch off"} for a moment.`,
        "Keep it switched on. If it loses power, it keeps its current firmware and you can try again.",
      ];

  const start = async () => {
    if (!device) return;
    setWorking(true);
    setProblem(undefined);
    try {
      await props.onUpdate(device);
      if (shown.current?.id === device.id) props.onClose();
    } catch (error) {
      if (shown.current?.id !== device.id) return;
      setWorking(false);
      setProblem(firmwareProblem(error, "update", props.appName));
    }
  };

  return (
    <Dialog
      open={!!props.device}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // No button is the default, so the dialog is read before either.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {again
              ? `Update ${device?.name} again?`
              : `Update ${device?.name}?`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">
              {paragraphs.filter(Boolean).map((text) => (
                <p key={text} className="m-0">
                  {text}
                </p>
              ))}
            </div>
          </DialogDescription>
        </DialogHeader>
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={working} onClick={() => void start()}>
            {working ? "Starting…" : sleeps ? "Update when it wakes" : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keeps a page's sense of now a minute fresh, so "just now" moves on, while
 * it is enabled: from then on, as from the start.
 */
export function useMinuteClock(enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), minuteMs);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}
