import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { z } from "zod";

import {
  fitsPictureBudget,
  maxBlobBytes,
  maxBlobSide,
  pictureSize,
  type AppBlob,
  type BlobOnTheWire,
  type PutBlob,
} from "./blobs.js";
import type {
  CoreEventHandler,
  CoreEventHandlers,
  CoreEventName,
} from "./core-events.js";
import type {
  CapabilityInfo,
  DeviceCommand,
  DeviceInfo,
  DevicePresence,
  DevicePress,
  DeviceRelease,
  DeviceReport,
} from "./devices.js";
import type { DeviceProblemReport } from "./device-problems.js";
import type { DeviceRegistration } from "./device-registration.js";
import type { FoundReport } from "./found-devices.js";
import type { EntityInfo, EntityPublication } from "./entities.js";
import { entityTypeOf, type AppDefinition } from "./index.js";
import { settingsAsRead } from "./settings.js";
import type { DeviceFirmware } from "./firmware.js";
import type {
  ActionDefinition,
  ActionInput,
  Actor,
  EventDefinition,
} from "./index.js";
import type { HostResources } from "./host.js";
import { modelAnswerOf } from "./model-answers.js";
import type { AiToolAnswer } from "./ai-agents.js";
import type {
  ModelAnswer,
  ModelAnswerPiece,
  ModelQuestion,
  ModelSourceShown,
  ModelTool,
} from "./models.js";
import type { NetRequest, NetResponse } from "./net.js";
import type { DeviceJoining } from "./pairing.js";
import type { PersonInfo } from "./people.js";
import type { HomeLocation, Places } from "./places.js";
import type { AppSettings } from "./settings.js";
import type { WidgetContent, WidgetDefinition } from "./widgets.js";
import type {
  Job,
  JobRequest,
  JobWhen,
  KeptWorkflowRequest,
  WorkflowInfo,
} from "./workflows.js";

// What an app gets from the core, and the calls it is built on. Every call
// crosses the boundary as a message: it is async and takes and returns
// JSON-serializable data, so the same app code runs in its own container and
// against the testkit's fake core. The core's events cross as data too: the
// handlers an app follows them with stay on its side.

/** One SQL statement for the app's own database, as Drizzle's sqlite-proxy driver sends it. */
export type StorageQuery = {
  sql: string;
  params: unknown[];
  method: "run" | "all" | "values" | "get";
};

/** Rows as arrays of values; for `get`, one row or none. */
export type StorageResult = { rows?: unknown[] };

/** What the app needs to use a service the manager runs for it, such as its own broker account. */
export type ServiceConnection = {
  readonly mqtt?: {
    readonly url: string;
    readonly username: string;
    readonly password: string;
    readonly topics: readonly string[];
  };
  /** Where a service answers over HTTP, as Ollama does, on a network the app shares only with it. */
  readonly http?: { readonly url: string };
  readonly [detail: string]: unknown;
};

/**
 * The calls an app makes into the core. The core checks each one against
 * the app's permissions and, where a person or client is behind the call,
 * against what that actor may do; a refusal arrives as an ActionError.
 */
