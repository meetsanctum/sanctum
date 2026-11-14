import { z } from "zod";

import {
  appManifestSchema,
  defaultData,
  defaultMemory,
  type AppIcon,
  type AppManifestFields,
} from "./app-manifest.js";
import type { AppContext } from "./context.js";
import {
  assertDevicePages,
  devicePageInfo,
  type DevicePageDefinition,
  type DevicePageInfo,
} from "./device-pages.js";
import {
  registerPermission,
  type DriverCommand,
  type DriverMove,
} from "./devices.js";
import type { EntityTypeDefinition, Provides } from "./entities.js";
import {
  assertDriverProblems,
  staticProblems,
  type DriverProblem,
  type DriverQuestion,
  type DriverRepair,
  type DriverRepairResult,
} from "./device-problems.js";
import type { DriverDevice } from "./firmware.js";
import type { DriverRemoval } from "./pairing.js";
import {
  needsProblems,
  permissionIds,
  permissionInfo,
  type AppRun,
  type AppState,
  type PermissionInfo,
} from "./permissions.js";
import {
  assertRoomSections,
  roomSectionInfo,
  sampleTile,
  type RoomSectionDefinition,
  type RoomSectionInfo,
} from "./room-sections.js";
import { turnOnType } from "./lights.js";
import { settingsSchemaOf, type SettingsSchema } from "./settings.js";
import { forecastType, sunType } from "./weather.js";
import {
  assertWidgets,
  widgetContent,
  widgetEntityType,
  widgetInfo,
  type WidgetInfo,
} from "./widgets.js";
import {
  previewProblems,
  type PieceWords,
  type TriggerDefinition,
} from "./workflows.js";

export * from "./activity.js";
export * from "./app-manifest.js";
export * from "./context.js";
export * from "./core-events.js";
export * from "./dashboards.js";
export * from "./device-problems.js";
export * from "./device-categories.js";
export * from "./device-maintenance.js";
export * from "./device-pages.js";
export * from "./device-types.js";
export * from "./devices.js";
export * from "./entities.js";
export * from "./firmware.js";
export * from "./history.js";
export * from "./lights.js";
export * from "./live.js";
export * from "./net.js";
export * from "./pairing.js";
export * from "./people.js";
export * from "./permission-words.js";
export * from "./permissions.js";
export * from "./pins.js";
export * from "./places.js";
export * from "./room-sections.js";
export * from "./settings.js";
export * from "./sun.js";
export * from "./weather.js";
export * from "./widgets.js";
export * from "./workflows.js";

/**
 * The core's standard entity types, which any app may provide and, with
 * entities.read:<type>, read. The core reads some itself: sun for its
 * workflows, and lights.turnOn when it turns a place's lights on.
 */
export const standardEntityTypes: readonly EntityTypeDefinition[] = [
  sunType,
  forecastType,
  turnOnType,
];

/** How dangerous an action is; the core maps tiers to auto-run or approval. */
export const tierSchema = z.enum([
  "read",
  "write",
  "destructive",
  "irreversible-external",
]);
export type Tier = z.infer<typeof tierSchema>;

/**
 * The tiers that run with no person behind them: a workflow or an app on its
 * own does the everyday things, and the rest needs a person.
 */
export const householdTiers: readonly Tier[] = ["read", "write"];

/**
 * Who is behind a call. Every action call carries one. A `client` is a shared
 * client, such as the kitchen tablet: it acts as the household, never as a
 * person, and may do everything a person may.
 */
export const actorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().min(1) }),
  z.object({ kind: z.literal("client"), id: z.string().min(1) }),
  z.object({ kind: z.literal("workflow"), id: z.string().min(1) }),
  z.object({
    kind: z.literal("assistant-run"),
    id: z.string().min(1),
    onBehalfOf: z.string().min(1),
  }),
  z.object({ kind: z.literal("app"), id: z.string().min(1) }),
]);
export type Actor = z.infer<typeof actorSchema>;

export interface ActionDefinition<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly input: Input;
  readonly output: Output;
  readonly assistant?: {
    readonly expose: boolean;
    readonly description: string;
  };
  /** How Automations words it as a workflow's step or condition. */
  readonly words?: PieceWords;
  /**
   * The optional permissions it needs as a workflow's piece, which the
   * workflow editor asks for when someone adds it.
   */
  readonly needs?: readonly string[];
  run(ctx: AppContext, input: z.output<Input>): Promise<z.input<Output>>;
}

