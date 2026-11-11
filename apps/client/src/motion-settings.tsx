import type {
  CapabilityInfo,
  DeviceInfo,
  OccupancyCommand,
  OccupancyFeatures,
  OccupancySensitivity,
  OccupancyState,
} from "@meetsanctum/app-sdk";
import { Button, Switch } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { ChevronDown, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { CoreError } from "./core-fetch";
import { deviceProblem } from "./device-parts";

// A motion sensor's own settings, from its menu in Settings → Devices: how
// readily it sees motion, how long after the last movement it says no
// motion, and whether its light blinks, each only where the sensor has it.
// Each change is sent at once, through the same command the tiles use, and
// its report confirms it. A sensor that sleeps takes it once it wakes, so
// the change waits under the setting until then; one it didn't take puts the
// control back on what the sensor says, in red, with Try again. A screen
// reader hears how each change ended.

type Occupancy = Extract<CapabilityInfo, { kind: "occupancy" }>;
type Setting = keyof OccupancyCommand;
type Asked = Partial<Pick<OccupancyState, Setting>>;

/** A device's motion sensor, if it has one. */
export function occupancyOf(device: DeviceInfo): Occupancy | undefined {
  return device.capabilities.find(
    (capability): capability is Occupancy => capability.kind === "occupancy",
  );
}

/** Whether a motion sensor has any settings to change. */
export function hasMotionSettings(features: OccupancyFeatures) {
  return (
    features.sensitivity !== null ||
    features.clearAfter !== null ||
    features.indicator
  );
}

const sensitivityLabels: Record<OccupancySensitivity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  very_high: "Very high",
  max: "Highest",
};

/** A sensitivity as the household reads it, such as Very high. */
export const sensitivityLabel = (level: OccupancySensitivity) =>
  sensitivityLabels[level];

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** How long a sensor waits before it says no motion, such as "2 minutes" or "90 seconds". */
export function clearAfterWords(seconds: number) {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    return plural(seconds / 3600, "hour");
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    return plural(seconds / 60, "minute");
  }
  return plural(seconds, "second");
}

// The choices of how long it waits, within the sensor's range.
const clearAfterChoices = [10, 30, 60, 120, 300, 600, 900, 1800];

/** What the menu offers: the usual choices within its range, and the one it has. */
export function clearAfterOptions(
  range: { min: number; max: number },
  current: number | undefined,
) {
  const within = clearAfterChoices.filter(
    (seconds) => seconds >= range.min && seconds <= range.max,
  );
  const options = within.length > 0 ? within : [range.min, range.max];
  if (current !== undefined) options.push(current);
  return [...new Set(options)].sort((a, b) => a - b);
}

// What a screen reader hears once the sensor has a change.
const takenWords = {
  sensitivity: (value: OccupancySensitivity) =>
    `Sensitivity set to ${sensitivityLabel(value)}`,
  clearAfter: (value: number) =>
    `It says no motion after ${clearAfterWords(value)}`,
  indicator: (value: boolean) =>
    value ? "It blinks on motion" : "It no longer blinks on motion",
};

// Where a change sent from here stands, until the sensor has it.
type Standing =
  | { kind: "pending" }
  | { kind: "conflict" }
  | { kind: "problem"; text: string };

function standingOf(
  capability: Occupancy,
  setting: Setting,
  asked: Asked,
  sending: ReadonlySet<Setting>,
  failed: Partial<Record<Setting, string>>,
): Standing | "taken" | null {
  const value = asked[setting];
  if (value === undefined) return null;
  const problem = failed[setting];
  if (problem) return { kind: "problem", text: problem };
  if (sending.has(setting)) return { kind: "pending" };
  const observed = capability.observed?.[setting];
  if (observed === value) return "taken";
  if (capability.sync === "pending") return { kind: "pending" };
  // A sensor that doesn't report a setting can't confirm it: the core
  // says whether it took the command.
  if (observed === undefined && capability.sync === "synced") return "taken";
  return { kind: "conflict" };
}

function conflictWords(
  setting: Setting,
  asked: Asked,
  observed: Asked,
  sleeps: boolean,
) {
  const then = sleeps ? " Press its button, then try again." : "";
  switch (setting) {
    case "sensitivity": {
      const was = observed.sensitivity;
      return `It didn't take ${sensitivityLabel(asked.sensitivity!)}${
        was ? `, so it stays on ${sensitivityLabel(was)}` : ""
      }.${then}`;
    }
    case "clearAfter": {
      const was = observed.clearAfter;
      return `It didn't take ${clearAfterWords(asked.clearAfter!)}${
        was !== undefined ? `, so it stays on ${clearAfterWords(was)}` : ""
      }.${then}`;
    }
    case "indicator":
      return `It didn't ${asked.indicator ? "start" : "stop"} blinking on motion.${then}`;
  }
}

