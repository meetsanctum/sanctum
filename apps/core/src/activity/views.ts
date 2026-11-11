import type {
  ActivityCaused,
  ActivityInfo,
  ActivityRun,
  ActivityThing,
  ActivityThingType,
  ActivityTrigger,
  ActivityWho,
} from "@meetsanctum/app-sdk";

import type { Activity, ActivityEntry } from "./activity.js";

// How clients see an entry of the activity log: who did it, found at the
// start of its causes, so a light a press turned on through a workflow and
// Moods names the press; the app and the workflow run behind it; what it is
// about, by its name now, or then once it is gone; and for a press or a run,
// what it led to.

/** Where names come from: the core's modules, by id; null for what they no longer have. */
export type ActivityLookups = {
  person(id: string): {
    name: string;
    colour: string;
    avatar: string | null;
  } | null;
  // Revoked clients too.
  client(id: string): string | null;
  app(id: string): string | null;
  // An app's action's title.
  action(app: string, id: string): string | null;
  workflow(id: string): { name: string; app: string | null } | null;
  device(id: string): string | null;
  room(id: string): string | null;
  floor(id: string): string | null;
  dashboard(id: string): string | null;
};

// What an action is about, by the start of its name.
const subjectTypes: [string, ActivityThingType][] = [
  ["device.", "device"],
  ["history.", "device"],
  ["workflow.", "workflow"],
  ["room.", "room"],
  ["floor.", "floor"],
  ["person.", "person"],
  ["login.", "person"],
  ["password.", "person"],
  ["client.", "client"],
  ["dashboard.", "dashboard"],
];

// A cause's causes are followed this far at most.
const deepest = 6;

const isApp = (source: string) => source.includes(".");

function actorOf(actor: string | null) {
  if (!actor) return null;
  const at = actor.indexOf(":");
  return at < 0
    ? { kind: actor, id: "" }
    : { kind: actor.slice(0, at), id: actor.slice(at + 1) };
}

