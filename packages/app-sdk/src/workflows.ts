import { z } from "zod";

import type { EventDefinition } from "./index.js";

// Workflows: the pieces an app adds to the household's rules, the jobs it
// schedules for itself, and the shapes the core's Workflows module and the
// Automations app share.

export const workflowsManagePermission = "workflows.manage";

// Markers on a piece's config fields, which their JSON Schema carries, so
// the Automations app knows how to read and change each field without
// knowing the piece: names() for a room, zone or device, partOf() for a
// part of the device beside it, entityOf() for one of a type's entities,
// timeOfDay, daysOfWeek and sunOffset for times, minutesField and luxField
// for how long and how bright, and choice() for labelled options. A field's title, set with .meta({ title }), names it in the
// editor's form.

/** A local time of day, such as 07:30. */
export const timeOfDay = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "use a time such as 07:30")
  .meta({ timeOfDay: true });

export const weekdays = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type Weekday = (typeof weekdays)[number];

/** The days something happens on; every day when left out. */
export const daysOfWeek = z
  .array(z.enum(weekdays))
  .min(1)
  .max(7)
  .meta({ days: true })
  .optional();

export const sunEvents = ["sunrise", "sunset"] as const;
export type SunEvent = (typeof sunEvents)[number];

/** Minutes before (negative) or after a sunrise or sunset. */
export const sunOffset = z
  .number()
  .int()
  .min(-720)
  .max(720)
  .meta({ offsetMinutes: true })
  .default(0);

/** Minutes something has lasted, such as no motion for 10 minutes. */
export const minutesField = z
  .number()
  .int()
  .min(1)
  .max(240)
  .meta({ minutes: true });

/** A light level in lux, such as darker than 30 lx. */
export const luxField = z.number().min(0).max(200_000).meta({ lux: true });

/**
 * Options with the words a sentence reads for each, such as
 * choice({ anyOn: "any light is on", allOff: "every light is off" }).
 */
export function choice<const Labels extends Record<string, string>>(
  labels: Labels,
) {
  const keys = Object.keys(labels) as [
    Extract<keyof Labels, string>,
    ...Extract<keyof Labels, string>[],
  ];
  return z.enum(keys).meta({ labels });
}

/**
 * A config field that names a part of the device another field names, such
 * as a light's capability beside its device: partOf("device").
 */
export function partOf(field: string) {
  return z.string().min(1).max(64).meta({ partOf: field });
}

/** A config field that names one entity of a type by its key. */
export function entityOf(type: string) {
  return z.string().min(1).max(128).meta({ entityOf: type });
}

/** When a job runs. */
export const jobWhen = z.union([
  // Once, at this instant; the job goes once it has run.
  z.strictObject({ at: z.iso.datetime({ offset: true }) }),
  // Every so many seconds, counted from the Unix epoch, so a restart keeps
  // the beat.
  z.strictObject({
    every: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 3600),
    offset: z.number().int().min(0).default(0),
  }),
  // Every day at the home's local time, or on the days given.
  z.strictObject({ daily: timeOfDay, days: daysOfWeek }),
  z.strictObject({ sun: z.enum(sunEvents), offsetMinutes: sunOffset }),
]);
export type JobWhen = z.input<typeof jobWhen>;

/** A job as it crosses into the core: the app's action by its id. */
export const jobRequest = z.strictObject({
  key: z.string().min(1).max(100),
  action: z.string().min(1).max(128),
  input: z.unknown(),
  when: jobWhen,
  // Works out its next run afresh, even if nothing else changed, as when the home's
  // time zone moved. Otherwise a job scheduled again as it was keeps its next run.
  fresh: z.boolean().optional(),
});
export type JobRequest = z.input<typeof jobRequest>;

/** One of an app's jobs, as the core keeps it. */
export type Job = {
  key: string;
  action: string;
  input: unknown;
  when: z.output<typeof jobWhen>;
  /** When it runs next; null while it waits, as for sun times. */
  nextAt: string | null;
};

/**
 * A trigger an app adds to workflows: one of its events, filtered by a
 * config. Each field set in the config must equal the event payload's field
 * of the same name, so matching a trigger runs no app code.
 */
export interface TriggerDefinition<
  Payload extends z.ZodType = z.ZodType,
  Config extends z.ZodType = z.ZodType,
