import {
  aiAssistantPermission,
  aiToolCallSchema,
  assistantAppId,
  speechLanguages,
  requestReplySchema,
  blobOf,
  ActionError,
  actionErrorCodes,
  capabilityKinds,
  controlPermission,
  coreEventNames,
  entityReadPermission,
  modelsUsePermission,
  peopleReadPermission,
  placesLocationPermission,
  placesReadPermission,
  readPermission,
  registerPermission,
  roomSectionTile,
  standardEntityTypes,
  workflowsManagePermission,
  type ActionErrorCode,
  type Actor,
  type AiToolAnswer,
  type RequestReply,
  type AppSettings,
  type CoreCalls,
  type CoreEventName,
  type DeviceInfo,
  type HostResources,
  type ModelSourceShown,
  type ServiceConnection,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { AssistantCalls, TurnOpener } from "../agents/assistants.js";
import type { AgentsCanUse } from "../agents/can-use.js";
import type { Claims } from "./commits.js";
import { issuesText, type DeclaredEntityType } from "./contract.js";
import { personInfo } from "../auth/logins.js";
import type { Devices } from "../devices/devices.js";
import type { View } from "../devices/views.js";
import type { Pairing } from "../devices/pairing.js";
import type { Firmware } from "../devices/firmware.js";
import type { Presses } from "../devices/presses.js";
import type { Entities } from "../entities/entities.js";
import type { People } from "../people/people.js";
import type { PlacesModule } from "../places/places.js";
import { ActionCallError } from "./errors.js";
import type { JobCalls, KeptWorkflowCalls } from "./app-work.js";
import type { Turn } from "../models/turns.js";
import type { NetFetch, NetHolds } from "./net.js";
import type { Blobs } from "../blobs/blobs.js";
import type { Listening } from "../speech/listening.js";
import { secretName, secretValue, type AppSecrets } from "./secrets.js";

// The protocol whose apps may say a reply is a confirmation.
const confirmationFrom = 26;

const speechLanguageSchema = z.strictObject({
  language: z.enum(speechLanguages),
});

const isTurnOpener = (
  actor: Actor,
): actor is Extract<TurnOpener, { kind: "user" | "client" }> =>
  actor.kind === "user" || actor.kind === "client";

// The calls an app makes into the core, for one app and one actor. Two
// checks always apply: the app must hold the permission, and the actor must
// be allowed what the call does. A missing permission is the app's mistake
// and fails it; a refusal for the actor reaches the app as an ActionError it
// may handle, and answers its caller if it does not.
//
// An AI agent's call holds what AI agents can use all the way through: the
// app sees only the devices, people and other apps' entities the household
// lets AI agents use, and can't register devices, let them join, or leave
// jobs and workflows behind that outlive the call.

/**
 * What an app sees of the home's devices: the kinds it may read, and, for a
 * driver, the devices it brings, whole.
 */
export function deviceViewOf(appId: string, permissions: readonly string[]) {
  return {
    kinds: deviceKinds(permissions).reads,
    ...(permissions.includes(registerPermission) ? { own: appId } : {}),
  };
}

/** The capability kinds an app may read and control. Controlling a kind includes reading it. */
export function deviceKinds(permissions: readonly string[]) {
  const controls = new Set(
    capabilityKinds.filter((kind) =>
      permissions.includes(controlPermission(kind)),
    ),
  );
  const reads = new Set(
    capabilityKinds.filter(
      (kind) =>
        controls.has(kind) || permissions.includes(readPermission(kind)),
    ),
  );
  return { reads, controls };
}

/** The standard entity types an app may read. */
export function entityTypes(permissions: readonly string[]) {
  return standardEntityTypes
    .map((type) => type.id)
    .filter((type) => permissions.includes(entityReadPermission(type)));
}

// Why an app may not follow one of the core's events (events-for-apps.ts), or
// null when it may read what the event is about: a driver hears of its own
// devices.
function followRefusal(name: CoreEventName, permissions: readonly string[]) {
  const [noun] = name.split(".");
  const { reads } = deviceKinds(permissions);
  if (name === "device.pressed" && !reads.has("button")) {
    return `does not hold ${readPermission("button")}`;
  }
  if (
    noun === "device" &&
    reads.size === 0 &&
    !permissions.includes(registerPermission)
  ) {
    return "holds no devices.read: permission";
  }
  if (noun === "place" && !permissions.includes(placesReadPermission)) {
    return `does not hold ${placesReadPermission}`;
  }
  if (noun === "location" && !permissions.includes(placesLocationPermission)) {
    return `does not hold ${placesLocationPermission}`;
  }
  if (noun === "person" && !permissions.includes(peopleReadPermission)) {
    return `does not hold ${peopleReadPermission}`;
  }
  // About the app itself, its permissions or its settings.
  if (noun === "permissions" || noun === "settings") {
    return null;
  }
  if (noun === "entity" && entityTypes(permissions).length === 0) {
    return "holds no entities.read: permission for a standard type";
  }
  return null;
}

const publication = z.object({
  type: z.string().min(1).max(128),
  key: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  state: z.unknown(),
});

function forApp(error: unknown) {
  if (error instanceof ActionCallError) {
    return actionErrorCodes.includes(error.code as ActionErrorCode)
      ? new ActionError(error.code as ActionErrorCode)
      : new Error(`The core could not carry the call out (${error.code})`);
  }
  return error;
}

export function createCoreCalls(options: {
  appId: string;
  actor: Actor;
  protocol?: number;
  // What the app may do now, its grants (grants.ts), read on every call.
  permissions: () => readonly string[];
  // Grows each time those grants change.
  permissionsRevision: () => number;
  query: CoreCalls["query"];
  // Whether the call this context belongs to is over, such as an action
  // that timed out or an app that stopped: then it changes nothing more.
  ended: () => boolean;
  services: ReadonlyMap<string, Promise<ServiceConnection>>;
  // What this start on a new version has claimed so far (commits.ts).
  claims?: () => Claims | undefined;
  people: Pick<People, "list">;
  places: Pick<PlacesModule, "list" | "location" | "clock" | "setLanguage">;
  devices: Devices;
  presses: Pick<Presses, "press" | "released">;
  firmware: Pick<Firmware, "report">;
  // What's wrong with the driver's devices, in the words of the problems its
  // manifest declares.
  problems: { report: (problem: unknown) => void };
  // Which devices the driver found and could add.
  found: { report: (found: unknown) => void };
  // Checks one of the app's own events and hands it on.
  emit: (event: unknown) => void;
  // Has the core hand the app one of its events; the start context's only.
  follow?: (name: CoreEventName) => void;
  jobs?: JobCalls;
  workflows?: KeptWorkflowCalls;
  entities: Entities;
  // The type the app declares for its entities of a type id.
  entityType: (typeId: string) => DeclaredEntityType | undefined;
  // Whether one of the app's room sections shows the type's entities, so
  // each must have the tile shape too.
  isTileType: (typeId: string) => boolean;
  // The app's own settings, with its schema's defaults.
  settings: () => AppSettings;
  net: NetFetch;
  // Its requests to the internet under way, which end with the permission
  // each needs.
  watch: NetHolds["watch"];
  pairing: () => Pick<Pairing, "joining">;
  secrets: AppSecrets;
  // The pictures drivers hand over (blobs/blobs.ts).
  blobs?: () => Blobs | undefined;
  // Smart speakers' runs, which drivers open (speech/listening.ts).
  listening?: Listening;
  // What AI agents can use, which an AI agent's call holds to.
  agents: Pick<AgentsCanUse, "areaOn" | "canUse" | "readableDeviceKinds">;
  // The home's AI model, and the turn this call opened, if it opened one.
  models: { source: () => ModelSourceShown | null; turn?: Turn };
  // The tools an assistant app calls, within the turn this call opened.
  assistant: AssistantCalls;
  // Who opened a request's turn, when that isn't the actor: a smart
  // speaker, which is never one.
  opener?: TurnOpener;
  requestClientId?: string;
  // How a request's reply reaches whoever asked, for the call that runs it.
  reply?: (reply: RequestReply) => void;
  // Keeps a request's tool call as it starts, and its answer, or null for a
  // refusal, as it ends.
  recordTool?: (
    name: string,
    input: Record<string, unknown>,
  ) => (answer: AiToolAnswer | null) => void;
  // What the machine Sanctum runs on has now.
  host: () => Promise<HostResources>;
  log: (message: string) => void;
}): CoreCalls {
  const { appId, actor, devices, agents } = options;
  // Whom an assistant app's tools act for within its turn.
  const opener = options.opener ?? (isTurnOpener(actor) ? actor : null);
  const permissions = options.permissions;
  const forAgent = actor.kind === "assistant-run";
  // An AI agent's call sees the kinds both the app and AI agents may read,
  // and a driver's own devices no more whole than any other.
  const view = (): View => {
    const appView = deviceViewOf(appId, permissions());
    if (!forAgent) return appView;
    const reads = agents.readableDeviceKinds();
    return {
      kinds: new Set([...appView.kinds].filter((kind) => reads.has(kind))),
      own: appView.own,
      ownKinds: reads,
    };
  };
  function notForAgents() {
    if (forAgent) throw new ActionError("forbidden");
  }
  // What a driver reads of its own devices carries the key it registered
  // each by.
  const keyed = (shown: DeviceInfo[]) => {
    if (!permissions().includes(registerPermission)) return shown;
    const keys = devices.keysOf(appId);
    return shown.map((device) => {
      const key = device.driver === appId ? keys.get(device.id) : undefined;
      return key ? { ...device, key } : device;
    });
  };

  // A call that's over changes nothing more. One of a turn says so with
  // `turn_ended`, which the Assistant tells apart from a failure.
  function stillOpen() {
    if (!options.ended()) return;
    if (options.models.turn) throw new ActionError("turn_ended");
    throw new Error(`This call to ${appId} has ended`);
  }

  function need(permission: string) {
    stillOpen();
    if (!permissions().includes(permission)) {
      throw new Error(`${appId} does not hold ${permission}`);
    }
  }

  function jobCalls() {
    if (!options.jobs) {
      throw new Error("This core keeps no jobs");
    }
    return options.jobs;
  }

  function keptWorkflows() {
    if (!options.workflows) {
      throw new Error("This core keeps no workflows for apps");
    }
    return options.workflows;
  }

  function open() {
    stillOpen();
  }

  function named(name: unknown) {
    const parsed = secretName.safeParse(name);
    if (!parsed.success) {
      throw new Error(`${appId} named a secret the core cannot keep`);
    }
    return parsed.data;
  }

  function readsDevices() {
    stillOpen();
    if (
      deviceKinds(permissions()).reads.size === 0 &&
      !permissions().includes(registerPermission)
    ) {
      throw new Error(`${appId} holds no devices.read: permission`);
    }
  }

  return {
    query: options.query,

    async serviceConnection(name) {
      need(`services:${name}`);
      const connection = options.services.get(name);
      if (!connection) {
        throw new Error(`${appId} does not hold services:${name}`);
      }
      const granted = await connection;
      need(`services:${name}`);
      return granted;
    },

    // What it may do now, and how often that changed, which need no
    // permission.
    async permissions() {
      open();
      return [...permissions()];
    },

    async permissionsRevision() {
      open();
      return options.permissionsRevision();
    },

    // Its own settings only, which need no permission.
    async settings() {
      open();
      try {
        return options.settings();
      } catch (error) {
        throw forApp(error);
      }
    },

    // Everyone signed in sees the household, shared clients too.
    async people() {
      need(peopleReadPermission);
      if (forAgent && !agents.areaOn(peopleReadPermission)) {
        throw new ActionError("forbidden");
      }
      return options.people.list().map(personInfo);
    },

    async places() {
      need(placesReadPermission);
      return options.places.list();
    },

    // The app's own grant, for an AI agent's call too: what the app works
    // out from it, such as natural light's curve, is what it offers.
    async location() {
      need(placesLocationPermission);
      return options.places.location();
    },

    async devices() {
      readsDevices();
      return keyed(devices.list(view()));
    },

    async device(id) {
      readsDevices();
      const device = typeof id === "string" ? devices.get(id, view()) : null;
      if (!device) {
        throw new ActionError("not_found");
      }
      return keyed([device])[0]!;
    },

    async command(request) {
      readsDevices();
      const device =
        typeof request?.device === "string"
          ? devices.get(request.device, view())
          : null;
      const capability = device?.capabilities.find(
        (each) => each.id === request.capability,
      );
      if (!capability) {
        throw new ActionError("not_found");
      }
      need(controlPermission(capability.kind));
      try {
        return await devices.command(actor, request, view(), appId);
      } catch (error) {
        throw forApp(error);
      }
    },

    async register(registration) {
      need(registerPermission);
      notForAgents();
      return devices.register(appId, registration, options.protocol);
    },

    async report(report) {
      need(registerPermission);
      devices.report(appId, report);
    },

    async present(presence) {
      need(registerPermission);
      devices.present(appId, presence);
    },

    async press(press) {
      need(registerPermission);
      options.presses.press(appId, press);
    },

    async release(release) {
      need(registerPermission);
      options.presses.released(appId, release);
    },

    async firmware(firmware) {
      need(registerPermission);
      options.firmware.report(appId, firmware);
    },

    async problem(problem) {
      need(registerPermission);
      options.problems.report(problem);
    },

    async found(found) {
      need(registerPermission);
      options.found.report(found);
    },

    async emit(event) {
      open();
      options.emit(event);
    },

    // One of the core's events, by the permission to read what it is about
    // (events-for-apps.ts).
    async follow(name) {
      open();
      if (!options.follow) {
        throw new Error(`Only ${appId}'s start context follows events`);
      }
      if (!coreEventNames.includes(name as CoreEventName)) {
        throw new Error(`${String(name)} is not one of the core's events`);
      }
      const refused = followRefusal(name as CoreEventName, permissions());
      if (refused) {
        throw new Error(`${appId} ${refused}, which ${name} needs`);
      }
      options.follow(name as CoreEventName);
    },

    // Its own jobs, which touch only its own actions and need no
    // permission, but outlive an AI agent's call.
    async scheduleJob(job) {
      open();
      notForAgents();
      const scheduled = jobCalls().schedule(appId, job);
      options.claims?.()?.jobs.add(scheduled.key);
      return scheduled;
    },

    async cancelJob(key) {
      open();
      notForAgents();
      jobCalls().cancel(appId, key);
      if (typeof key === "string") options.claims?.()?.jobs.delete(key);
    },

    async jobs() {
      open();
      return jobCalls().list(appId);
    },

    async putWorkflow(workflow) {
      need(workflowsManagePermission);
      notForAgents();
      const kept = keptWorkflows().put(appId, workflow);
      if (kept.appKey) options.claims?.()?.workflows.add(kept.appKey);
      return kept;
    },

    async removeWorkflow(key) {
      need(workflowsManagePermission);
      notForAgents();
      if (typeof key === "string") {
        keptWorkflows().remove(appId, key);
        options.claims?.()?.workflows.delete(key);
      }
    },

    async workflows() {
      need(workflowsManagePermission);
      return keptWorkflows().list(appId);
    },

    // An entity's state must fit the type the app declares, and a room
    // section's tile shape when one shows the type; a widget's card must
    // run and open only what is the app's. One that does not is the app's
    // mistake and fails it.
    async publish(input) {
      open();
      const entity = publication.safeParse(input);
      if (!entity.success) {
        throw new Error(`${appId} published an entity the core cannot keep`);
      }
      const type = options.entityType(entity.data.type);
      if (!type) {
        throw new Error(`${appId} does not provide ${entity.data.type}`);
      }
      const state = type.state(entity.data.state);
      if (!state.success) {
        throw new Error(
          `${appId}'s ${entity.data.key} does not fit ${type.id}: ${issuesText(state.issues)}`,
        );
      }
      if (options.isTileType(type.id)) {
        const tile = roomSectionTile.safeParse(state.data);
        if (!tile.success) {
          throw new Error(
            `${appId}'s ${entity.data.key} does not fit a room section's tile: ${z.prettifyError(tile.error)}`,
          );
        }
      }
      options.entities.publish(appId, { ...entity.data, state: state.data });
      options.claims?.()?.entities.add(entity.data.key);
    },

    async unpublish(key) {
      open();
      if (typeof key === "string") {
        options.entities.remove(appId, key);
        options.claims?.()?.entities.delete(key);
      }
    },

    // Other apps' entities, by standard type only.
    async entities(type) {
      need(entityReadPermission(type));
      if (!standardEntityTypes.some((standard) => standard.id === type)) {
        throw new Error(`${type} is not a standard entity type`);
      }
      const entities = options.entities.list({ type });
      return forAgent
        ? entities.filter((entity) => agents.canUse(entity.app, type, "entity"))
        : entities;
    },

    async fetch(request) {
      open();
      return options.net(appId, { permissions, watch: options.watch }, request);
    },

    async joining(joining) {
      need(registerPermission);
      notForAgents();
      options.pairing().joining(appId, joining);
    },

    // Its own secrets, which need no permission, as its own database needs
    // none. What's refused names neither the secret nor its value.
    async secret(name) {
      open();
      return options.secrets.get(appId, named(name));
    },

    async putSecret(secret) {
      open();
      const parsed = z
        .object({ name: secretName, value: secretValue })
        .safeParse(secret);
      if (!parsed.success) {
        throw new Error(`${appId} kept a secret the core cannot keep`);
      }
      options.secrets.put(appId, parsed.data.name, parsed.data.value);
    },

    async removeSecret(name) {
      open();
      options.secrets.remove(appId, named(name));
    },

    // A picture a driver hands over, such as of what a player plays, which
    // its devices' states then name by its hash. The socket is untrusted, so
    // what isn't a picture of its declared type is refused (blobOf).
    async putBlob(blob) {
      need(registerPermission);
      notForAgents();
      const blobs = options.blobs?.();
      const kept = blobOf(blob);
      if (!kept || !blobs) {
        throw new Error(`${appId} handed over a blob the core cannot keep`);
      }
      return { hash: blobs.put(appId, kept.type, kept.bytes) };
    },

    // The home's AI model answers only within a turn: an AI agent's call,
    // a workflow's, a job's or another app's has none.
    async modelSource() {
      need(modelsUsePermission);
      return options.models.source();
    },

    async openModel(question) {
      need(modelsUsePermission);
      const { turn } = options.models;
      if (!turn) throw new ActionError("no_turn");
      return {
        handle: turn.open(question, () => options.watch(modelsUsePermission)),
      };
    },

    async readModel(read) {
      need(modelsUsePermission);
      const { turn } = options.models;
      if (!turn) throw new ActionError("no_turn");
      const pieces = await turn.read(read?.handle, read?.after);
      need(modelsUsePermission);
      return pieces;
    },

    // The home's time zone and how it writes times, which every app's page
    // has in its frame already: it needs no permission.
    async homeClock() {
      open();
      const { timeZone, hourCycle } = options.places.clock();
      return { timeZone, hourCycle };
    },

    // What the host has: nothing private, so it needs no permission.
    async hostResources() {
      open();
      return options.host();
    },

    async cancelModel(handle) {
      need(modelsUsePermission);
      const { turn } = options.models;
      if (!turn) throw new ActionError("no_turn");
      turn.cancel(handle);
    },

    // A driver's smart speaker's run: only a driver opens one, for its own
    // device, and an AI agent's call never does (speech/listening.ts).
    async openListen(open) {
      need(registerPermission);
      notForAgents();
      if (!options.listening)
        return { accepted: false, refusal: "unavailable" };
      return options.listening.open(appId, open);
    },

    async sendListen(send) {
      need(registerPermission);
      notForAgents();
      if (!options.listening) throw new ActionError("not_found");
      options.listening.send(appId, send);
    },

    async readListen(read) {
      need(registerPermission);
      notForAgents();
      if (!options.listening) return [{ step: "done" }];
      return options.listening.read(appId, read);
    },

    async closeListen(close) {
      need(registerPermission);
      notForAgents();
      options.listening?.close(appId, close);
    },

    // Sanctum's Assistant answers the request its call runs for, once.
    async replyRequest(reply) {
      open();
      if (!options.reply) {
        throw new Error(`This call to ${appId} answers no request`);
      }
      // A confirmation is an app's from protocol 26, as it knows the field.
      const schema =
        (options.protocol ?? confirmationFrom) >= confirmationFrom
          ? requestReplySchema
          : requestReplySchema.omit({ confirmation: true });
      const parsed = schema.safeParse(reply);
      if (!parsed.success) {
        throw new Error("A reply is its words, up to 4,000 characters");
      }
      options.reply(parsed.data);
    },

    // The home's language for speech: Sanctum's Assistant sets it for
    // someone in the home, never on its own or for an AI agent.
    async setSpeechLanguage(set) {
      need(aiAssistantPermission);
      notForAgents();
      if (appId !== assistantAppId || !isTurnOpener(actor)) {
        throw new ActionError("forbidden");
      }
      const parsed = speechLanguageSchema.safeParse(set);
      if (!parsed.success) {
        throw new Error(
          `A language for speech is one of ${speechLanguages.join(", ")}`,
        );
      }
      if (!options.assistant.canActFor(actor)) {
        throw new ActionError("forbidden");
      }
      options.places.setLanguage(
        {
          actor: `app:${appId}`,
          ...(actor.kind === "user"
            ? { personId: actor.id }
            : { clientId: actor.id }),
        },
        parsed.data.language,
      );
    },

    // An assistant app's tools, as for an AI agent acting for whoever opened
    // the turn: a person or a shared device, the only callers that open one.
    async aiTools() {
      need(aiAssistantPermission);
      if (!options.models.turn || !opener) {
        throw new ActionError("no_turn");
      }
      return options.assistant.list(appId, opener);
    },

    async callAiTool(call) {
      need(aiAssistantPermission);
      if (!options.models.turn || !opener) {
        throw new ActionError("no_turn");
      }
      const parsed = aiToolCallSchema.safeParse(call);
      if (!parsed.success) {
        throw new Error("A tool's call is its name and an input object");
      }
      const answered = options.recordTool?.(
        parsed.data.name,
        parsed.data.input,
      );
      let answer: AiToolAnswer;
      try {
        answer = await options.assistant.call(
          appId,
          opener,
          parsed.data.name,
          parsed.data.input,
          options.ended,
          options.requestClientId,
        );
      } catch (error) {
        answered?.(null);
        throw error;
      }
      answered?.(answer);
      need(aiAssistantPermission);
      return answer;
    },

    log: options.log,
  };
}
