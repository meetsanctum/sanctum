import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Where the home is: an admin sets it in Settings → Household, with a
// suggestion from the public IP address that the core asks for only when the
// admin presses the button. Apps read it with places.location.

const zurich = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: 408,
  timeZone: "Europe/Zurich",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const elevationAtZurich =
  "https://api.open-meteo.com/v1/elevation?latitude=47.3769&longitude=8.5417";

// The services the suggestion asks, and Open-Meteo for the elevation
// unless it is down.
function locationServices(options: { openMeteo?: "down" } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === elevationAtZurich && !options.openMeteo) {
      return json({ elevation: [408.0] });
    }
    if (url === "https://api.ipify.org?format=json") {
      return json({ ip: "203.0.113.7" });
    }
    if (url === "https://get.geojs.io/v1/ip/geo/203.0.113.7.json") {
      return json({
        city: "Zurich",
        country: "Switzerland",
        latitude: "47.3769",
        longitude: "8.5417",
        timezone: "Europe/Zurich",
      });
    }
    return json({}, 404);
  });
}

function entries(core: TestCore) {
  return core.activity.recent().filter((entry) => entry.source === "places");
}

// What the admin sends for Zurich.
const atZurich = {
  timeZone: zurich.timeZone,
  coordinates: {
    latitude: zurich.latitude,
    longitude: zurich.longitude,
    elevation: zurich.elevation,
  },
};
const bern = { latitude: 46.948, longitude: 7.4474 };

describe("the home's location", () => {
  it("is unset until an admin sets it, changes it or takes it away", async () => {
    const core = await testCore();
    const maya = await claimed(core);

    expect((await get(core, "/api/places/home", maya)).json()).toEqual({
      name: "Home",
      timeZone: null,
      coordinates: null,
      temperatureUnit: "celsius",
    });

    const set = await post(core, "/api/places/home/update", atZurich, maya);
    expect(set.json()).toEqual({
      name: "Home",
      ...atZurich,
      temperatureUnit: "celsius",
    });
    await post(core, "/api/places/home/update", { name: "Lake house" }, maya);
    expect((await get(core, "/api/places/home", maya)).json()).toEqual({
      name: "Lake house",
      ...atZurich,
      temperatureUnit: "celsius",
    });
    expect(core.places.location()).toEqual(zurich);

    await post(core, "/api/places/home/update", { coordinates: null }, maya);
    expect((await get(core, "/api/places/home", maya)).json()).toEqual({
      name: "Lake house",
      timeZone: "Europe/Zurich",
      coordinates: null,
      temperatureUnit: "celsius",
    });
    expect(entries(core).map((entry) => entry.action)).toEqual([
      "home.update",
      "home.update",
      "home.update",
    ]);
  });

  it("keeps the elevation while the coordinates stay, and lets it go with them", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const update = (changes: object) =>
      post(core, "/api/places/home/update", changes, maya);
    await update(atZurich);

    // A client that does not know the elevation sends the coordinates
    // without it.
    await update({ coordinates: { latitude: 47.3769, longitude: 8.5417 } });
    expect(core.places.location()).toEqual(zurich);

    // Elsewhere, the elevation was for another place.
    await update({ coordinates: bern });
    expect(core.places.location()).toEqual({
      ...bern,
      elevation: null,
      timeZone: "Europe/Zurich",
    });
    await update({ coordinates: { ...bern, elevation: 540 } });
    expect(core.places.location()?.elevation).toBe(540);
    await update({ coordinates: { ...bern, elevation: null } });
    expect(core.places.location()?.elevation).toBeNull();

    await update(atZurich);
    await update({ coordinates: null });
    await update({ coordinates: { latitude: 47.3769, longitude: 8.5417 } });
    expect(core.places.location()?.elevation).toBeNull();
  });

  it("keeps the time zone when the coordinates are kept private", async () => {
    const core = await testCore();
    const maya = await claimed(core);

    await post(
      core,
      "/api/places/home/update",
      { timeZone: "Europe/Zurich" },
      maya,
    );

    // The workflows engine runs the home's clock on it; apps see no
    // location, since Weather and natural light need coordinates.
    expect(core.places.timeZone()).toBe("Europe/Zurich");
    expect(core.places.location()).toBeNull();
  });

  it("needs a time zone for coordinates", async () => {
    const core = await testCore();
    const maya = await claimed(core);

    const refused = await post(
      core,
      "/api/places/home/update",
      { coordinates: atZurich.coordinates },
      maya,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "time_zone_needed" });

    await post(core, "/api/places/home/update", atZurich, maya);
    expect(
      (await post(core, "/api/places/home/update", { timeZone: null }, maya))
        .statusCode,
    ).toBe(400);
    expect(core.places.location()).toEqual(zurich);
  });

  it("stays out of what everyone and every app with places.read sees, but for its time zone", async () => {
    // The home's own time zone, rather than the one tests run the core in.
    const core = await testCore({ timeZone: null });
    const maya = await claimed(core);
    await post(core, "/api/places/home/update", atZurich, maya);

    // The time zone stands on its own: apps' schedules run in it.
    expect((await get(core, "/api/places", maya)).json().home).toEqual({
      name: "Home",
      timeZone: "Europe/Zurich",
      temperatureUnit: "celsius",
    });
  });

  it.each([
    [
      "a latitude beyond the pole",
      { ...atZurich, coordinates: { latitude: 91, longitude: 8.5417 } },
    ],
    [
      "a longitude beyond the date line",
      { ...atZurich, coordinates: { latitude: 47.3769, longitude: -181 } },
    ],
    ["an unknown time zone", { ...atZurich, timeZone: "Mars/Olympus" }],
    [
      "half a pair of coordinates",
      { ...atZurich, coordinates: { latitude: 47.3769 } },
    ],
    [
      "an elevation above the highest peaks",
      {
        ...atZurich,
        coordinates: { ...atZurich.coordinates, elevation: 9001 },
      },
    ],
    [
      "an elevation without coordinates",
      { ...atZurich, coordinates: { elevation: 408 } },
    ],
  ])("refuses %s", async (_case, changes) => {
    const core = await testCore();
    const maya = await claimed(core);

    const refused = await post(core, "/api/places/home/update", changes, maya);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "invalid_request" });
    expect(core.places.location()).toBeNull();
    expect(core.places.timeZone()).toBeNull();
  });

  it("refuses a change that changes nothing", async () => {
    const core = await testCore();
    const maya = await claimed(core);

    expect(
      (await post(core, "/api/places/home/update", {}, maya)).statusCode,
    ).toBe(400);
  });

  it("is seen and set by every client, shared ones too", async () => {
    const core = await testCore();
    await claimed(core);
    const ben = personWithClient(core);
    const kitchen = sharedClient(core);

    const set = await post(core, "/api/places/home/update", atZurich, kitchen);
    const seen = await get(core, "/api/places/home", ben);

    expect(set.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({
      coordinates: { latitude: atZurich.coordinates.latitude },
    });
  });
});