> {
  readonly id: string;
  readonly title: string;
  readonly event: EventDefinition<Payload>;
  readonly config: Config;
  readonly words?: PieceWords;
  /**
   * The optional permissions it needs, which the workflow editor asks for
   * when someone adds it.
   */
  readonly needs?: readonly string[];
}

/**
 * A ready-made use of a piece, listed by its title in Automations' Add: the
 * part of the config it fixes and, when it reads differently, its own
 * sentence. A saved node keeps its piece and config; the editor finds its
 * preset by the config it fixes.
 */
export type PiecePreset = {
  readonly title: string;
  readonly sentence?: string;
  /** A trigger's card for it, when it reads differently from the piece's. */
  readonly card?: { readonly name: string; readonly specifics?: string };
  /** Its own glyph, when the piece has one (PieceWords.icon). */
  readonly icon?: string;
  readonly config: Readonly<Record<string, unknown>>;
};

/**
 * How Automations words a piece. A sentence names each field it shows as a
 * {field} token, such as "At {time} on {days}", and a trigger's card leads
 * its row in the list with a name and specifics, such as "{time}" and
 * "{days}". Without them, a card shows the piece's title and the values
 * that are set.
 */
export type PieceWords = {
  /**
   * The core's pieces only: a Lucide glyph for its card, such as clock.
   * An app's pieces show the app's icon; a piece about a device, without
   * one, shows the device's.
   */
  readonly icon?: string;
  readonly sentence?: string;
  readonly card?: { readonly name: string; readonly specifics?: string };
  readonly presets?: readonly PiecePreset[];
  /**
   * Sample values for its {field} tokens, as Automations would show them,
   * for the app's settings page, such as { id: "Aurora" } for "Run {id}".
   * When it has one, it gives every token its words and presets use.
   */
  readonly preview?: Readonly<Record<string, string>>;
};

/** A preview's value stays as short as a piece's chip. */
export const previewValueMaxLength = 40;

// The {field} tokens of some words.
function tokensOf(...texts: (string | undefined)[]) {
  return new Set(
    texts.flatMap((text) =>
      [...(text ?? "").matchAll(/\{(\w+)\}/g)].map((match) => match[1]!),
    ),
  );
}

/**
 * What is wrong with a piece's words' preview: a token it gives no value,
 * a value for no token, or a value that is not a short text.
 */
export function previewProblems(words: PieceWords | undefined): string[] {
  const preview = words?.preview;
  if (preview === undefined) return [];
  if (
    typeof preview !== "object" ||
    preview === null ||
    Array.isArray(preview)
  ) {
    return ["its preview must be an object of sample values"];
  }
  const tokens = tokensOf(
    words?.sentence,
    words?.card?.name,
    words?.card?.specifics,
    ...(words?.presets ?? []).flatMap((preset) => [
      preset.sentence,
      preset.card?.name,
      preset.card?.specifics,
    ]),
  );
  // Only own, enumerable values survive in the manifest's JSON.
  const values = new Map(Object.entries(preview));
  const problems: string[] = [];
  for (const token of tokens) {
    if (!values.has(token)) {
      problems.push(`its preview gives {${token}} no value`);
    }
  }
  for (const [name, value] of values) {
    if (!tokens.has(name)) {
      problems.push(`its preview gives ${name} a value, but no words use it`);
    } else if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > previewValueMaxLength
    ) {
      problems.push(
        `its preview's ${name} must be a text of at most ${previewValueMaxLength} characters`,
      );
    }
  }
  return problems;
}

export function defineTrigger<
  Payload extends z.ZodType,
  Config extends z.ZodType,
>(
  trigger: TriggerDefinition<Payload, Config>,
): TriggerDefinition<Payload, Config> {
  return trigger;
}

/** What a node in a workflow is. */
export const pieceKinds = ["trigger", "condition", "step"] as const;
export type PieceKind = (typeof pieceKinds)[number];

/**
 * How a field of a device's or entity's state is compared: v1's operators,
 * and below and above for numbers, such as a temperature below 18 °C.
 */
export const stateOperators = [
  "equals",
  "not_equals",
  "is_on",
  "is_off",
  "below",
  "above",
] as const;
export type StateOperator = (typeof stateOperators)[number];

/**
 * What a field of a piece's config can name by its id: a room, a zone or a
 * device, which the core keeps. A piece declares each such field with
 * names(), so the core can tell when what a workflow names is gone, and the
 * field's JSON Schema says `names`, for the editor's picker.
 */