export function defineAction<Input extends z.ZodType, Output extends z.ZodType>(
  action: ActionDefinition<Input, Output>,
): ActionDefinition<Input, Output> {
  return action;
}

/** What a caller sends an action, before its defaults are applied. */
export type ActionInput<Action> =
  Action extends ActionDefinition<infer Input, z.ZodType>
    ? z.input<Input>
    : never;

/** What an action answers its caller. */
export type ActionOutput<Action> =
  Action extends ActionDefinition<z.ZodType, infer Output>
    ? z.output<Output>
    : never;

export const actionErrorCodes = [
  "forbidden",
  "not_found",
  "conflict",
  // The permission gate's refusal, which reaches an app when the core
  // refuses one of its calls for the actor behind it.
  "needs_approval",
] as const;
export type ActionErrorCode = (typeof actionErrorCodes)[number];

/**
 * A refusal an action reports to its caller, such as a mood that is no
 * longer there. The core answers with its code and logs it; anything else
 * an action throws is a failure.
 */
export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * What an app's start throws when something it needs isn't there yet, saying
 * what, such as "Waiting for Zigbee2MQTT". The core tries again by itself and
 * doesn't count it as a failure.
 */
export class NotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotReady";
  }
}

/** Whether a start said it isn't ready, by name, as for ActionError below. */
export function isNotReady(error: unknown): error is NotReady {
  return error instanceof Error && error.name === "NotReady";
}

/**
 * Why an app is starting: for the first time, on a new version, back on the old
 * version after a new one failed, or anything else, a restart included. It must be
 * safe to repeat whatever the reason.
 */
export const startReasons = [
  "added",
  "updated",
  "started",
  "rolledBack",
] as const;
export type StartInfo =
  | { reason: "added" | "started" }
  | { reason: "updated" | "rolledBack"; from: string };

/** Why an app is stopping on purpose. A crash calls no hook. */
export const stopReasons = [
  "off",
  "paused",
  "restarting",
  "updating",
  "removing",
  "shutdown",
] as const;
export type StopInfo = { reason: (typeof stopReasons)[number] };

/**
 * Whether an app refused with an ActionError. The core goes by the error's
 * name and code rather than its class, so a refusal stays one from an app
 * package that brings its own copy of this SDK instead of the core's.
 */
export function isActionError(error: unknown): error is ActionError {
  return (
    error instanceof Error &&
    error.name === "ActionError" &&
    actionErrorCodes.includes((error as { code?: unknown }).code as never)
  );
}

export interface EventDefinition<Payload extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly payload: Payload;
}

export function defineEvent<Payload extends z.ZodType>(
  event: EventDefinition<Payload>,
): EventDefinition<Payload> {
  return event;
}

const memberId = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export { isOlderVersion } from "./contract.js";

/** An installed app as clients see it (GET /api/apps). */
export type AppInfo = {
  id: string;
  name: string;
  version: string;
  /** The oldest version of its pages that work with it, if any don't. */
  oldestPage?: string;
  icon: AppIcon | null;
  pages: string[];
  /**
   * What the core lets it do now, its grants among what it asks for, which
   * also bounds what its pages may ask for.
   */
  permissions: string[];
  /** What it asks for, each with its reason, for its settings page. */
  requests: PermissionInfo[];
  /**
   * Paused while a permission it needs is switched off; stopped, until
   * Sanctum restarts, when it did not stop cleanly.
   */
  state: AppState;
  /** More of that state, for an app that runs in its own container. */
  run?: AppRun;
  /** A system app, which can't be turned off, so nothing offers to. */
  alwaysOn?: true;
  /** Its preferences' schema, for the form in Settings → Apps → the app; null when it has none. */
  settings: SettingsSchema | null;
  /** What it brings to the home: its entities' types, its widgets and its room sections. */
  provides: {
    entities: { id: string; title: string }[];
    widgets: WidgetInfo[];
    roomSections: RoomSectionInfo[];
    devicePages: DevicePageInfo[];
  };
};

/**
 * What an app brings to the home, declared so the core and its editors can
 * list it without running the app: its entity types, widgets and room
 * section, and its workflow pieces.
 */