export interface CoreCalls {
  /** Runs one statement on the app's own database file, and nowhere else. */
  query(query: StorageQuery): Promise<StorageResult>;
  /** The connection details of a service the app holds `services:<name>` for. */
  serviceConnection(name: string): Promise<ServiceConnection>;
  /** The app's own settings, with its schema's defaults. */
  settings(): Promise<AppSettings>;
  /** What the household lets the app do now: the permissions it asks for that are granted. */
  permissions(): Promise<string[]>;
  /** A number that grows each time what the app may do changes. */
  permissionsRevision(): Promise<number>;
  people(): Promise<PersonInfo[]>;
  places(): Promise<Places>;
  location(): Promise<HomeLocation | null>;
  devices(): Promise<DeviceInfo[]>;
  device(id: string): Promise<DeviceInfo>;
  command(command: DeviceCommand): Promise<CapabilityInfo>;
  register(registration: DeviceRegistration): Promise<{ id: string }>;
  report(report: DeviceReport): Promise<void>;
  present(presence: DevicePresence): Promise<void>;
  press(press: DevicePress): Promise<void>;
  release(release: DeviceRelease): Promise<void>;
  firmware(firmware: DeviceFirmware): Promise<void>;
  /** Emits one of the app's own events, by its id. */
  emit(event: { event: string; payload: unknown }): Promise<void>;
  /**
   * Has the core hand the app one of its events by name, from the start
   * context only; it needs the permission to read what the event is about.
   */
  follow(name: string): Promise<void>;
  /** Schedules one of the app's own actions, which needs no permission. */
  scheduleJob(job: JobRequest): Promise<Job>;
  cancelJob(key: string): Promise<void>;
  jobs(): Promise<Job[]>;
  /** Keeps one of the app's workflows by its key; needs `workflows.manage`. */
  putWorkflow(workflow: KeptWorkflowRequest): Promise<WorkflowInfo>;
  removeWorkflow(key: string): Promise<void>;
  workflows(): Promise<WorkflowInfo[]>;
  publish(entity: EntityPublication): Promise<void>;
  unpublish(key: string): Promise<void>;
  entities(type: string): Promise<EntityInfo[]>;
  fetch(request: NetRequest): Promise<NetResponse>;
  joining(joining: DeviceJoining): Promise<void>;
  problem(problem: DeviceProblemReport): Promise<void>;
  found(found: FoundReport[]): Promise<void>;
  /** One of the app's own secrets by its name, or null when it has none by that name. */
  secret(name: string): Promise<string | null>;
  /** Keeps one of the app's own secrets, replacing what it kept by that name. */
  putSecret(secret: AppSecret): Promise<void>;
  removeSecret(name: string): Promise<void>;
  /** Hands the core a blob, its bytes in base64 (blobs.ts). */
  putBlob(blob: BlobOnTheWire): Promise<PutBlob>;
  /** The home's AI model in use, or null when there's none; needs `models.use`. */
  modelSource(): Promise<ModelSourceShown | null>;
  /** Starts an answer within the call's turn, and gives its handle; needs `models.use`. */
  openModel(question: ModelQuestion): Promise<{ handle: string }>;
  /** The answer's pieces after the first `after`, waiting a moment for one when there's none yet. */
  readModel(read: {
    handle: string;
    after: number;
  }): Promise<ModelAnswerPiece[]>;
  /** Stops an answer. */
  cancelModel(handle: string): Promise<void>;
  /** What the machine Sanctum runs on has now. */
  hostResources(): Promise<HostResources>;
  /** The tools AI agents may use now, but the app's own; needs `ai.assistant`. */
  aiTools(): Promise<ModelTool[]>;
  /** Calls one of them for whoever opened the turn; needs `ai.assistant`. */
  callAiTool(call: {
    name: string;
    input: Record<string, unknown>;
  }): Promise<AiToolAnswer>;
  log(message: string): void;
}

/** One of an app's own credentials, such as a device's key, by a name it chooses. */
export type AppSecret = { name: string; value: string };

/** The most secrets an app keeps. */
export const maxAppSecrets = 64;
/** The longest a secret's value is, in bytes of UTF-8. */
export const maxSecretBytes = 4_096;
/** What a secret's name may be: letters, digits and . _ : -, at most 128 of them. */
export const secretNamePattern = /^[A-Za-z0-9._:-]{1,128}$/;

