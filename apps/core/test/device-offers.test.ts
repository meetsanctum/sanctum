import type { AvailableApp, Sighting } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

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
    fails: false,
    added: new Set<string>(),
    hasInstalled: true,
    sightings: [] as Sighting[],
    reads: 0,
    changes: 0,
  };
  const offers = createDeviceOffers({
    available: {
      listing: async () => {
        state.reads += 1;
        if (state.fails) throw new Error("The manager didn't answer");
        return {
          apps: state.available.filter(({ id }) => !state.added.has(id)),
          isComplete: state.isComplete,
        };
      },
    },
    added: { ids: () => state.added },
    hasInstalled: () => state.hasInstalled,
    sightings: () => state.sightings,
    onChange: () => void (state.changes += 1),
    log: () => undefined,
  });
  return { offers, state };
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

  it("reads nothing more once closed", async () => {
    const { offers, state } = home();
    await offers.close();
    await offers.check();

    expect(state.reads).toBe(0);
  });
});