export interface AppProvides extends Provides {
  /** Its part of every room's page, at most one (room-sections.ts). */
  readonly roomSections?: readonly RoomSectionDefinition[];
  /** Pages it adds to the detail of devices of some kinds (device-pages.ts). */
  readonly devicePages?: readonly DevicePageDefinition[];
  readonly triggers?: readonly TriggerDefinition[];
  /** Read actions that answer true or false. */
  readonly conditions?: readonly ActionDefinition[];
  readonly steps?: readonly ActionDefinition[];
}

export interface AppDefinition extends AppManifestFields {
  readonly actions: readonly ActionDefinition[];
  readonly events: readonly EventDefinition[];
  /**
   * Its preferences, as a zod object (settings.ts): the core keeps what
   * the household chooses, Settings → Apps → the app shows them as a form, and the
   * app reads them with ctx.settings.get().
   */
  readonly settings?: z.ZodObject;
  /**
   * What it brings to the home: its entities' types and widgets, and its
   * workflow pieces.
   */
  readonly provides?: AppProvides;
  /**
   * Runs when the core starts the app, with a context that lasts until
   * `stop`, acting as the app itself. A driver opens its connection here
   * and reports its devices through this context. An app that runs apart may
   * throw NotReady to be tried again later.
   */
  start?(ctx: AppContext, info: StartInfo): Promise<void>;
  /**
   * Runs instead of `start` when the core restarted while the app ran, as for
   * an update of the core. With it, the app goes on through the restart: what
   * its start set going keeps running, though its calls into the core fail
   * while no core is there, and the events it follows come again. It catches
   * up with what may have changed, from one snapshot of the home as a start
   * reads, through the same context its start was given. Without it, the app
   * stops as the core goes and starts again for the next. One that fails, or
   * throws NotReady, is stopped.
   */
  resume?(ctx: AppContext, info: StartInfo): Promise<void>;
  /** Runs when the core stops or removes the app. */
  stop?(ctx: AppContext, info: StopInfo): Promise<void>;
  /**
   * A driver app's side of the Drivers contract: the core hands it every
   * command for its own devices, as the actor behind the command. It
   * resolves once the command is on its way; the device's report confirms
   * it. An unknown device is refused with ActionError("not_found").
   */
  readonly driver?: {
    command(ctx: AppContext, command: DriverCommand): Promise<void>;
    /**
     * Moves one of its lights' brightness up or down at a rate until a stop,
     * or stops it, as while a remote's button is held, resolving once the
     * move is on its way. The light's reports say where it got to. A driver
     * without it has its lights left alone by holds.
     */
    move?(ctx: AppContext, move: DriverMove): Promise<void>;
    /**
     * Lets new devices join the driver's network while someone adds
     * devices: `open` for `seconds`, answering until when, and `close` to
     * stop. Meanwhile the driver says how each device that joins is getting
     * on (ctx.devices.joining) and registers it once it can.
     */
    readonly pairing?: {
      open(
        ctx: AppContext,
        request: { seconds: number },
      ): Promise<{ until: string | null }>;
      close(ctx: AppContext): Promise<void>;
    };
    /**
     * Takes one of its devices off its network, resolving once it has gone;
     * the core then forgets it. A device it no longer has is gone already.
     */
    remove?(ctx: AppContext, removal: DriverRemoval): Promise<void>;
    /**
     * Updates its devices' firmware, when someone asks. `check` asks whether
     * an update is available and resolves once the driver has said
     * (ctx.devices.firmware); `update` starts one, or has a sleeping device
     * start it when it wakes, and resolves once it is on its way; `stop`
     * ends one under way or waiting, and the device keeps what it runs. The
     * driver says how each goes as it learns it.
     */
    readonly firmware?: {
      check(ctx: AppContext, device: DriverDevice): Promise<void>;
      update(ctx: AppContext, device: DriverDevice): Promise<void>;
      stop(ctx: AppContext, device: DriverDevice): Promise<void>;
    };
    /**
     * Asks one of its devices how it is now, resolving once asked: the
     * device's report answers (Check connection).
     */
    probe?(ctx: AppContext, device: DriverDevice): Promise<void>;
    /**
     * What can be wrong with its devices, by id, in its own words, which it
     * names for a device with ctx.devices.problem (device-problems.ts).
     */
    readonly problems?: Readonly<Record<string, DriverProblem>>;
    /** What repairing one of its devices may ask, by id. */
    readonly questions?: Readonly<Record<string, DriverQuestion>>;
    /**
     * Sets one of its devices right, with the answers to what its problem's
     * repair asks, resolving once done or with the answer it refuses.
     */
    repair?(ctx: AppContext, repair: DriverRepair): Promise<DriverRepairResult>;
  };
}