/** The core API handed to app code. */
export interface AppContext {
  readonly appId: string;
  readonly actor: Actor;
  /** The app's own SQLite file, through Drizzle. */
  readonly storage: { readonly db: SqliteRemoteDatabase };
  readonly services: {
    connection(name: string): Promise<ServiceConnection>;
  };
  readonly settings: {
    /**
     * The app's own settings as the household chose them, with its schema's
     * defaults for the rest. Parse them with the schema for their types.
     */
    get(): Promise<AppSettings>;
  };
  readonly permissions: {
    /**
     * What the household lets the app do now: the permissions it asks for
     * that are granted. The core refuses what needs any other, and tells a
     * running app of a change with `permissions.changed`.
     */
    list(): Promise<string[]>;
    /**
     * A number that grows each time what the app may do changes, even back
     * again. A read that spans several calls compares it before and after,
     * to tell whether a change fell in between.
     */
    revision(): Promise<number>;
  };
  readonly people: {
    /** The household: names, avatars and colours; needs `people.read`. */
    list(): Promise<PersonInfo[]>;
  };
  readonly places: {
    /** The home, its floors, rooms and zones; needs `places.read`. */
    list(): Promise<Places>;
    /** Where the home is, or null until someone sets it; needs `places.location`. */
    location(): Promise<HomeLocation | null>;
  };
  readonly devices: {
    /** The devices with capabilities the app may read (`devices.read:<kind>`), showing only those. */
    list(): Promise<DeviceInfo[]>;
    /** One of them, now. */
    state(deviceId: string): Promise<DeviceInfo>;
    /**
     * Commands one capability of a device; needs `devices.control:<kind>`.
     * The core checks the actor too, through the permission gate.
     */
    command(command: DeviceCommand): Promise<CapabilityInfo>;
    /**
     * Brings one of a driver app's devices into the core, or updates it;
     * needs `devices.register`. Its key is the driver's own id for it.
     */
    register(registration: DeviceRegistration): Promise<{ id: string }>;
    /** Reports what one of the driver app's own devices said, by its key. */
    report(report: DeviceReport): Promise<void>;
    /**
     * Says which of the driver app's devices it still has, all of them, as
     * after its network's whole list: the core marks the others offline,
     * as when a device left while the driver was not running.
     */
    present(presence: DevicePresence): Promise<void>;
    /**
     * Says one of the driver app's devices was pressed, by its key: one of
     * the actions its button declares, once for each press, as it happens.
     * The core hands it to workflows, apps and live clients.
     */
    press(press: DevicePress): Promise<void>;
    /**
     * Says a hold of one of the driver app's devices ended, by its key: its
     * button was let go. The core ends what the hold set going, such as
     * lights brightening; a release is not a press.
     */
    release(release: DeviceRelease): Promise<void>;
    /**
     * Says what one of the driver app's devices' firmware is doing, by its
     * key, as the driver learns it: whether an update is available, an
     * update's progress, and how it ended; needs `devices.register`.
     */
    firmware(firmware: DeviceFirmware): Promise<void>;
    /**
     * Says how a device joining the driver's network is getting on, while
     * the core lets new devices join (driver.pairing); needs
     * `devices.register`.
     */
    joining(joining: DeviceJoining): Promise<void>;
    /**
     * Says what's wrong with one of the driver app's devices, by its key: one
     * of the problems it declares (driver.problems), or null once nothing
     * is. The core keeps it with the device, through restarts, and Needs
     * attention leads the device's row with it; needs `devices.register`.
     */
    problem(problem: DeviceProblemReport): Promise<void>;
    /**
     * Says which devices the driver app could add, all of them, replacing
     * what it said before: Add devices lists them, with what adding each
     * asks, until someone adds one (driver.add). One the home has is left
     * out. Needs `devices.register`.
     */
    found(found: FoundReport[]): Promise<void>;
  };
  readonly events: {
    /**
     * Emits one of the app's own events, which the core checks against its
     * schema. During an action call it goes out once the call succeeds.
     */
    emit<Payload extends z.ZodType>(
      event: EventDefinition<Payload>,
      payload: z.input<Payload>,
    ): Promise<void>;
    /**
     * Follows one of the core's events (core-events.ts) from the start
     * hook's context, until the app stops: the handler gets each one in
     * order, as the app's reads would show it. It needs the permission to
     * read what the event is about. Events reach a running app only, so an
     * app catches up from the current state in `start` too.
     */
    on<Name extends CoreEventName>(
      name: Name,
      handler: CoreEventHandler<Name>,
    ): Promise<void>;
  };
  /**
   * The app's own actions at times it chooses, kept by the core across
   * restarts; they touch only the app's own things, so they need no
   * permission. Each runs as the app itself.
   */
  readonly jobs: {
    /** Schedules a job by the app's own key, replacing one with that key. */
    schedule<Action extends ActionDefinition>(job: {
      key: string;
      action: Action;
      input: ActionInput<Action>;
      when: JobWhen;
      /**
       * Works out its next run afresh. Scheduled again as it was, it keeps its
       * next run, so a start that schedules all its jobs can't skip one that's due.
       */
      fresh?: boolean;
    }): Promise<Job>;
    cancel(key: string): Promise<void>;
    list(): Promise<Job[]>;
  };
  /**
   * Workflows the app keeps by its own keys, for presets it offers in its
   * pages, such as "this press runs this mood"; needs `workflows.manage`.
   * They use the core's pieces and the app's own, run like any workflow
   * while the app is installed, and change only through the app.
   */
  readonly workflows: {
    /** Keeps a workflow by its key, replacing the one it had, whose id stays. */
    put(
      key: string,
      workflow: Omit<KeptWorkflowRequest, "key">,
    ): Promise<WorkflowInfo>;
    remove(key: string): Promise<void>;
    list(): Promise<WorkflowInfo[]>;
  };
  /** What the app brings to the home, and what others bring. */
  readonly entities: {
    /**
     * Publishes one of the app's own entities by its key, of a type it
     * declares under `provides`. The core checks its state against the
     * type and keeps the latest, for clients and other apps to read.
     */
    publish(entity: EntityPublication): Promise<void>;
    /** Takes one of the app's entities out of the home. */
    remove(key: string): Promise<void>;
    /** The entities of a standard type, whichever apps provide them; needs `entities.read:<type>`. */
    list(type: string): Promise<EntityInfo[]>;
  };
  /**
   * The cards of its widgets (widgets.ts), which the shell draws: each an
   * entity of the widget's type by the app's own key, such as Weather's
   * card for the home.
   */
  readonly widgets: {
    /**
     * Shows one of its widgets' cards by its key, replacing what it said.
     * The core checks it against the card's shape, and that what it runs
     * and opens is the app's.
     */
    show(
      widget: WidgetDefinition,
      key: string,
      content: WidgetContent,
    ): Promise<void>;
    /** Takes a card off every dashboard. */
    hide(key: string): Promise<void>;
  };
  readonly net: {
    /** An HTTPS request to a host the app holds `net:<host>` for. */
    fetch(request: NetRequest): Promise<NetResponse>;
  };
  /**
   * The app's own credentials, such as its devices' keys, which need no
   * permission. The core keeps them encrypted, never shows them to anyone
   * and keeps them as long as it keeps the app's database. Setting one is on
   * the disk once it returns, so a key saved before it's sent to a device
   * outlasts a power cut. At most 64, of up to 4 KB each.
   */
  readonly secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  /**
   * Bytes for the core to keep and give clients, such as a picture of what
   * a media player plays (blobs.ts), for a driver holding devices.register:
   * a JPEG, PNG or WebP of up to 700 KB. It answers the blob's hash, which
   * a device's state names it by; the same bytes give the same hash.
   */
  readonly blobs: {
    put(blob: AppBlob): Promise<PutBlob>;
  };
  /**
   * The home's AI model, the one the household chose in Settings; needs
   * `models.use`. The core asks it for the app, which never learns its
   * address or key. An answer needs a turn: only an action that declares
   * `turn: true`, called by a person or a shared device, opens one, and
   * anything else is refused `no_turn`. A turn asks for at most
   * `turnLimits.answers` answers, refused `limited` after that.
   */
  readonly models: {
    /** The source in use, by name and model, or null when there's none. */
    source(): Promise<ModelSourceShown | null>;
    /**
     * Asks the model, and gives the answer at once, to read in pieces as
     * they come. Messages stay in order and tools are sorted by name.
     */
    answer(question: ModelQuestion): ModelAnswer;
  };
  /**
   * The tools every AI agent gets, for an app the household lets act as
   * its AI assistant; needs `ai.assistant`. They are the tools and answers
   * MCP agents get, held to the same switches in What AI Agents Can Use,
   * never the app's own. As with `ctx.models`, a request outside a turn is
   * refused `no_turn`. Each call runs for whoever opened the turn, while
   * they are still in the home. Answers are the home's data, never
   * instructions.
   */
  readonly ai: {
    /**
     * Up to 64 tools ready for `ctx.models.answer`. Names must be 1–64 ASCII
     * letters, digits, underscores or hyphens. Descriptions are shortened
     * to 2,048 characters. A listing counts toward the request limit and
     * rejects with `limited` when that limit is reached.
     */
    list(): Promise<ModelTool[]>;
    /** Calls one. Tool refusals, limits and failures set `isError`. */
    call(name: string, input?: Record<string, unknown>): Promise<AiToolAnswer>;
  };
  readonly host: {
    /**
     * What the machine Sanctum runs on has now: its processor, and the
     * memory and storage it has free.
     */
    resources(): Promise<HostResources>;
  };
  log(message: string): void;
}