export const namedKinds = ["room", "zone", "device"] as const;
export type NamedKind = (typeof namedKinds)[number];

/** A config field that names a room, a zone or a device by its id. */
export function names(kind: NamedKind) {
  return z.string().min(1).max(64).meta({ names: kind });
}

const nodeId = z.string().min(1).max(64);

export const workflowNode = z.strictObject({
  id: nodeId,
  kind: z.enum(pieceKinds),
  // The app that adds the piece; none for the core's own.
  app: z.string().min(1).max(128).optional(),
  // Its id, such as moods.runMood, or a core piece such as time.
  piece: z.string().min(1).max(128),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowNode = z.output<typeof workflowNode>;

/** v1's graph: triggers lead through conditions to steps along edges. */
export const workflowGraph = z.strictObject({
  version: z.literal(1).default(1),
  nodes: z.array(workflowNode).max(100),
  edges: z.array(z.strictObject({ from: nodeId, to: nodeId })).max(400),
});
export type WorkflowGraph = z.output<typeof workflowGraph>;

export const runModes = ["single", "restart", "queued", "parallel"] as const;
export type RunMode = (typeof runModes)[number];

export const runStatuses = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type RunStatus = (typeof runStatuses)[number];

export const stepStatuses = [
  "running",
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
] as const;
export type StepStatus = (typeof stepStatuses)[number];

/**
 * Why a workflow cannot run, tied to the node and the field of its config
 * it is about when there is one, so the editor can mark that value.
 */
export type WorkflowProblem = {
  node: string | null;
  /** The field's path in the node's config, such as place.id. */
  field: string | null;
  message: string;
  /**
   * The permission it lacks, for what the grants of the app that keeps the
   * workflow don't cover, where one would cover it.
   */
  permission?: string;
};

/** A workflow as clients see it (GET /api/workflows). */
export type WorkflowInfo = {
  id: string;
  name: string;
  enabled: boolean;
  runMode: RunMode;
  graph: WorkflowGraph;
  version: number;
  /** The person who made it, or the app that keeps it. */
  createdBy: string | null;
  app: string | null;
  /** The app's own key for a workflow it keeps, which only it changes. */
  appKey: string | null;
  /** Why it cannot run, such as a piece whose app is gone; none when whole. */
  problems: WorkflowProblem[];
  /** What it may not do on its own, such as a step that needs approval. */
  warnings: string[];
  /**
   * What the grants of the app that keeps it don't cover, which suspends
   * it until they do; none while they cover it.
   */
  suspended: WorkflowProblem[];
  /** Its latest run, when it has one. */
  lastRun: { id: string; status: RunStatus; at: string } | null;
  /** When a time or sun trigger next starts it, while it is on. */
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A workflow an app keeps by its own key (ctx.workflows.put): from the
 * core's pieces and the app's own only. Putting the key again replaces it.
 */
export const keptWorkflow = z.strictObject({
  // A composite key may include a device id and a full button action.
  key: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  runMode: z.enum(runModes).default("single"),
  graph: workflowGraph,
});
export type KeptWorkflowRequest = z.input<typeof keptWorkflow>;

export type WorkflowRunStep = {
  node: string;
  kind: Exclude<PieceKind, "trigger">;
  app: string | null;
  piece: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type WorkflowRunInfo = {
  id: string;
  workflowId: string;
  version: number;
  status: RunStatus;
  /** What started it: the trigger nodes that fired, and what they saw. */
  trigger: { nodes: string[]; key: string | null; data: unknown };
  /** Who pressed Run, for a manual run. */
  startedBy: string | null;
  /** The shared device it was run on, by its name, when no person ran it. */
  startedOn: string | null;
  /** Why it was skipped, cancelled or failed, such as busy or broken. */
  reason: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  steps: WorkflowRunStep[];
};

/** One piece in the editor's list (GET /api/workflows/pieces). */
export type PieceInfo = {
  kind: PieceKind;
  app: string | null;
  id: string;
  title: string;
  /** Its config, as JSON Schema, with the markers its fields carry. */
  config: unknown;
  icon: string | null;
  sentence: string | null;
  card: { name: string; specifics: string | null } | null;
  presets: PiecePreset[];
  /** The optional permissions of its app it needs, asked for as it is added. */
  needs: string[];
  /**
   * The group a trigger's workflows are listed under, such as Time; null
   * where the list groups them itself: a device's by its category, an
   * app's by the app.
   */
  group: string | null;
};