/**
 * Validates an app definition and returns it unchanged. Throws on the first
 * problem found. The core runs it again on every package it loads.
 */
export function defineApp(app: AppDefinition): AppDefinition {
  appManifestSchema.parse(app);
  if (!Array.isArray(app.actions) || !Array.isArray(app.events)) {
    throw new Error("An app needs lists of actions and events");
  }
  for (const action of app.actions) {
    assertAction(action);
  }
  assertUniqueIds(
    "action",
    app.actions.map((action) => action.id),
  );
  assertUniqueIds(
    "event",
    app.events.map((event) => event.id),
  );
  for (const id of [...app.actions, ...app.events].map((item) => item.id)) {
    if (!memberId.test(id)) {
      throw new Error(`"${id}" must be namespaced, such as example.addItem`);
    }
  }
  const pages = app.pages ?? [];
  assertUniqueIds("page", pages);
  if (pages.length > 0 && !app.icon) {
    throw new Error("An app with pages has an icon");
  }
  for (const hook of ["start", "resume", "stop"] as const) {
    if (app[hook] !== undefined && typeof app[hook] !== "function") {
      throw new Error(`An app's ${hook} must be a function`);
    }
  }
  if (app.settings !== undefined) {
    settingsSchemaOf(app.settings);
  }
  const asked = permissionIds(app.permissions);
  assertUniqueIds("permission", asked);
  assertProvides(app);
  assertRoomSections(app);
  assertDevicePages({ permissions: asked, provides: app.provides });
  assertWorkflowPieces(app);
  // A driver brings devices and carries out their commands, so the two go
  // together.
  const isDriver = asked.includes(registerPermission);
  if (isDriver !== (typeof app.driver?.command === "function")) {
    throw new Error(
      `A driver app holds ${registerPermission} and has a driver.command function`,
    );
  }
  const pairing = app.driver?.pairing;
  if (
    pairing !== undefined &&
    (typeof pairing?.open !== "function" ||
      typeof pairing?.close !== "function")
  ) {
    throw new Error("A driver's pairing has open and close functions");
  }
  for (const hook of ["move", "remove"] as const) {
    if (
      app.driver?.[hook] !== undefined &&
      typeof app.driver[hook] !== "function"
    ) {
      throw new Error(`A driver's ${hook} must be a function`);
    }
  }
  const firmware = app.driver?.firmware;
  if (
    firmware !== undefined &&
    (["check", "update", "stop"] as const).some(
      (hook) => typeof firmware?.[hook] !== "function",
    )
  ) {
    throw new Error("A driver's firmware has check, update and stop functions");
  }
  if (
    app.driver?.probe !== undefined &&
    typeof app.driver.probe !== "function"
  ) {
    throw new Error("A driver's probe must be a function");
  }
  if (app.driver) assertDriverProblems(app.driver);
  return app;
}

// The Drivers contract's hooks a driver may have, besides command.
const driverHooks = [
  "command",
  "move",
  "pairing",
  "remove",
  "firmware",
  "probe",
  "repair",
] as const;

/**
 * The static, JSON-serializable manifest the core reads before loading any
 * app code: everything it would otherwise learn by running the app, its
 * migrations, driver hooks and pieces' words among them, with the sample
 * values its settings page previews.
 */
