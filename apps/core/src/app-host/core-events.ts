import {
  peopleReadPermission,
  placesLocationPermission,
  placesReadPermission,
  type CoreEvent,
  type CoreEventHandlers,
  type CoreEventName,
  type DeviceInfo,
  type EntityInfo,
  type HomeLocation,
  type PersonInfo,
  type Place,
  type Places,
} from "@meetsanctum/app-sdk";

import { personInfo } from "../auth/logins.js";
import type { DeviceChange } from "../devices/devices.js";
import { viewOf } from "../devices/views.js";
import type { Press } from "../devices/presses.js";
import type { EntityChange } from "../entities/entities.js";
import type { PersonChange } from "../people/people.js";
import { deviceKinds, entityTypes } from "./calls.js";
import { TimedOut, withTimeout } from "./errors.js";

// The core's events for apps: what happens to devices, places, people and
// the entities of standard types, and remotes' presses, handed to each
// running app that follows it, as its reads would show it: a device with the
// capabilities it may read, entities of the types it may read. An app
// follows them from its start context and hears nothing once it stops; each
// app gets its events in order, one at a time, after the change has
// committed, and a handler that fails or takes too long is logged and holds
// up nothing else. Apps never hear each other's own events.

// What one change did, before and after; null where there was nothing.
type Change =
  | { noun: "device"; before: DeviceInfo | null; after: DeviceInfo | null }
  | { noun: "place"; before: Place | null; after: Place | null }
  | { noun: "person"; before: PersonInfo | null; after: PersonInfo | null }
  | { noun: "entity"; before: EntityInfo | null; after: EntityInfo | null };

// A change as one app may read it: what it shows before and after, each
// null where it shows nothing.
function shownTo(change: Change, permissions: readonly string[]): Change {
  switch (change.noun) {
    case "device": {
      const view = { kinds: deviceKinds(permissions).reads };
      return {
        noun: "device",
        before: change.before && viewOf(change.before, view),
        after: change.after && viewOf(change.after, view),
      };
    }
    case "entity": {
      const types = entityTypes(permissions);
      const seen = (entity: EntityInfo | null) =>
        entity && types.includes(entity.type) ? entity : null;
      return {
        noun: "entity",
        before: seen(change.before),
        after: seen(change.after),
      };
    }
    case "place":
      return permissions.includes(placesReadPermission)
        ? change
        : { noun: "place", before: null, after: null };
    case "person":
      return permissions.includes(peopleReadPermission)
        ? change
        : { noun: "person", before: null, after: null };
  }
}

// The events a change makes, as one app may read it.
function eventsOf(change: Change): CoreEvent[] {
  const { noun, before, after } = change;
  if (
    noun === "entity" &&
    before &&
    after &&
    (before as EntityInfo).type !== (after as EntityInfo).type
  ) {
    return [
      ...eventsOf({ noun, before, after: null }),
      ...eventsOf({ noun, before: null, after }),
    ];
  }
  if (!before && after) {
    return [{ name: `${noun}.added`, [noun]: after } as CoreEvent];
  }
  if (before && !after) {
    return [{ name: `${noun}.deleted`, [noun]: before } as CoreEvent];
  }
  if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
    return [{ name: `${noun}.changed`, [noun]: after, before } as CoreEvent];
  }
  return [];
}

// A queued event may outlive its grants. Narrow its original snapshot
// again for each handler, without turning lost access into a deletion or
// adding data that was not visible when the event happened.
function eventShownTo(
  event: CoreEvent,
  permissions: readonly string[],
): CoreEvent | undefined {
  if ("device" in event) {
    const view = { kinds: deviceKinds(permissions).reads };
    const device = viewOf(event.device, view);
    if (!device) return;
    if (
      event.name === "device.pressed" &&
      !device.capabilities.some((each) => each.id === event.capability)
    ) {
      return;
    }
    if (event.name === "device.changed") {
      const before = viewOf(event.before, view);
      if (!before || JSON.stringify(before) === JSON.stringify(device)) return;
      return { ...event, before, device };
    }
    return { ...event, device };
  }
  if ("place" in event && !permissions.includes(placesReadPermission)) return;
  if (
    event.name === "location.changed" &&
    !permissions.includes(placesLocationPermission)
  ) {
    return;
  }
  if ("person" in event && !permissions.includes(peopleReadPermission)) return;
  if (
    "entity" in event &&
    !entityTypes(permissions).includes(event.entity.type)
  ) {
    return;
  }
  return event;
}

