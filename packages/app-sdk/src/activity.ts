// The activity log: what happened in the home, who did it and how it ended,
// as the core's activity routes answer it and its live socket pushes it.
// History says what a device was; the log says what was done and by whom,
// and keeps no reported state. Apps do not read the log.

/** What an entry is about, which decides how long it is kept and which list shows it. */
export const activityKinds = [
  "devices",
  "automations",
  "setup",
  "system",
] as const;
export type ActivityKind = (typeof activityKinds)[number];

/** How it ended: done, refused, or failed, as a device that did not answer. */
export type ActivityOutcome = "ok" | "refused" | "failed";

/**
 * Who did it, as people see them: a person, a shared client by its name,
 * a workflow, an app, a remote's press, a change at the device outside
 * Sanctum, or Sanctum itself. Names are as they are now, or as they were
 * once the thing is gone; null when nothing knows them.
 */
export type ActivityWho =
  | {
      kind: "person";
      id: string;
      name: string | null;
      colour: string | null;
      avatar: string | null;
    }
  | { kind: "client"; id: string; name: string | null }
  | { kind: "workflow"; id: string; name: string | null }
  | { kind: "app"; id: string; name: string | null }
  | { kind: "press"; device: string; name: string | null; action: string }
  | { kind: "assistant" }
  | { kind: "device" }
  | { kind: "sanctum" }
  | { kind: "nobody" };

export type ActivityThingType =
  "device" | "workflow" | "room" | "floor" | "person" | "client" | "dashboard";

/** Something an entry is about, by its name now, or then once it is gone. */
export type ActivityThing = {
  type: ActivityThingType;
  id: string;
  name: string | null;
  gone: boolean;
};

/** What started a workflow's run: its trigger's piece, and what words need of its config. */
export type ActivityTrigger = {
  piece: string;
  app: string | null;
  /** A sun trigger's. */
  event?: "sunrise" | "sunset";
  offsetMinutes?: number;
  /** A time trigger's, as HH:MM. */
  time?: string;
  /** A motion or no-motion trigger's place, by its name at the time. */
  place?: string;
  /** A no-motion trigger's wait. */
  forMinutes?: number;
};

/** The workflow run behind an entry, or the run an entry is. */
export type ActivityRun = {
  /** The run's own entry. */
  entry: string;
  workflow: string;
  name: string | null;
  /** The app that keeps the workflow, such as Moods for a remote's presses. */
  app: string | null;
  trigger: ActivityTrigger;
};

/** What a press or a run led to: the runs of the household's workflows, the apps and the devices. */
export type ActivityCaused = {
  runs: ActivityThing[];
  apps: { id: string; name: string | null }[];
  devices: ActivityThing[];
  /** How many of the commands failed or were refused. */
  failed: number;
};

/**
 * One entry. `detail` holds a few words of what it was, by action:
 *
 * - device.command: `asked`, what the command asked for, and for an entry
 *   that joins several, `from`, what the first asked;
 * - device.changed: `on`, as the device reported it outside Sanctum;
 * - device.press: `capability`, `action`, and `captured` while someone
 *   picks a press;
 * - workflow.run: `run`, `trigger` and `status`, as the run ended or
 *   `running`;
 * - sanctum.start: `version`, `stoppedAt` if it said it stopped, and
 *   `unexpected` if it stopped without saying;
 * - sanctum.space.free: `freed`, the bytes the disk gained, or null;
 * - device.update: `name` and `roomId`, whichever changed;
 * - a removal: `name`, what it was called;
 * - the manager's (source `manager`): update.end with `version`, `from`
 *   and `outcome`; service.start, .stop, .restart, .fail and .wait with
 *   `service` and `problem`; zigbee.adapter with `path`.
 */
export type ActivityInfo = {
  id: string;
  /** When it happened, or last happened for an entry that joins several. */
  at: string;
  /** When the first of the changes it joins happened. */
  firstAt: string | null;
  count: number;
  kind: ActivityKind;
  /** The core's module or the app that wrote it. */
  source: string;
  action: string;
  /** An app's action by its title, such as "Run mood". */
  title: string | null;
  outcome: ActivityOutcome;
  /** Why it was refused or failed, as an error code. */
  reason: string | null;
  detail: Record<string, unknown> | null;
  who: ActivityWho;
  /** The app whose code did it, such as Moods for a mood someone chose. */
  app: { id: string; name: string | null } | null;
  run: ActivityRun | null;
  subject: ActivityThing | null;
  /** The entry behind it, such as the run behind a command. */
  causeId: string | null;
  /** For a press or a run: what it led to. */
  caused: ActivityCaused | null;
};

/** What GET /api/activity answers: newest first, and whether older ones remain. */
export type ActivityPage = { entries: ActivityInfo[]; more: boolean };