function sendProblem(error: unknown, appName: string | null, sleeps: boolean) {
  if (error instanceof CoreError) {
    if (error.code === "unavailable") {
      return `${appName ?? "Its app"} isn't running.`;
    }
    if (error.code === "invalid_request") return "It can't take that.";
    if (error.code === "app_failed" || error.code === "timeout") {
      return sleeps
        ? "It didn't answer. Press its button, then try again."
        : "It didn't answer.";
    }
  }
  return deviceProblem(error);
}

export function MotionSettings(props: {
  // The device as the list has it now, live; none while the dialog is closed.
  device?: DeviceInfo;
  appName: string | null;
  onClose: () => void;
  onCommand: (
    device: DeviceInfo,
    capability: string,
    command: OccupancyCommand,
  ) => Promise<void>;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<DeviceInfo>(undefined);
  if (props.device) last.current = props.device;
  const device = last.current;
  const capability = device && occupancyOf(device);
  const open = props.device !== undefined;

  // What was last sent from here for each setting, until the sensor has it.
  const [asked, setAsked] = useState<Asked>({});
  const [sending, setSending] = useState<ReadonlySet<Setting>>(new Set());
  const [failed, setFailed] = useState<Partial<Record<Setting, string>>>({});
  // What a screen reader hears of how each change ended.
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef<Partial<Record<Setting, string>>>({});
  // Only the latest request for a setting in this dialog may finish it.
  const attempts = useRef<Partial<Record<Setting, symbol>>>({});
  const id = props.device?.id;

  useEffect(() => {
    setAsked({});
    setSending(new Set());
    setFailed({});
    setAnnouncement("");
    announced.current = {};
    attempts.current = {};
    return () => {
      attempts.current = {};
    };
  }, [id]);

  // A sensor that sleeps can't be asked how it is: it takes a change once
  // it wakes, as when its button is pressed.
  const sleeps = device?.probe === false;
  const settings = ["sensitivity", "clearAfter", "indicator"] as const;
  const standings = Object.fromEntries(
    settings.map((setting) => [
      setting,
      capability
        ? standingOf(capability, setting, asked, sending, failed)
        : null,
    ]),
  ) as Record<Setting, Standing | "taken" | null>;

  // Each change says how it ended, once: taken, waiting for the sensor to
  // wake, or not taken.
  useEffect(() => {
    if (!capability) return;
    const taken: Setting[] = [];
    for (const setting of settings) {
      const standing = standings[setting];
      if (standing === null) continue;
      let text: string | null = null;
      if (standing === "taken") {
        taken.push(setting);
        const value = asked[setting]!;
        text = `${(takenWords[setting] as (value: unknown) => string)(value)}.`;
      } else if (standing.kind === "conflict") {
        text = conflictWords(setting, asked, capability.observed ?? {}, sleeps);
      } else if (standing.kind === "problem") {
        text = standing.text;
      } else if (sleeps) {
        text = waitingWords;
      }
      if (text && announced.current[setting] !== text) {
        announced.current[setting] = text;
        setAnnouncement(text);
      }
    }
    if (taken.length > 0) {
      setAsked((current) => {
        const next = { ...current };
        for (const setting of taken) delete next[setting];
        return next;
      });
      for (const setting of taken) delete announced.current[setting];
    }
  });

  const send = async (command: OccupancyCommand) => {
    if (!device || !capability) return;
    const [setting] = Object.keys(command) as Setting[];
    if (!setting) return;
    const attempt = Symbol();
    attempts.current[setting] = attempt;
    setAsked((current) => ({ ...current, ...command }));
    setFailed(({ [setting]: _, ...rest }) => rest);
    setSending((current) => new Set(current).add(setting));
    delete announced.current[setting];
    try {
      await props.onCommand(device, capability.id, command);
    } catch (error) {
      if (attempts.current[setting] === attempt) {
        setFailed((current) => ({
          ...current,
          [setting]: sendProblem(error, props.appName, sleeps),
        }));
      }
    } finally {
      if (attempts.current[setting] === attempt) {
        setSending((current) => {
          const next = new Set(current);
          next.delete(setting);
          return next;
        });
      }
    }
  };
  const retry = (setting: Setting) => {
    const value = asked[setting];
    if (value !== undefined) void send({ [setting]: value });
  };

  // What a control shows: the change on its way, or, once the sensor
  // didn't take it, what the sensor says.
  function shown<S extends Setting>(setting: S): OccupancyState[S] | undefined {
    const standing = standings[setting];
    if (standing !== null && standing !== "taken") {
      return standing.kind === "pending"
        ? asked[setting]
        : capability?.observed?.[setting];
    }
    return asked[setting] ?? capability?.state?.[setting];
  }

  const features = capability?.features;
  // By its name alone: what a driver calls a model can be as plain as
  // "Motion sensor", which reads badly after an article.
  const description = `${device?.name ?? ""}.`;
  const clearAfter = shown("clearAfter");
  const clearAfterMin = features?.clearAfter?.min ?? 0;

  const lineOf = (setting: Setting) => {
    const standing = standings[setting];
    if (standing === null || standing === "taken") return null;
    return standing.kind === "pending"
      ? {
          kind: "pending" as const,
          text: sleeps ? waitingWords : "Sending…",
        }
      : {
          kind: "problem" as const,
          text:
            standing.kind === "problem"
              ? standing.text
              : conflictWords(
                  setting,
                  asked,
                  capability?.observed ?? {},
                  sleeps,
                ),
        };
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="gap-5.5 sm:max-w-130">
        <DialogHeader className="gap-1">
          <DialogTitle>Motion settings</DialogTitle>
          <DialogDescription>
            {description} Each change is sent to it at once.
          </DialogDescription>
        </DialogHeader>
        {features?.sensitivity && (
          <Field
            label="Sensitivity"
            hint="Higher notices smaller movements, from further away, and pets too."
            standing={lineOf("sensitivity")}
            onRetry={() => retry("sensitivity")}
            control={(ids) => (
              <ToggleGroup
                type="single"
                aria-labelledby={ids.label}
                aria-describedby={ids.hint}
                value={shown("sensitivity") ?? ""}
                // Pressing the chosen one again keeps it.
                onValueChange={(value: string) =>
                  value &&
                  value !== shown("sensitivity") &&
                  void send({ sensitivity: value as OccupancySensitivity })
                }
                spacing={1}
                className="w-full rounded-md bg-foreground/8 p-0.75"
              >
                {features.sensitivity!.map((level) => (
                  <ToggleGroupItem
                    key={level}
                    value={level}
                    className="h-8.5 flex-1 rounded-sm px-1.5 text-sm hover:bg-foreground/5 data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground/90 data-[state=on]:hover:text-background"
                  >
                    {sensitivityLabel(level)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            stacked
          />
        )}
        {features?.clearAfter && (
          <Field
            label="Says no motion after"
            hint={`How long after the last movement it stops saying Motion now. ${
              clearAfterMin > clearAfterChoices[0]!
                ? `It can't say no motion sooner than ${clearAfterWords(clearAfterMin)}.`
                : "Automations can wait longer."
            }`}
            standing={lineOf("clearAfter")}
            onRetry={() => retry("clearAfter")}
            control={(ids) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    id={ids.control}
                    variant="outline"
                    aria-labelledby={`${ids.label} ${ids.control}`}
                    aria-describedby={ids.hint}
                    className="shrink-0"
                  >
                    {clearAfter === undefined
                      ? "Not known"
                      : clearAfterWords(clearAfter)}
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuRadioGroup
                    value={clearAfter === undefined ? "" : String(clearAfter)}
                    onValueChange={(value) =>
                      Number(value) !== clearAfter &&
                      void send({ clearAfter: Number(value) })
                    }
                  >
                    {clearAfterOptions(features.clearAfter!, clearAfter).map(
                      (seconds) => (
                        <DropdownMenuRadioItem
                          key={seconds}
                          value={String(seconds)}
                        >
                          {clearAfterWords(seconds)}
                        </DropdownMenuRadioItem>
                      ),
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          />
        )}
        {features?.indicator && (
          <Field
            label="Blink on motion"
            hint="Its light blinks each time it sees motion."
            standing={lineOf("indicator")}
            onRetry={() => retry("indicator")}
            control={(ids) => (
              <Switch
                aria-labelledby={ids.label}
                aria-describedby={ids.hint}
                checked={shown("indicator") === true}
                onCheckedChange={(checked) => void send({ indicator: checked })}
              />
            )}
          />
        )}
        <p role="status" className="sr-only">
          {announcement}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const waitingWords = "Waiting for it to wake. Press its button to send it now.";

// One setting: its name with its control beside it, or under it for a
// row of choices, then its hint, or how its change stands in place of it.
function Field(props: {
  label: string;
  hint: string;
  standing: { kind: "pending" | "problem"; text: string } | null;
  stacked?: boolean;
  onRetry: () => void;
  control: (ids: { label: string; hint: string; control: string }) => ReactNode;
}) {
  const base = useId();
  const ids = {
    label: `${base}-label`,
    hint: `${base}-hint`,
    control: `${base}-control`,
  };
  const { standing } = props;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <span id={ids.label} className="text-[15px] leading-5 font-medium">
          {props.label}
        </span>
        {!props.stacked && props.control(ids)}
      </div>
      {props.stacked && props.control(ids)}
      {standing ? (
        <div
          id={ids.hint}
          className={cn(
            "flex items-start gap-2 text-[13px] leading-[18px] font-medium",
            standing.kind === "problem" && "text-destructive",
          )}
        >
          {standing.kind === "pending" ? (
            <LoaderCircle
              aria-hidden="true"
              className="mt-px size-4 shrink-0 animate-spin"
            />
          ) : (
            <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
          )}
          <span className="flex-1">{standing.text}</span>
          {standing.kind === "problem" && (
            <Button
              variant="outline"
              size="sm"
              className="-my-1.5"
              onClick={props.onRetry}
            >
              Try again
            </Button>
          )}
        </div>
      ) : (
        <p
          id={ids.hint}
          className="m-0 text-[13px] leading-[18px] text-muted-foreground"
        >
          {props.hint}
        </p>
      )}
    </div>
  );
}
