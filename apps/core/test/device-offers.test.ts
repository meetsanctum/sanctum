import type { AvailableApp, Sighting } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { createDeviceOffers } from "../src/app-host/device-offers.js";

// An app the home could add that finds its devices on the home's network is
// offered in Add devices once one of them announces itself, with how many.

const finder = {
  id: "sanctum.example",
  name: "Example",
  requests: [{ id: "devices.register" }, { id: "discover:mdns:_example._tcp" }],
} as AvailableApp;
const other = {
  id: "sanctum.example-weather",
  name: "Example weather",
  requests: [{ id: "net:api.example.com" }],
} as AvailableApp;

const sighting = (name: string, service = "_example._tcp"): Sighting => ({
  service,
  name,
  host: `${name}.local`,
  addresses: ["192.168.1.20"],
  port: 6053,
  txt: {},
});

function home() {
  const state = {
    available: [finder, other] as AvailableApp[],
    isComplete: true,
    hasShipped: true,
    fails: false,
    added: new Set<string>(),
    hasInstalled: true,
    sightings: [] as Sighting[],
    reads: 0,
    changes: 0,
  };
  const listing = vi.fn(async () => {
    state.reads += 1;
    if (state.fails) throw new Error("The manager didn't answer");
    return {
      apps: state.available.filter(({ id }) => !state.added.has(id)),
      isComplete: state.isComplete,
      isCacheable: state.isComplete && state.hasShipped,
    };
  });
  const offers = createDeviceOffers({
    available: { listing },
    added: { ids: () => state.added },
    hasInstalled: () => state.hasInstalled,
    sightings: () => state.sightings,
    onChange: () => void (state.changes += 1),
    log: () => undefined,
  });
  return { offers, state, listing };
}