export function createActivityViews(
  activity: Pick<Activity, "get" | "causedBy" | "nameThen">,
  lookups: ActivityLookups,
) {
  function nameOf(type: ActivityThingType, id: string): string | null {
    switch (type) {
      case "device":
        return lookups.device(id);
      case "workflow":
        return lookups.workflow(id)?.name ?? null;
      case "room":
        return lookups.room(id);
      case "floor":
        return lookups.floor(id);
      case "person":
        return lookups.person(id)?.name ?? null;
      case "client":
        return lookups.client(id);
      case "dashboard":
        return lookups.dashboard(id);
    }
  }

  function thing(type: ActivityThingType, id: string): ActivityThing {
    const name = nameOf(type, id);
    return name === null
      ? { type, id, name: activity.nameThen(id), gone: true }
      : { type, id, name, gone: false };
  }

  function subjectOf(entry: ActivityEntry): ActivityThing | null {
    if (!entry.subjectId) return null;
    const type = subjectTypes.find(([prefix]) =>
      entry.action.startsWith(prefix),
    )?.[1];
    return type ? thing(type, entry.subjectId) : null;
  }

  // The entry, then what caused it, back to the start.
  function chainOf(entry: ActivityEntry) {
    const chain = [entry];
    let at = entry;
    while (at.causeId && chain.length < deepest) {
      const cause = activity.get(at.causeId);
      if (!cause) break;
      chain.push(cause);
      at = cause;
    }
    return chain;
  }

  function whoOf(origin: ActivityEntry): ActivityWho {
    if (origin.action === "device.press" && origin.subjectId) {
      return {
        kind: "press",
        device: origin.subjectId,
        name: thing("device", origin.subjectId).name,
        action: String(origin.detail?.action ?? ""),
      };
    }
    if (origin.personId) {
      const person = lookups.person(origin.personId);
      return {
        kind: "person",
        id: origin.personId,
        name: person?.name ?? activity.nameThen(origin.personId),
        colour: person?.colour ?? null,
        avatar: person?.avatar ?? null,
      };
    }
    if (origin.clientId) {
      return {
        kind: "client",
        id: origin.clientId,
        name: origin.clientName ?? lookups.client(origin.clientId),
      };
    }
    const actor = actorOf(origin.actor);
    switch (actor?.kind) {
      case "workflow":
        return {
          kind: "workflow",
          id: actor.id,
          name: thing("workflow", actor.id).name,
        };
      case "app":
        return { kind: "app", id: actor.id, name: lookups.app(actor.id) };
      case "assistant-run":
        return { kind: "assistant" };
      case "device":
        return { kind: "device" };
      case "sanctum":
        return { kind: "sanctum" };
    }
    return origin.source === "manager"
      ? { kind: "sanctum" }
      : { kind: "nobody" };
  }

  function runOf(chain: ActivityEntry[]): ActivityRun | null {
    const run = chain.find((each) => each.action === "workflow.run");
    if (!run?.subjectId) return null;
    const workflow = lookups.workflow(run.subjectId);
    return {
      entry: run.id,
      workflow: run.subjectId,
      name: workflow?.name ?? activity.nameThen(run.subjectId),
      app: run.app ?? workflow?.app ?? null,
      trigger: (run.detail?.trigger as ActivityTrigger | undefined) ?? {
        piece: "manual",
        app: null,
      },
    };
  }

  function appOf(chain: ActivityEntry[]) {
    const id =
      chain.find((each) => each.app)?.app ??
      chain.find((each) => isApp(each.source))?.source;
    return id ? { id, name: lookups.app(id) } : null;
  }

  // What a press or a run led to, through the runs and apps' actions it
  // caused.
  function causedOf(entry: ActivityEntry): ActivityCaused | null {
    if (entry.action !== "device.press" && entry.action !== "workflow.run") {
      return null;
    }
    const runs = new Map<string, ActivityThing>();
    const apps = new Map<string, string | null>();
    const devices = new Map<string, ActivityThing>();
    let failed = 0;
    let level = [entry.id];
    for (let depth = 0; depth < 3 && level.length > 0; depth++) {
      const next: string[] = [];
      for (const caused of activity.causedBy(level)) {
        next.push(caused.id);
        if (caused.action === "workflow.run" && caused.subjectId) {
          const workflow = lookups.workflow(caused.subjectId);
          const keeper = caused.app ?? workflow?.app;
          if (keeper) apps.set(keeper, lookups.app(keeper));
          else runs.set(caused.subjectId, thing("workflow", caused.subjectId));
        } else if (isApp(caused.source)) {
          apps.set(caused.source, lookups.app(caused.source));
        } else if (caused.action === "device.command" && caused.subjectId) {
          if (caused.app) apps.set(caused.app, lookups.app(caused.app));
          devices.set(caused.subjectId, thing("device", caused.subjectId));
          if (caused.outcome !== "ok") failed++;
        }
      }
      level = next;
    }
    return {
      runs: [...runs.values()],
      apps: [...apps].map(([id, name]) => ({ id, name })),
      devices: [...devices.values()],
      failed,
    };
  }

  return {
    info(entry: ActivityEntry): ActivityInfo {
      const chain = chainOf(entry);
      return {
        id: entry.id,
        at: entry.at.toISOString(),
        firstAt: entry.firstAt?.toISOString() ?? null,
        count: entry.count,
        kind: entry.kind ?? "setup",
        source: entry.source,
        action: entry.action,
        title: isApp(entry.source)
          ? lookups.action(entry.source, entry.action)
          : null,
        outcome: entry.outcome,
        reason: entry.reason,
        detail: entry.detail,
        who: whoOf(chain.at(-1)!),
        app: appOf(chain),
        run: runOf(chain),
        subject: subjectOf(entry),
        causeId: entry.causeId,
        caused: causedOf(entry),
      };
    },

    /** The entries behind this one, to tell clients again once it is written. */
    causesOf(entry: ActivityEntry): ActivityEntry[] {
      return chainOf(entry).slice(1);
    },
  };
}

export type ActivityViews = ReturnType<typeof createActivityViews>;
