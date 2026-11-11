import type { CoreEvent, Places } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { createCoreEvents } from "../src/app-host/core-events.js";

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

function setUp(apart = true) {
  const log = vi.fn();
  const events = createCoreEvents({ timeoutMs: 1_000, log });
  const overflowed = vi.fn();
  const following = events.start(
    "test.apart",
    () => ["places.read"],
    undefined,
    apart ? { overflowed } : undefined,
  );
  const heard: string[] = [];
  following.handlers.set("place.added", [
    (async (event: CoreEvent) => {
      heard.push((event as { place: { name: string } }).place.name);
    }) as never,
  ]);
  return { events, following, heard, overflowed, log };
}

const settled = () => new Promise((done) => setTimeout(done, 5));

describe("the events waiting for an app apart", () => {
  it("keeps what happens from its start, for what it says it follows by the end", async () => {
    const { events, following, heard } = setUp();

    events.places(nowhere, rooms(1, 1));
    following.follow("place.added");
    events.places(rooms(1, 1), rooms(1, 2));
    await settled();
    expect(heard).toEqual([]);

    following.started();
    await settled();

    expect(heard).toEqual(["Room 1", "Room 2"]);
  });

  it("hears nothing of what it didn't follow, which then waits no longer", async () => {
    const { events, following, heard, overflowed } = setUp();
    following.handlers.set("place.deleted", [
      (async (event: CoreEvent) => {
        heard.push(event.name);
      }) as never,
    ]);
    events.places(nowhere, rooms(1, 1_000));
    following.follow("place.deleted");

    following.started();
    await settled();

    expect(heard).toEqual([]);
    // Room for as many again, so none of them is still counted.
    following.follow("place.added");
    events.places(nowhere, rooms(1, 1_000));
    await settled();
    expect(overflowed).not.toHaveBeenCalled();
    expect(heard).toHaveLength(1_000);
  });

  it("holds up to 1,000, and past that drops them and says so, once", async () => {
    const { events, following, heard, overflowed, log } = setUp();
    following.follow("place.added");

    events.places(nowhere, rooms(1, 1_000));
    expect(overflowed).not.toHaveBeenCalled();

    events.places(rooms(1, 1_000), rooms(1, 1_001));
    expect(overflowed).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "apps: test.apart fell behind the core's events",
    );

    events.places(rooms(1, 1_001), rooms(1, 1_002));
    following.started();
    await settled();

    expect(overflowed).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });

  it.each(["x", "界"])("holds up to 4 MB of %s, however few", (character) => {
    const { events, following, overflowed } = setUp();
    following.follow("place.added");
    const name = character.repeat(
      Math.floor((1024 * 1024) / Buffer.byteLength(character)),
    );

    events.places(nowhere, rooms(1, 3, name));
    expect(overflowed).not.toHaveBeenCalled();

    events.places(rooms(1, 3, name), rooms(1, 5, name));
    expect(overflowed).toHaveBeenCalledTimes(1);
  });

  it("counts them out as they reach it", async () => {
    const { events, following, heard, overflowed } = setUp();
    following.follow("place.added");
    following.started();

    for (let round = 0; round < 3; round += 1) {
      events.places(nowhere, rooms(1, 900));
      await settled();
    }

    expect(heard).toHaveLength(2_700);
    expect(overflowed).not.toHaveBeenCalled();
  });

  it("drops what waits once it has fallen behind, and the rest finishes", async () => {
    const { events, following, heard, overflowed } = setUp();
    following.follow("place.added");
    following.started();

    events.places(nowhere, rooms(1, 1_001));
    expect(overflowed).toHaveBeenCalledTimes(1);
    await events.stop("test.apart");

    expect(heard).toEqual([]);
  });

  it("leaves an app in the core's process as it was, hearing only what it follows from then", async () => {
    const { events, following, heard, overflowed } = setUp(false);

    events.places(nowhere, rooms(1, 1));
    following.follow("place.added");
    events.places(rooms(1, 1), rooms(1, 2));
    following.started();
    await settled();

    expect(heard).toEqual(["Room 2"]);
    expect(overflowed).not.toHaveBeenCalled();
  });
});