describe("Add devices' offers", () => {
  it("looks for what an app it could add would find, and counts it", async () => {
    const { offers, state } = home();
    await offers.check();
    expect(offers.services()).toEqual(["_example._tcp"]);
    expect(offers.list()).toEqual([]);

    state.sightings = [
      sighting("kitchen"),
      sighting("hall"),
      sighting("printer", "_ipp._tcp"),
    ];

    expect(offers.list()).toEqual([
      { app: "sanctum.example", name: "Example", found: 2 },
    ]);
  });

  it("counts a device that announces two of the services it looks for once", async () => {
    const { offers, state } = home();
    state.available = [
      {
        ...finder,
        requests: [
          ...finder.requests,
          { id: "discover:mdns:_example-setup._tcp" },
        ],
      } as AvailableApp,
    ];
    await offers.check();

    state.sightings = [
      sighting("kitchen"),
      sighting("kitchen", "_example-setup._tcp"),
      sighting("hall"),
    ];

    expect(offers.list()).toEqual([
      { app: "sanctum.example", name: "Example", found: 2 },
    ]);
  });

  it("offers Apple Home Devices only for Apple TVs with matching Companion sightings", async () => {
    const { offers, state } = home();
    const airplay = "_airplay._tcp";
    const companion = "_companion-link._tcp";
    state.available = [
      {
        ...finder,
        id: "sanctum.apple-home-devices",
        name: "Apple Home Devices",
        requests: [
          { id: "devices.register" },
          { id: "discover:mdns:_airplay._tcp" },
          { id: "discover:mdns:_companion-link._tcp" },
        ],
      } as AvailableApp,
    ];
    await offers.check();
    expect(offers.services()).toEqual([airplay, companion]);
    state.sightings = [
      {
        ...sighting("studio", airplay),
        txt: { model: "Mac16,10", deviceid: "11:22:33:44:55:66" },
      },
      {
        ...sighting("kitchen", airplay),
        txt: { model: "AudioAccessory5,1", deviceid: "02:22:33:44:55:66" },
      },
      {
        ...sighting("den", airplay),
        txt: { model: "AppleTV3,2", deviceid: "03:22:33:44:55:66" },
      },
      sighting("den", companion),
    ];
    expect(offers.list()).toEqual([]);

    const tv: Sighting = {
      ...sighting("living-room", airplay),
      txt: { Model: "AppleTV14,1", DeviceId: "04:22:33:44:55:66" },
    };
    state.sightings.push(tv, sighting("somewhere-else", companion));
    expect(offers.list()).toEqual([]);
    state.sightings.push({
      ...sighting("remote", companion),
      host: "LIVING-ROOM.local.",
    });
    expect(offers.list()).toEqual([
      {
        app: "sanctum.apple-home-devices",
        name: "Apple Home Devices",
        found: 1,
      },
    ]);
  });

  it("offers nothing once the app is added, and again once it's removed", async () => {
    const { offers, state } = home();
    state.sightings = [sighting("kitchen")];
    await offers.check();

    state.added.add("sanctum.example");
    expect(offers.list()).toEqual([]);
    expect(offers.services()).toEqual([]);
    await offers.check();

    state.added.delete("sanctum.example");
    await offers.check();
    expect(offers.list()).toEqual([
      { app: "sanctum.example", name: "Example", found: 1 },
    ]);
    expect(state.reads).toBe(3);
  });

  it("reads the list once while the home's list stays the same", async () => {
    const { offers, state } = home();
    await offers.check();
    await offers.check();

    expect(state.reads).toBe(1);
    expect(state.changes).toBe(1);
  });

  it("reads again if an app was added and removed during a read", async () => {
    const { offers, state, listing } = home();
    type Listing = Awaited<ReturnType<typeof listing>>;
    let finishListing!: (value: Listing) => void;
    const first = new Promise<Listing>((resolve) => {
      finishListing = resolve;
    });
    listing.mockReturnValueOnce(first);
    const reading = offers.check();

    state.added.add(finder.id);
    void offers.check();
    const apps = state.available.filter(({ id }) => !state.added.has(id));
    state.added.delete(finder.id);
    void offers.check();
    finishListing({ apps, isComplete: true, isCacheable: true });

    await reading;
    await offers.check();
    expect(offers.services()).toEqual(["_example._tcp"]);
    expect(listing).toHaveBeenCalledTimes(2);
  });

  it("refreshes the apps staged by a development stack until shutdown", async () => {
    const { offers, state } = home();
    vi.useFakeTimers();
    try {
      state.hasShipped = false;
      state.available = [other];
      offers.start();
      await offers.check();
      expect(offers.services()).toEqual([]);

      state.available = [other, finder];
      await vi.advanceTimersByTimeAsync(60_000);
      expect(offers.services()).toEqual(["_example._tcp"]);

      offers.interrupt();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.reads).toBe(2);
    } finally {
      await offers.close();
      vi.useRealTimers();
    }
  });

  it("waits for the home's list before reading", async () => {
    const { offers, state } = home();
    state.hasInstalled = false;
    await offers.check();
    expect(state.reads).toBe(0);

    state.hasInstalled = true;
    await offers.check();
    expect(offers.services()).toEqual(["_example._tcp"]);
  });

  it("reads again while the list couldn't be read whole", async () => {
    const { offers, state } = home();
    state.available = [];
    state.isComplete = false;
    await offers.check();
    expect(offers.services()).toEqual([]);

    state.available = [finder];
    state.isComplete = true;
    await offers.check();
    expect(offers.services()).toEqual(["_example._tcp"]);
  });

  it("keeps what it offered while the manager can't say", async () => {
    const { offers, state } = home();
    await offers.check();
    state.fails = true;
    state.added.add("sanctum.example-weather");

    await offers.check();

    expect(offers.services()).toEqual(["_example._tcp"]);
  });

  it("keeps an app a part read didn't show", async () => {
    const { offers, state } = home();
    await offers.check();
    state.available = [other];
    state.isComplete = false;
    state.added.add("sanctum.example-other");

    await offers.check();

    expect(offers.services()).toEqual(["_example._tcp"]);
  });

  it("drops a service a new build no longer requests even during a part read", async () => {
    const { offers, state } = home();
    state.hasShipped = false;
    await offers.check();
    state.available = [{ ...finder, requests: [] }];
    state.isComplete = false;

    await offers.check();

    expect(offers.services()).toEqual([]);
  });

  it("reads nothing more once closed", async () => {
    const { offers, state } = home();
    await offers.close();
    await offers.check();

    expect(state.reads).toBe(0);
  });
});