// Every place by kind and id, the home first.
function placesOf(places: Places) {
  return new Map<string, Place>([
    ["home", { kind: "home", ...places.home }],
    ...places.floors.map((floor): [string, Place] => [
      `floor:${floor.id}`,
      { kind: "floor", ...floor },
    ]),
    ...places.rooms.map((room): [string, Place] => [
      `room:${room.id}`,
      { kind: "room", ...room },
    ]),
    ...places.zones.map((zone): [string, Place] => [
      `zone:${zone.id}`,
      { kind: "zone", ...zone },
    ]),
  ]);
}

// What a change of Places did to each place.
function placeChanges(before: Places, after: Places): Change[] {
  const was = placesOf(before);
  const is = placesOf(after);
  return [...new Set([...was.keys(), ...is.keys()])].map((key) => ({
    noun: "place",
    before: was.get(key) ?? null,
    after: is.get(key) ?? null,
  }));
}

type Log = (message: string) => void;

// What waits for an app apart at most. Past it the core drops them, and the
// app starts again to catch up.
const maxWaitingEvents = 1_000;
const maxWaitingBytes = 4 * 1024 * 1024;

// One running app's following: the events it asked for, its handlers and
// the deliveries still on their way to it.
type Follower = {
  // What the app may do now, its grants, read as each change comes.
  permissions: () => readonly string[];
  followed: Set<CoreEventName>;
  handlers: CoreEventHandlers;
  delivering: Promise<void>;
  stopped: boolean;
  run: (work: () => void | Promise<void>) => Promise<void>;
  // An app apart: every event from the moment it began starting, kept until
  // its start has said which it follows, and how much waits for it.
  early?: { event: CoreEvent; bytes: number }[];
  overflowed?: () => void;
  waiting: number;
  waitingBytes: number;
};

