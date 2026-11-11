import {
  createAppContext,
  type Actor,
  type AppContext,
  type CoreCalls,
} from "@meetsanctum/app-sdk";
import type { AppStorage } from "@meetsanctum/app-sdk/storage";
import { randomUUID } from "node:crypto";

import type { Devices } from "../devices/devices.js";
import type { Firmware } from "../devices/firmware.js";
import type { Pairing } from "../devices/pairing.js";
import type { Presses } from "../devices/presses.js";
import type { Entities } from "../entities/entities.js";
import type { People } from "../people/people.js";
import type { PlacesModule } from "../places/places.js";
import { createCoreCalls } from "./calls.js";
import { issuesText } from "./contract.js";
import type { CoreEvents } from "./core-events.js";
import { ActionCallError } from "./errors.js";
import type { AppEvent, JobCalls, KeptWorkflowCalls } from "./host.js";
import type { InstalledApp } from "./installed.js";
import type { NetFetch } from "./net.js";
import type { AppSettingsStore } from "./settings.js";
import type { ReadSnapshot } from "./snapshot.js";

// What each call of an app's code gets from the core: a context acting as
// `actor`, with the calls its permissions allow (calls.ts), and the checks on
// what it emits.

// Where a running app's start context keeps its handlers for the core's
// events, and how it follows one.
export type Following = ReturnType<CoreEvents["start"]>;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createAppContexts(options: {
  people: Pick<People, "list">;
  places: Pick<PlacesModule, "list" | "location">;
  devices: Devices;
  entities: Entities;
  presses: () => Pick<Presses, "press" | "released">;
  firmware: () => Pick<Firmware, "report">;
  onEvent?: (event: AppEvent) => void;
  jobs?: JobCalls;
  workflows?: KeptWorkflowCalls;
  settings: AppSettingsStore;
  net: NetFetch;
  pairing: () => Pick<Pairing, "joining">;
  log: (message: string) => void;
  now: () => Date;
  // Whether someone turned an app off: other apps don't read what it brought.
  isOff: (appId: string) => boolean;
}) {
  const { log, now } = options;
  // The core's calls behind each context, which an app apart's calls back are
  // tied to by the id of the call they came with.
  const cores = new WeakMap<AppContext, CoreCalls>();
  const deadlines = new WeakMap<AppContext, number>();

  const withoutThoseOff = (entities: Entities): Entities => ({
    ...entities,
    list: (filter) =>
      entities.list(filter).filter((entity) => !options.isOff(entity.app)),
  });

  // An app's settings as it reads them. Its schema is app code too, and a
  // schema that throws answers nothing.
  function settingsOf(entry: InstalledApp) {
    try {
      return options.settings.of(entry.manifest.id, entry.manifest.settings);
    } catch (error) {
      log(`apps: ${entry.app.id}'s settings failed (${message(error)})`);
      throw new ActionCallError("app_failed");
    }
  }

  // Checks an event an app emits against its declared schema, as the core
  // hands it on.
  function emitted(entry: InstalledApp, input: unknown): AppEvent {
    const { event: id, payload } = (input ?? {}) as {
      event?: unknown;
      payload?: unknown;
    };
    const check =
      typeof id === "string" ? entry.contract.events.get(id) : undefined;
    if (!check) {
      throw new Error(`${entry.app.id} has no event ${String(id)}`);
    }
    const checked = check(payload);
    if (!checked.success) {
      throw new Error(
        `${String(id)}'s payload does not fit its schema: ${issuesText(checked.issues)}`,
      );
    }
    return {
      id: randomUUID(),
      app: entry.app.id,
      event: String(id),
      payload: checked.data,
      at: now(),
    };
  }

  function deliver(events: readonly AppEvent[]) {
    for (const event of events) {
      try {
        options.onEvent?.(event);
      } catch (error) {
        log(`apps: ${event.event} was not handed on (${message(error)})`);
      }
    }
  }

  // A context for app code, acting as `actor`, with the calls into the
  // core that its permissions allow (calls.ts). Events emitted through it
  // wait in `held` when given, for an action call that has yet to succeed,
  // and go out at once otherwise. Only the start context is `following`
  // the core's events, and an app apart's reads from a `snapshot` meanwhile.
  function contextFor(
    entry: InstalledApp,
    actor: Actor,
    storage: ReturnType<AppStorage["call"]>,
    {
      held,
      following,
      snapshot,
      withinMs,
    }: {
      held?: AppEvent[];
      following?: Following;
      snapshot?: ReadSnapshot;
      withinMs?: number;
    } = {},
  ) {
    const appId = entry.app.id;
    const core = createCoreCalls({
      appId,
      actor,
      permissions: () => entry.granted,
      permissionsRevision: () => entry.grantsRevision,
      query: storage.query,
      ended: () => storage.ended,
      services: entry.services,
      claims: () => entry.updating?.claims,
      people: snapshot?.people ?? options.people,
      places: snapshot?.places ?? options.places,
      devices: snapshot?.devices ?? options.devices,
      presses: {
        press: (driver, press) => options.presses().press(driver, press),
        released: (driver, release) =>
          options.presses().released(driver, release),
      },
      firmware: {
        report: (driver, said) => options.firmware().report(driver, said),
      },
      emit(input) {
        const event = emitted(entry, input);
        if (held) {
          held.push(event);
        } else {
          deliver([event]);
        }
      },
      follow: following?.follow,
      jobs: options.jobs,
      workflows: options.workflows,
      entities: withoutThoseOff(snapshot?.entities ?? options.entities),
      entityType: (typeId) => entry.contract.entityTypes.get(typeId),
      isTileType: (typeId) =>
        entry.manifest.provides.roomSections.some(
          (section) => section.entityType === typeId,
        ),
      settings: () => settingsOf(entry),
      net: options.net,
      watch: (permission) => entry.requests.watch(permission),
      pairing: options.pairing,
      log: (text) => log(`${appId}: ${text}`),
    });
    const ctx = createAppContext({
      appId,
      actor,
      // An app apart's own schemas are on its side of the socket.
      ...(entry.link ? {} : { app: entry.app }),
      handlers: following?.handlers,
      core,
    });
    cores.set(ctx, core);
    if (withinMs !== undefined) deadlines.set(ctx, Date.now() + withinMs);
    return ctx;
  }

  return {
    settingsOf,
    deliver,
    contextFor,
    coreOf: (ctx: AppContext) => cores.get(ctx)!,
    timeLeft(ctx: AppContext) {
      const deadline = deadlines.get(ctx);
      return deadline === undefined
        ? undefined
        : Math.max(1, deadline - Date.now());
    },
  };
}

export type AppContexts = ReturnType<typeof createAppContexts>;
