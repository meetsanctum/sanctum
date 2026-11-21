import {
  ActionError,
  actionErrorCodes,
  capabilityKinds,
  controlPermission,
  coreEventNames,
  entityReadPermission,
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
  type AppSettings,
  type CoreCalls,
  type CoreEventName,
  type DeviceInfo,
  type ServiceConnection,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

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
import type { NetFetch, NetHolds } from "./net.js";
import { secretName, secretValue, type AppSecrets } from "./secrets.js";

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
  places: Pick<PlacesModule, "list" | "location">;
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
  // What AI agents can use, which an AI agent's call holds to.
  agents: Pick<AgentsCanUse, "areaOn" | "canUse" | "readableDeviceKinds">;
  log: (message: string) => void;
}): CoreCalls {
  const { appId, actor, devices, agents } = options;
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

  function need(permission: string) {
    if (options.ended()) {
      throw new Error(`This call to ${appId} has ended`);
    }
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
    if (options.ended()) {
      throw new Error(`This call to ${appId} has ended`);
    }
  }

  function named(name: unknown) {
    const parsed = secretName.safeParse(name);
    if (!parsed.success) {
      throw new Error(`${appId} named a secret the core cannot keep`);
    }
    return parsed.data;
  }

  function readsDevices() {
    if (options.ended()) {
      throw new Error(`This call to ${appId} has ended`);
    }
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
      return devices.register(appId, registration);
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

    log: options.log,
  };
}