export function toStaticManifest(app: AppDefinition) {
  return {
    id: app.id,
    name: app.name,
    version: app.version,
    core: app.core,
    summary: app.summary?.trim() ?? null,
    runtime: {
      memory: app.runtime?.memory ?? defaultMemory,
      data: app.runtime?.data ?? defaultData,
    },
    migrations: app.migrations ?? null,
    driver: app.driver
      ? {
          hooks: driverHooks.filter((hook) => app.driver?.[hook]),
          ...staticProblems(app.driver),
        }
      : null,
    permissions: app.permissions.map(permissionInfo),
    icon: app.icon ?? null,
    pages: [...(app.pages ?? [])],
    settings: app.settings ? settingsSchemaOf(app.settings) : null,
    actions: app.actions.map((action) => ({
      id: action.id,
      title: action.title,
      tier: action.tier,
      input: z.toJSONSchema(action.input, { io: "input" }),
      output: z.toJSONSchema(action.output),
      assistant: action.assistant ?? null,
    })),
    events: app.events.map((event) => ({
      id: event.id,
      payload: z.toJSONSchema(event.payload),
    })),
    provides: {
      entities: (app.provides?.entities ?? []).map((type) => ({
        id: type.id,
        title: type.title,
        standard: type.standard ?? false,
        state: z.toJSONSchema(type.state),
      })),
      widgets: (app.provides?.widgets ?? []).map((widget) => ({
        ...widgetInfo(widget),
        // As checked, so its words are trimmed as their length was measured.
        preview: widgetContent.parse(widget.preview),
      })),
      roomSections: (app.provides?.roomSections ?? []).map((section) => ({
        ...roomSectionInfo(section),
        // As checked, so a name is trimmed as its length was measured.
        preview: section.preview
          ? section.preview.map((tile) => sampleTile.parse(tile))
          : null,
      })),
      devicePages: (app.provides?.devicePages ?? []).map(devicePageInfo),
      triggers: (app.provides?.triggers ?? []).map((trigger) => ({
        id: trigger.id,
        title: trigger.title,
        event: trigger.event.id,
        config: z.toJSONSchema(trigger.config, { io: "input" }),
        words: trigger.words ?? null,
        needs: [...(trigger.needs ?? [])],
      })),
      conditions: (app.provides?.conditions ?? []).map(pieceOfAction),
      steps: (app.provides?.steps ?? []).map(pieceOfAction),
    },
  };
}

// A condition or step in the manifest: its action, by its id.
function pieceOfAction({ id, words, needs }: ActionDefinition) {
  return { id, words: words ?? null, needs: [...(needs ?? [])] };
}

/** An app's sanctum-app.json, as toStaticManifest() writes it. */
export type StaticManifest = ReturnType<typeof toStaticManifest> & {
  /**
   * The oldest version of its pages that work with it, once a version has taken
   * something away. `pnpm manifest` keeps this, from the committed file.
   */
  oldestPage?: string;
};

/**
 * The type an app's entities of `typeId` must have: the core's own
 * definition for a standard type, whatever copy of this SDK the app brings,
 * the app's own, or a widget's, whose entities hold its cards.
 */
export function entityTypeOf(
  app: AppDefinition,
  typeId: string,
): EntityTypeDefinition | undefined {
  const widget = app.provides?.widgets?.find((each) => each.id === typeId);
  if (widget) return widgetEntityType(widget, app);
  const declared = app.provides?.entities?.find((type) => type.id === typeId);
  if (!declared) return undefined;
  return standardEntityTypes.find((type) => type.id === typeId) ?? declared;
}

/** Every type the app's entities may have: those it declares, and its widgets'. */
export function entityTypesOf(app: AppDefinition): EntityTypeDefinition[] {
  return [
    ...(app.provides?.entities ?? []),
    ...(app.provides?.widgets ?? []),
  ].map((each) => entityTypeOf(app, each.id)!);
}

function assertProvides(app: AppDefinition) {
  const provides = app.provides ?? {};
  if (typeof provides !== "object") {
    throw new Error("An app's provides must be an object");
  }
  const types = provides.entities ?? [];
  const widgets = provides.widgets ?? [];
  if (!Array.isArray(types) || !Array.isArray(widgets)) {
    throw new Error("An app provides lists of entity types and widgets");
  }
  for (const type of types) {
    const id = String(type?.id);
    if (!type || typeof type.title !== "string" || !isSchema(type.state)) {
      throw new Error(`Entity type "${id}" needs a title and a state schema`);
    }
    const standard = standardEntityTypes.some((each) => each.id === type.id);
    if (standard !== (type.standard === true)) {
      throw new Error(
        standard
          ? `"${id}" is a standard entity type: use the core's definition`
          : `"${id}" is not one of the core's standard entity types`,
      );
    }
    if (!standard && !memberId.test(id)) {
      throw new Error(
        `Entity type "${id}" must be namespaced, such as naturalLight.target`,
      );
    }
  }
  assertUniqueIds(
    "entity type",
    types.map((type) => type.id),
  );
  // A widget's id is the type of the entities that hold its cards.
  assertWidgets(app, [
    ...types.map((type) => type.id),
    ...standardEntityTypes.map((type) => type.id),
  ]);
  assertUniqueIds(
    "widget",
    widgets.map((widget) => widget.id),
  );
}

