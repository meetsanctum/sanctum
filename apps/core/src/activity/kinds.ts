import type { Kind } from "./schema.js";

// What each entry is about, which decides how long it is kept and which of
// the home's lists shows it:
//
// - devices: what devices did and what was done to them: commands, changes
//   outside Sanctum, presses, going offline and back, going quiet, a
//   battery falling low and a new one, firmware;
// - automations: workflow runs, and apps' actions a workflow or an app
//   called on its own;
// - setup: what people set up and asked apps to do: people, sign-ins and
//   clients, rooms, devices joining, moving and leaving, dashboards,
//   workflows, apps' actions;
// - system: updates, restores, Sanctum starting and the manager's audit.

const deviceActions = new Set([
  "device.command",
  "device.changed",
  "device.press",
  "device.offline",
  "device.online",
  "device.quiet",
  "device.probe",
  "device.problem",
  "device.repair",
]);

// An app's id is reverse DNS; the core's modules are single words.
const isApp = (source: string) => source.includes(".");

export function kindOf(entry: {
  source: string;
  action: string;
  actor?: string | null;
}): Kind {
  const { source, action } = entry;
  if (
    source === "manager" ||
    action.startsWith("sanctum.") ||
    action.startsWith("update.") ||
    action.startsWith("restore")
  ) {
    return "system";
  }
  if (
    deviceActions.has(action) ||
    action.startsWith("device.firmware.") ||
    action.startsWith("device.battery.")
  ) {
    return "devices";
  }
  if (action === "workflow.run") return "automations";
  if (isApp(source) && entry.actor) return "automations";
  return "setup";
}

const dayMs = 24 * 60 * 60_000;

export const activityTimes = {
  // How long each kind is kept: devices and runs are many, and what someone
  // asks about months later is setup and the system.
  keptMs: {
    devices: 30 * dayMs,
    automations: 30 * dayMs,
    setup: 365 * dayMs,
    system: 365 * dayMs,
  } satisfies Record<Kind, number>,
  // What is past keeping goes once a day and every so many entries
  // written, and the log never holds many more than this many entries, so
  // an app that commands without end cannot fill a Pi's SD card.
  pruneMs: dayMs,
  pruneEvery: 5_000,
  atMost: 200_000,
  // A command that leaves a light on or off as it was joins the entry before
  // it within this long, and a press repeated within this long, as a held
  // button repeats, joins the one before it.
  adjustmentsJoinMs: 30 * 60_000,
  pressesJoinMs: 2_000,
} as const;
