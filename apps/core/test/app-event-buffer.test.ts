import type { CoreEvent, Places } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createEventsForApps,
  type EventsForApps,
} from "../src/app-host/events-for-apps.js";
import { createEventBus } from "../src/event-bus.js";

// The bus as the core sets it, with the events for apps its only follower.
function busFor(events: EventsForApps) {
  const bus = createEventBus({ log: () => undefined });
  bus.setFollowers([["events for apps", events.follower]]);
  return bus;
}

// What waits for an app apart: every event from the moment it began starting,
// which its start then filters by what it followed, up to 1,000 events or 4 MB,
// past which the core drops them and it starts again.

const nowhere: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [],
  zones: [],
};

// A home with these rooms.
const rooms = (from: number, count: number, name = "Room"): Places => ({
  ...nowhere,
  rooms: Array.from({ length: count }, (_, at) => ({
    id: `room-${from + at}`,
    name: `${name} ${from + at}`,
  })) as Places["rooms"],
});

function setUp() {
  const log = vi.fn();
  const events = createEventsForApps({ timeoutMs: 1_000, log });
  const bus = busFor(events);
  const overflowed = vi.fn();
  const following = events.start(
    "test.apart",
    () => ["places.read"],
    overflowed,
  );
  const heard: string[] = [];
  following.handlers.set("place.added", [
    (async (event: CoreEvent) => {
      heard.push((event as { place: { name: string } }).place.name);
    }) as never,
  ]);
  return { events, bus, following, heard, overflowed, log };
}

const settled = () => new Promise((done) => setTimeout(done, 5));

describe("the events waiting for an app apart", () => {
  it("keeps what happens from its start, for what it says it follows by the end", async () => {
    const { bus, following, heard } = setUp();

    bus.publish({
      name: "places.changed",
      before: nowhere,
      after: rooms(1, 1),
    });
    following.follow("place.added");
    bus.publish({
      name: "places.changed",
      before: rooms(1, 1),
      after: rooms(1, 2),
    });
    await settled();
    expect(heard).toEqual([]);

    following.started();
    await settled();

    expect(heard).toEqual(["Room 1", "Room 2"]);
  });

  it("hears nothing of what it didn't follow, which then waits no longer", async () => {
    const { bus, following, heard, overflowed } = setUp();
    following.handlers.set("place.deleted", [
      (async (event: CoreEvent) => {
        heard.push(event.name);
      }) as never,
    ]);
    bus.publish({
      name: "places.changed",
      before: nowhere,
      after: rooms(1, 1_000),
    });
    following.follow("place.deleted");

    following.started();
    await settled();

    expect(heard).toEqual([]);
    // Room for as many again, so none of them is still counted.
    following.follow("place.added");
    bus.publish({
      name: "places.changed",
      before: nowhere,
      after: rooms(1, 1_000),
    });
    await settled();
    expect(overflowed).not.toHaveBeenCalled();
    expect(heard).toHaveLength(1_000);
  });

  it("holds up to 1,000, and past that drops them and says so, once", async () => {
    const { bus, following, heard, overflowed, log } = setUp();
    following.follow("place.added");

    bus.publish({
      name: "places.changed",
      before: nowhere,
      after: rooms(1, 1_000),
    });
    expect(overflowed).not.toHaveBeenCalled();

    bus.publish({
      name: "places.changed",
      before: rooms(1, 1_000),
      after: rooms(1, 1_001),
    });
    expect(overflowed).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "apps: test.apart fell behind the core's events",
    );

    bus.publish({
      name: "places.changed",
      before: rooms(1, 1_001),
      after: rooms(1, 1_002),
    });
    following.started();
    await settled();

    expect(overflowed).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });

  it.each(["x", "界"])("holds up to 4 MB of %s, however few", (character) => {
    const { bus, following, overflowed } = setUp();
    following.follow("place.added");
    const name = character.repeat(
      Math.floor((1024 * 1024) / Buffer.byteLength(character)),
    );

    bus.publish({
      name: "places.changed",
      before: nowhere,
      after: rooms(1, 3, name),
    });
    expect(overflowed).not.toHaveBeenCalled();

    bus.publish({
      name: "places.changed",
      before: rooms(1, 3, name),
      after: rooms(1, 5, name),
    });
    expect(overflowed).toHaveBeenCalledTimes(1);
  });

  it("counts them out as they reach it", async () => {
    const { bus, following, heard, overflowed } = setUp();
    following.follow("place.added");
    following.started();

    for (let round = 0; round < 3; round += 1) {
      bus.publish({
        name: "places.changed",
        before: nowhere,
        after: rooms(1, 900),
      });
      await settled();
    }

    expect(heard).toHaveLength(2_700);
    expect(overflowed).not.toHaveBeenCalled();
  });

  it("drops what waits once it has fallen behind, and the rest finishes", async () => {
    const { events, bus, following, heard, overflowed } = setUp();
    following.follow("place.added");
    following.started();

    bus.publish({
      name: "places.changed",
      before: nowhere,
      after: rooms(1, 1_001),
    });
    expect(overflowed).toHaveBeenCalledTimes(1);
    await events.stop("test.apart");

    expect(heard).toEqual([]);
  });
});