describe("the location suggestion", () => {
  it("asks the internet only when someone presses the button, and saves nothing", async () => {
    const services = locationServices();
    const core = await testCore({ fetch: services });
    const maya = await claimed(core);
    await post(core, "/api/places/home/update", { name: "Lake house" }, maya);
    expect(services).not.toHaveBeenCalled();

    const suggested = await post(
      core,
      "/api/places/home/suggest-location",
      {},
      maya,
    );

    expect(suggested.statusCode).toBe(200);
    expect(suggested.json()).toEqual({
      ...zurich,
      place: "Zurich, Switzerland",
    });
    expect(services.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.ipify.org?format=json",
      "https://get.geojs.io/v1/ip/geo/203.0.113.7.json",
      elevationAtZurich,
    ]);
    expect((await get(core, "/api/places/home", maya)).json()).toEqual({
      name: "Lake house",
      timeZone: null,
      coordinates: null,
      temperatureUnit: "celsius",
    });
    expect(entries(core)[0]).toMatchObject({
      action: "home.suggestLocation",
      outcome: "ok",
      personId: maya.person.id,
    });
  });

  it("suggests no elevation when Open-Meteo does not answer", async () => {
    const core = await testCore({
      fetch: locationServices({ openMeteo: "down" }),
    });
    const maya = await claimed(core);

    const suggested = await post(
      core,
      "/api/places/home/suggest-location",
      {},
      maya,
    );

    expect(suggested.json()).toEqual({
      ...zurich,
      elevation: null,
      place: "Zurich, Switzerland",
    });
  });

  it("says so when the services do not answer", async () => {
    const core = await testCore({
      fetch: vi.fn(async () => json({ error: "down" }, 503)),
    });
    const maya = await claimed(core);

    const failed = await post(
      core,
      "/api/places/home/suggest-location",
      {},
      maya,
    );

    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: "location_unavailable" });
    expect(entries(core)[0]).toMatchObject({
      action: "home.suggestLocation",
      outcome: "failed",
      reason: "location_unavailable",
    });
    expect(core.logs.join("\n")).toContain("api.ipify.org answered 503");
  });
});

describe("apps reading the location", () => {
  const where = defineAction({
    id: "where.home",
    title: "Where the home is",
    tier: "read",
    input: z.object({}),
    output: z.unknown(),
    async run(ctx) {
      return { location: await ctx.places.location() };
    },
  });
  const app = (id: string, permissions: string[]) => ({
    origin: "official" as const,
    app: defineApp({
      id,
      name: "Where",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: permissions.map((id) => ({ id, reason: "For the test." })),
      actions: [where],
      events: [],
    }),
  });

  it("need places.location, which places.read is not", async () => {
    const core = await testCore({
      apps: [
        app("test.where", ["places.location"]),
        app("test.rooms", ["places.read"]),
      ],
    });
    const maya = await claimed(core);
    const ask = (appId: string) =>
      post(core, `/api/apps/${appId}/actions/where.home`, {}, maya);

    expect((await ask("test.where")).json()).toEqual({ location: null });
    await post(core, "/api/places/home/update", atZurich, maya);
    expect((await ask("test.where")).json()).toEqual({ location: zurich });

    const refused = await ask("test.rooms");
    expect(refused.statusCode).toBe(500);
    expect(core.logs.join("\n")).toContain(
      "test.rooms does not hold places.location",
    );
  });
});
