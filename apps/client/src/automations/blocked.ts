import {
  permissionWords,
  type AppInfo,
  type PieceInfo,
  type WorkflowInfo,
} from "@meetsanctum/app-sdk";

import { looksRunning, pausedFor } from "../app-state";
import { productName } from "../brand";

// An app that keeps an automation from running: the app that keeps it, or
// one whose pieces it uses, while that app isn't running, the app that keeps
// it while the app's grants don't cover it, which the core suspends it for,
// or an app one of whose pieces it uses needs a permission that is off. It
// says Can't run, as an automation that needs changing does, and its page
// says where to fix it: the app's settings, or Status for an app that
// stopped.

export type Blocked =
  | { app: AppInfo; kind: "paused" | "stopped" | "failed" | "down" | "off" }
  | {
      app: AppInfo;
      kind: "needs";
      /** The permissions its pieces need that are off, in Sanctum's words. */
      lacks: string[];
    }
  | {
      app: AppInfo;
      kind: "suspended";
      /** The permissions it lacks, in Sanctum's words. */
      lacks: string[];
      /** The core's own words, for what no permission would cover. */
      message: string;
    };

/** What keeps it from running, or null while nothing app's does. */
export function blockedBy(
  workflow: WorkflowInfo,
  apps: readonly AppInfo[],
  pieces: readonly PieceInfo[] = [],
): Blocked | null {
  const used = new Set(
    [workflow.app, ...workflow.graph.nodes.map((node) => node.app)].filter(
      (id): id is string => id !== null,
    ),
  );
  // The app that keeps it first, then the others in the order it uses them.
  const notRunning = [...used]
    .map((id) => apps.find((app) => app.id === id))
    .find((app) => app !== undefined && !looksRunning(app));
  if (notRunning) {
    return {
      app: notRunning,
      kind:
        notRunning.state === "stopped" ||
        notRunning.state === "failed" ||
        notRunning.state === "paused" ||
        notRunning.state === "off"
          ? notRunning.state
          : "down",
    };
  }
  for (const node of workflow.graph.nodes) {
    const piece = pieces.find(
      (each) =>
        each.kind === node.kind &&
        each.app === (node.app ?? null) &&
        each.id === node.piece,
    );
    const app = apps.find((each) => each.id === node.app);
    const off = (app ? (piece?.needs ?? []) : []).filter(
      (id) => !app!.permissions.includes(id),
    );
    if (app && off.length > 0) {
      return {
        app,
        kind: "needs",
        lacks: off.map((id) => permissionWords(id).title),
      };
    }
  }
  const keeper = apps.find((app) => app.id === workflow.app);
  const [first] = workflow.suspended;
  if (!keeper || !first) return null;
  return {
    app: keeper,
    kind: "suspended",
    lacks: [
      ...new Set(
        workflow.suspended.flatMap((each) =>
          each.permission ? [permissionWords(each.permission).title] : [],
        ),
      ),
    ],
    message: first.message,
  };
}

// "“See your remotes' presses” and “Know when there's motion”".
function quoted(titles: readonly string[]) {
  const each = titles.map((title) => `“${title}”`);
  if (each.length <= 1) return each.join("");
  return `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
}

/** The list's line: "Can't run while Moods is paused". */
export function blockedLine(blocked: Blocked) {
  switch (blocked.kind) {
    case "paused":
      return `Can't run while ${blocked.app.name} is paused`;
    case "off":
      return `Can't run while ${blocked.app.name} is off`;
    case "stopped":
    case "failed":
    case "down":
      return `Can't run while ${blocked.app.name} isn't running`;
    case "needs":
      return `Can't run without ${quoted(blocked.lacks)}`;
    case "suspended":
      return blocked.lacks.length > 0
        ? `Can't run without ${quoted(blocked.lacks)}`
        : `Can't run: ${blocked.message.charAt(0).toLowerCase()}${blocked.message.slice(1)}`;
  }
}

/** What its page says: why it can't run and what to do. */
export function blockedWords(blocked: Blocked) {
  const { name } = blocked.app;
  switch (blocked.kind) {
    case "paused": {
      const needs = pausedFor(blocked.app);
      return {
        title: `It can't run while ${name} is paused`,
        detail: `${name} needs ${
          needs
            ? `“${permissionWords(needs.id).title}”`
            : "a permission that's off"
        }. Turn it back on in ${name} settings.`,
      };
    }
    case "stopped":
      return {
        title: `It can't run while ${name} isn't running`,
        detail: `${name} starts again when ${productName} restarts.`,
      };
    case "off":
      return {
        title: `It can't run while ${name} is off`,
        detail: `Turn it back on in ${name} settings.`,
      };
    case "failed":
      return {
        title: `It can't run while ${name} isn't running`,
        detail: `${name} stopped after 5 failures in 10 minutes. Restart it in ${name} settings.`,
      };
    case "down":
      return {
        title: `It can't run while ${name} isn't running`,
        detail: `${name} starts again by itself, and this can run once it has.`,
      };
    case "needs": {
      const one = blocked.lacks.length === 1;
      return {
        title: `It can't run without ${quoted(blocked.lacks)}`,
        detail: `${name} needs ${one ? "it" : "them"} for this automation. Turn ${one ? "it" : "them"} on in ${name} settings.`,
      };
    }
    case "suspended":
      return blocked.lacks.length > 0
        ? {
            title: `It can't run without ${quoted(blocked.lacks)}`,
            detail: `${name} keeps it, and no longer has ${
              blocked.lacks.length === 1 ? "that permission" : "them"
            }. Turn ${blocked.lacks.length === 1 ? "it" : "them"} back on in ${name} settings.`,
          }
        : {
            title: "It can't run",
            detail: `${blocked.message}. Change it in ${name}.`,
          };
  }
}