export function createCoreEvents(options: { timeoutMs: number; log: Log }) {
  const followers = new Map<string, Follower>();

  function enqueue(
    appId: string,
    follower: Follower,
    event: CoreEvent,
    bytes: number,
  ) {
    follower.delivering = follower.delivering.then(async () => {
      for (const handler of follower.handlers.get(event.name) ?? []) {
        if (follower.stopped) {
          break;
        }
        try {
          // Each app gets its own copy, as across a boundary.
          await follower.run(() => {
            const shown = eventShownTo(event, follower.permissions());
            if (shown) return handler(structuredClone(shown));
          });
        } catch (error) {
          options.log(
            `apps: ${appId} did not handle ${event.name} (${error instanceof TimedOut ? "timed out" : error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      follower.waiting -= 1;
      follower.waitingBytes -= bytes;
    });
  }

  function deliver(appId: string, follower: Follower, event: CoreEvent) {
    if (follower.stopped) {
      return;
    }
    const bytes = follower.overflowed
      ? Buffer.byteLength(JSON.stringify(event))
      : 0;
    if (
      follower.overflowed &&
      (follower.waiting >= maxWaitingEvents ||
        follower.waitingBytes + bytes > maxWaitingBytes)
    ) {
      options.log(`apps: ${appId} fell behind the core's events`);
      follower.stopped = true;
      follower.early = undefined;
      follower.overflowed();
      return;
    }
    follower.waiting += 1;
    follower.waitingBytes += bytes;
    if (follower.early) {
      follower.early.push({ event, bytes });
      return;
    }
    enqueue(appId, follower, event, bytes);
  }

  // Whether it wants an event of this name, or can't say yet.
  const wants = (follower: Follower, name: CoreEventName) =>
    Boolean(follower.early) || follower.followed.has(name);

  function changed(change: Change) {
    for (const [appId, follower] of followers) {
      if (follower.followed.size === 0 && !follower.early) {
        continue;
      }
      for (const event of eventsOf(shownTo(change, follower.permissions()))) {
        if (wants(follower, event.name)) {
          deliver(appId, follower, event);
        }
      }
    }
  }

  return {
    // A running app, from its start: where its start context keeps its
    // handlers and how it asks for an event, which calls.ts has checked.
    // What happens meanwhile waits for `started`, once the start hook has
    // caught up, so the two never interleave.
    //
    // An app apart hears what happened from the moment this is called, which is
    // when its reads' snapshot was taken, once it has said what it follows, and
    // `overflowed` says when too much waits for it.
    start(
      appId: string,
      permissions: () => readonly string[],
      run: Follower["run"] = (work) =>
        withTimeout(Promise.resolve().then(work), options.timeoutMs),
      apart?: { overflowed: () => void },
    ) {
      let open!: () => void;
      const follower: Follower = {
        permissions,
        followed: new Set(),
        handlers: new Map(),
        delivering: new Promise((resolve) => (open = resolve)),
        stopped: false,
        run,
        waiting: 0,
        waitingBytes: 0,
        ...(apart ? { early: [], overflowed: apart.overflowed } : {}),
      };
      followers.set(appId, follower);
      return {
        handlers: follower.handlers,
        follow: (name: CoreEventName) => void follower.followed.add(name),
        started() {
          const early = follower.early ?? [];
          follower.early = undefined;
          open();
          for (const { event, bytes } of early) {
            if (follower.followed.has(event.name)) {
              enqueue(appId, follower, event, bytes);
            } else {
              follower.waiting -= 1;
              follower.waitingBytes -= bytes;
            }
          }
        },
      };
    },

    // The app stops: what has not reached it yet never will, and the
    // handler it is in finishes or times out first.
    async stop(appId: string) {
      const follower = followers.get(appId);
      if (!follower) {
        return;
      }
      followers.delete(appId);
      follower.stopped = true;
      await follower.delivering;
    },

    device({ before, after }: DeviceChange) {
      changed({ noun: "device", before, after });
    },

    // A press that no capture holds, for the apps that may read its button.
    pressed({ device, capability, action }: Press) {
      for (const [appId, follower] of followers) {
        if (!wants(follower, "device.pressed")) {
          continue;
        }
        const shown = viewOf(device, {
          kinds: deviceKinds(follower.permissions()).reads,
        });
        if (shown?.capabilities.some((each) => each.id === capability)) {
          deliver(appId, follower, {
            name: "device.pressed",
            device: shown,
            capability,
            action,
          });
        }
      }
    },

    places(before: Places, after: Places) {
      for (const change of placeChanges(before, after)) {
        changed(change);
      }
    },

    // Where the home is, for the apps that may read that.
    location(before: HomeLocation | null, after: HomeLocation | null) {
      for (const [appId, follower] of followers) {
        if (
          wants(follower, "location.changed") &&
          follower.permissions().includes(placesLocationPermission)
        ) {
          deliver(appId, follower, {
            name: "location.changed",
            location: after,
            before,
          });
        }
      }
    },

    person({ before, after }: PersonChange) {
      changed({
        noun: "person",
        before: before && personInfo(before),
        after: after && personInfo(after),
      });
    },

    entity({ before, after }: EntityChange) {
      changed({ noun: "entity", before, after });
    },

    // The household changed what one app may do: only that app hears it.
    permissions(
      appId: string,
      before: readonly string[],
      granted: readonly string[],
    ) {
      const follower = followers.get(appId);
      if (follower && wants(follower, "permissions.changed")) {
        deliver(appId, follower, {
          name: "permissions.changed",
          granted: [...granted],
          before: [...before],
        });
      }
    },
  };
}

export type CoreEvents = ReturnType<typeof createCoreEvents>;