// The JSON Schema properties of an object schema, or none for anything else.
function propertiesOf(schema: z.ZodType, io: "input" | "output") {
  try {
    const json = z.toJSONSchema(schema, { io }) as {
      type?: unknown;
      properties?: Record<string, unknown>;
    };
    return json.type === "object" ? Object.keys(json.properties ?? {}) : null;
  } catch {
    return null;
  }
}

// Its workflow pieces: each condition and step is one of its own actions,
// and each trigger one of its own events, whose config filters only fields
// the event's payload has.
function assertWorkflowPieces(app: AppDefinition) {
  const provides = app.provides ?? {};
  const ownActions = new Set(app.actions);
  const ownEvents = new Set(app.events);
  for (const kind of ["conditions", "steps"] as const) {
    const listed = provides[kind] ?? [];
    if (!Array.isArray(listed)) {
      throw new Error(`An app's ${kind} must be a list of its actions`);
    }
    for (const action of listed) {
      if (!ownActions.has(action)) {
        throw new Error(
          `"${String(action?.id)}" is listed as one of its ${kind} but is not one of its actions`,
        );
      }
    }
    assertUniqueIds(
      kind.slice(0, -1),
      listed.map((action) => action.id),
    );
  }
  for (const condition of provides.conditions ?? []) {
    if (condition.tier !== "read") {
      throw new Error(`"${condition.id}" is a condition, so it must be read`);
    }
    let answers: unknown;
    try {
      answers = (z.toJSONSchema(condition.output) as { type?: unknown }).type;
    } catch {
      answers = undefined;
    }
    if (answers !== "boolean") {
      throw new Error(
        `"${condition.id}" is a condition, so it answers a boolean`,
      );
    }
  }
  const triggers = provides.triggers ?? [];
  if (!Array.isArray(triggers)) {
    throw new Error("An app's triggers must be a list");
  }
  for (const trigger of triggers) {
    const id = String(trigger?.id);
    if (!memberId.test(id)) {
      throw new Error(`"${id}" must be namespaced, such as example.itemAdded`);
    }
    if (typeof trigger.title !== "string" || !trigger.title.trim()) {
      throw new Error(`"${id}" needs a title`);
    }
    if (!ownEvents.has(trigger.event)) {
      throw new Error(`"${id}" must trigger on one of the app's own events`);
    }
    if (!isSchema(trigger.config)) {
      throw new Error(`"${id}" needs a config schema`);
    }
    const fields = propertiesOf(trigger.config, "input");
    const payload = propertiesOf(trigger.event.payload, "output");
    if (!fields || !payload) {
      throw new Error(`"${id}" and its event need object schemas`);
    }
    const unknown = fields.filter((field) => !payload.includes(field));
    if (unknown.length > 0) {
      throw new Error(
        `"${id}" filters on ${unknown.join(", ")}, which its event's payload does not have`,
      );
    }
  }
  assertUniqueIds(
    "trigger",
    triggers.map((trigger) => trigger.id),
  );
  // A preview gives the words' every token a sample value, and nothing
  // else one; a piece needs only optional permissions its app asks for.
  for (const piece of [
    ...triggers,
    ...(provides.conditions ?? []),
    ...(provides.steps ?? []),
  ]) {
    const problems = [
      ...previewProblems(piece.words),
      ...needsProblems(piece.needs, app.permissions),
    ];
    if (problems.length > 0) {
      throw new Error(`"${piece.id}": ${problems.join("; ")}`);
    }
  }
}

function isSchema(value: unknown) {
  return typeof (value as z.ZodType | undefined)?.safeParse === "function";
}

function assertAction(action: ActionDefinition) {
  const id = String(action?.id);
  if (
    !action ||
    typeof action !== "object" ||
    !isSchema(action.input) ||
    !isSchema(action.output) ||
    typeof action.run !== "function"
  ) {
    throw new Error(
      `"${id}" needs input and output schemas and a run function`,
    );
  }
  if (!tierSchema.safeParse(action.tier).success) {
    throw new Error(`"${id}" needs a tier: ${tierSchema.options.join(", ")}`);
  }
}

function assertUniqueIds(kind: string, ids: readonly string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${kind} id "${id}"`);
    }
    seen.add(id);
  }
}