// What the app's own schema makes of a value, or why it refuses it. A schema's
// transform or refinement is app code, and may throw.
function fits(schema: z.ZodType, value: unknown, refusal: string) {
  let parsed;
  try {
    parsed = schema.safeParse(value);
  } catch (error) {
    throw new Error(
      `${refusal}: its schema failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!parsed.success) {
    throw new Error(`${refusal}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Builds an app's context for one call on top of the core's calls. Only the
 * start hook's context has `handlers`, where ctx.events.on() keeps them.
 */
export function createAppContext(options: {
  appId: string;
  actor: Actor;
  core: CoreCalls;
  handlers?: CoreEventHandlers;
  // The app, whose own schemas parse what it reads and writes here: their
  // refinements, defaults and transforms only it can run, and the core checks
  // what results against its manifest.
  app?: AppDefinition;
}): AppContext {
  const { core, handlers, app, appId } = options;
  const publish = (entity: EntityPublication) => {
    const type = app && entityTypeOf(app, entity.type);
    return core.publish(
      type
        ? {
            ...entity,
            state: fits(
              type.state,
              entity.state,
              `${appId}'s ${entity.key} does not fit ${type.id}`,
            ),
          }
        : entity,
    );
  };
  return {
    appId: options.appId,
    actor: options.actor,
    storage: {
      db: drizzle(async (sql, params, method) => {
        const { rows } = await core.query({ sql, params, method });
        // `get` answers with no row at all when nothing matched, which
        // Drizzle expects.
        return { rows: rows as unknown[] };
      }),
    },
    services: { connection: (name) => core.serviceConnection(name) },
    settings: {
      get: async () => {
        const chosen = await core.settings();
        return app?.settings ? settingsAsRead(app.settings, chosen) : chosen;
      },
    },
    permissions: {
      list: () => core.permissions(),
      revision: () => core.permissionsRevision(),
    },
    people: { list: () => core.people() },
    places: { list: () => core.places(), location: () => core.location() },
    devices: {
      list: () => core.devices(),
      state: (deviceId) => core.device(deviceId),
      command: (command) => core.command(command),
      register: (registration) => core.register(registration),
      report: (report) => core.report(report),
      present: (presence) => core.present(presence),
      press: (press) => core.press(press),
      release: (release) => core.release(release),
      firmware: (firmware) => core.firmware(firmware),
      joining: (joining) => core.joining(joining),
      problem: (problem) => core.problem(problem),
      found: (found) => core.found(found),
    },
    events: {
      emit: async (event, payload) =>
        core.emit({
          event: event.id,
          payload: fits(
            event.payload,
            payload,
            `${event.id}'s payload does not fit its schema`,
          ),
        }),
      // Kept before the core is asked, so no event can arrive first.
      async on(name, handler) {
        if (!handlers) {
          throw new Error("Only the start hook's context follows events");
        }
        // Each handler only ever gets events of its own name.
        const each = handler as unknown as CoreEventHandler;
        handlers.set(name, [...(handlers.get(name) ?? []), each]);
        try {
          await core.follow(name);
        } catch (error) {
          handlers.set(
            name,
            (handlers.get(name) ?? []).filter((kept) => kept !== each),
          );
          throw error;
        }
      },
    },
    jobs: {
      schedule: async ({ key, action, input, when, fresh }) => {
        fits(
          action.input,
          input,
          `The input of job ${key} does not fit ${action.id}`,
        );
        return core.scheduleJob({
          key,
          action: action.id,
          input,
          when,
          ...(fresh ? { fresh } : {}),
        });
      },
      cancel: (key) => core.cancelJob(key),
      list: () => core.jobs(),
    },
    workflows: {
      put: (key, workflow) => core.putWorkflow({ ...workflow, key }),
      remove: (key) => core.removeWorkflow(key),
      list: () => core.workflows(),
    },
    entities: {
      publish: async (entity) => publish(entity),
      remove: (key) => core.unpublish(key),
      list: (type) => core.entities(type),
    },
    widgets: {
      show: async (widget, key, content) =>
        publish({
          type: widget.id,
          key,
          name: widget.title,
          state: content,
        }),
      hide: (key) => core.unpublish(key),
    },
    net: { fetch: (request) => core.fetch(request) },
    secrets: {
      get: (name) => core.secret(name),
      set: (name, value) => core.putSecret({ name, value }),
      delete: (name) => core.removeSecret(name),
    },
    blobs: {
      async put({ type, data }) {
        if (data.byteLength > maxBlobBytes) {
          throw new Error("A blob cannot exceed 700 KB");
        }
        const size = pictureSize(type, data);
        if (!size) {
          throw new Error(
            `A blob must be a still ${type} whose header gives its size`,
          );
        }
        if (!fitsPictureBudget(size)) {
          throw new Error(
            `A picture must be 1 to ${maxBlobSide} px on each side (this one is ${size.width} by ${size.height})`,
          );
        }
        return core.putBlob({
          type,
          data: Buffer.from(data).toString("base64"),
        });
      },
    },
    models: {
      source: () => core.modelSource(),
      answer: (question) => modelAnswerOf(core, question),
    },
    ai: {
      list: () => core.aiTools(),
      call: (name, input = {}) => core.callAiTool({ name, input }),
    },
    host: { resources: () => core.hostResources() },
    log: (message) => core.log(message),
  };
}
