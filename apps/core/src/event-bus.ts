import type { EmittedEvent } from "./app-host/app-work.js";
import type { DeviceChange } from "./devices/devices.js";
import type { MotionChange } from "./devices/motion.js";
import type { Press } from "./devices/presses.js";
import type { EntityChange } from "./entities/entities.js";
import type { PersonChange } from "./people/people.js";
import type { LocationChange, PlacesChange } from "./places/places.js";

// What happened in the core, once it has committed, for the core's modules
// that follow it. Each module publishes what happened to it, and each
// follower hears every event in the order it was published, the followers
// one after the other in the order set in core-followers.ts. Delivery is
// synchronous: the first publish delivers before it returns, and one made
// while an event is being delivered waits until that event has reached every
// follower. A follower that throws is logged and holds up neither the
// followers after it nor the module that published. Apps never follow the
// bus: the events for apps are one of its followers, and hear neither apps'
// own events nor how the core keeps them (app-host/events-for-apps.ts).
// Nothing is kept: a core that crashes or loses power skips what was
// queued, and each follower catches up from state as it starts.

export type BusEvent =
  // Either is null when it was added or removed.
  | ({ name: "device.changed" } & DeviceChange)
  | ({ name: "device.pressed" } & Press)
  // Every place, before and after.
  | ({ name: "places.changed" } & PlacesChange)
  | ({ name: "location.changed" } & LocationChange)
  | ({ name: "person.changed" } & PersonChange)
  | ({ name: "entity.changed" } & EntityChange)
  // An app's own event, once the app host has checked it and the action
  // that emitted it has succeeded.
  | ({ name: "app.emitted" } & EmittedEvent)
  // The places whose motion changed together, as Motion keeps it.
  | ({ name: "motion.changed" } & MotionChange);

export type BusEventName = BusEvent["name"];

// The events a follower follows, by name; it hears nothing else.
export type EventBusFollower = {
  [Name in BusEventName]?: (event: Extract<BusEvent, { name: Name }>) => void;
};

// A follower of what happens to the core's own nouns, as the events for
// apps are, with no place for apps' own events or what the core works out
// from its nouns, such as a place's motion.
export type CoreNounsFollower = Omit<
  EventBusFollower,
  "app.emitted" | "motion.changed"
>;

// waitingForFollowers: until the modules are built, when the followers are
// set. What's published meanwhile waits, and says so, since only a mistake
// in building can publish so early.
// open: every publish is delivered.
// closed: in stopping, once every publisher has stopped. What's published
// after that is dropped, and says so.
export type EventBusState = "waitingForFollowers" | "open" | "closed";

type Log = (message: string) => void;

function message(error: unknown) {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "unprintable error";
  }
}

// What the event was about, in the words a follower's failure is logged in.
function about(event: BusEvent) {
  switch (event.name) {
    case "device.changed":
    case "person.changed":
      return `a change of ${event.id}`;
    case "device.pressed":
      return `${event.device.id}'s press`;
    case "places.changed":
      return "a change of the places";
    case "location.changed":
      return "a change of where the home is";
    case "entity.changed":
      return `a change of ${event.app}'s ${event.key}`;
    case "app.emitted":
      return `${event.app}'s ${event.event}`;
    case "motion.changed":
      return "a change of the places' motion";
  }
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

export function createEventBus(options: { log: Log }) {
  let state: EventBusState = "waitingForFollowers";
  let followers: readonly (readonly [string, EventBusFollower])[] = [];
  const queued: BusEvent[] = [];
  let delivering = false;

  // A log that fails stops nothing.
  function say(line: string) {
    try {
      options.log(line);
    } catch {
      // Nothing else to tell.
    }
  }

  function deliverTo(
    label: string,
    follower: EventBusFollower,
    event: BusEvent,
  ) {
    const handler = follower[event.name] as
      ((event: BusEvent) => unknown) | undefined;
    if (!handler) return;
    const failed = (error: unknown) =>
      say(`${label}: ${about(event)} was not handled (${message(error)})`);
    try {
      const returned: unknown = handler(event);
      // Followers are synchronous: one that returns a promise is a mistake,
      // and its failure must not go unhandled.
      if (isThenable(returned)) {
        say(
          `events: ${label} returned a promise for ${event.name}, which the bus doesn't wait for`,
        );
        Promise.resolve(returned).then(undefined, failed);
      }
    } catch (error) {
      failed(error);
    }
  }

  function deliverQueued() {
    if (delivering) return;
    delivering = true;
    try {
      for (let event = queued.shift(); event; event = queued.shift()) {
        for (const [label, follower] of followers) {
          deliverTo(label, follower, event);
        }
      }
    } finally {
      delivering = false;
    }
  }

  return {
    state: () => state,

    publish(event: BusEvent) {
      if (state === "closed") {
        say(`events: ${event.name} was published after the bus closed`);
        return;
      }
      queued.push(event);
      if (state === "waitingForFollowers") {
        say(
          `events: ${event.name} was published before the followers were set`,
        );
        return;
      }
      deliverQueued();
    },

    // Once, as the modules are built: each hears every event in the list's
    // order, beginning with any that waited.
    setFollowers(
      list: readonly (readonly [label: string, follower: EventBusFollower])[],
    ) {
      if (state !== "waitingForFollowers") {
        throw new Error("the bus's followers are set once");
      }
      followers = list;
      state = "open";
      deliverQueued();
    },

    // In stopping, once every publisher has stopped. Whatever is still queued
    // goes out first; without followers, it never does.
    close() {
      if (state === "open") {
        deliverQueued();
      } else if (state === "waitingForFollowers" && queued.length > 0) {
        say(
          `events: ${queued.length} published before the followers were set never went out`,
        );
        queued.length = 0;
      }
      state = "closed";
    },
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
