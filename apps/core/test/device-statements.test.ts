import {
  turnOnSchema,
  turnOnType,
  type ActivityInfo,
  type EntityInfo,
} from "@meetsanctum/app-sdk";
import moods from "@meetsanctum/moods";
import { createNaturalLightApp } from "@meetsanctum/natural-light";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { entities } from "../src/entities/schema.js";
import {
  command,
  lampsCore,
  openLive,
  radio,
  settled,
} from "./devices-support.js";
import type { AppPackage } from "./runner-apps.js";
import { get, post, sharedClient, type TestCore } from "./support.js";

// What the core asks of SQLite for one press of a room's switch. A
// statement SQLite has to compile costs far more than running it, so what
// runs for every command and every report, and for every call of an app
// that follows the lights, is compiled once and kept.

// How long an app, which answers over its socket, gets to follow a press.
const realClock = { timeout: 5_000 };

// Every statement the core has SQLite compile from here on, by its text.
function compiled(core: TestCore) {
  const sqlite = core.db.$client;
  const prepare = sqlite.prepare.bind(sqlite);
  const texts: string[] = [];
  sqlite.prepare = ((text: string) => {
    texts.push(text);
    return prepare(text);
  }) as typeof sqlite.prepare;
  return texts;
}

// The selects among them that read one of these tables.
function reading(texts: readonly string[], tables: readonly string[]) {
  const select = new RegExp(`^select .* from "(${tables.join("|")})"`);
  return texts.filter((text) => select.test(text));
}

// What a press reads of the core's own: its devices and the activity log,
// who pressed and with which client, the places, the workflows a change may
// start, and the entities that say how a room's lights come on.
const coreTables = [
  "devices",
  "device_capabilities",
  "activity",
  "auth_tokens",
  "auth_clients",
  "people",
  "home",
  "floors",
  "rooms",
  "zones",
  "zone_rooms",
  "workflows",
  "entities",
];

// And what the apps that follow the lights ask for as they do: their
// settings, and whether each is in an update, which listing the apps reads.
const appTables = [...coreTables, "app_settings", "app_updates"];

const catalogApp = (app: AppPackage["app"], folder: string): AppPackage => ({
  app,
  origin: "official",
  migrationsFolder: fileURLToPath(
    new URL(`../../../catalog/apps/${folder}/migrations`, import.meta.url),
  ),
});

// A room with six lights, all off, and a client following the home.
async function sixLights(options: { apps?: readonly AppPackage[] } = {}) {
  const context = await lampsCore(options);
  const { core, maya, lamp } = context;
  const token = maya.token;
  for (const each of [2, 3, 4, 5, 6]) {
    await radio.add(`lamp-${each}`, "light", `Lamp ${each}`);
  }
  const room = (
    await post(core, "/api/places/rooms/add", { name: "Office" }, { token })
  ).json().id as string;
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    type: string;
  }[];
  const lights = devices.filter((device) => device.type === "light");
  expect(lights.map((light) => light.id)).toContain(lamp);
  expect(lights).toHaveLength(6);
  for (const { id } of lights) {
    await post(core, "/api/devices/update", { id, roomId: room }, { token });
  }
  await settled();
  const live = await openLive(core, token);
  const press = (to: "on" | "off", by: { token: string } = maya) =>
    post(
      core,
      "/api/devices/lights",
      { place: { kind: "room", id: room }, to },
      by,
    );
  return { ...context, live, press };
}

// The lights that told the client they are on or off, by their ids.
function heardFrom(live: Awaited<ReturnType<typeof openLive>>, on: boolean) {
  const heard = live.messages.filter(
    (message) =>
      message.type === "device" &&
      (
        message.device as { capabilities: { observed: { on: boolean } }[] }
      ).capabilities.some((capability) => capability.observed.on === on),
  );
  return new Set(heard.map((message) => message.id));
}

describe("a press of a room's six lights", () => {
  it("compiles no statement that reads what the core keeps", async () => {
    const { core, live, press } = await sixLights();
    const texts = compiled(core);
    expect((await press("on")).json()).toMatchObject({ switched: 6 });
    await settled();
    // Every light said it is on, and the client heard each.
    expect(heardFrom(live, true).size).toBe(6);
    expect(texts.length).toBeGreaterThan(0);
    expect(reading(texts, coreTables)).toEqual([]);
  });

  it("compiles none from a shared client, whose entries keep its name", async () => {
    const { core, live, press } = await sixLights();
    const tablet = sharedClient(core);
    await press("on");
    await settled();
    const texts = compiled(core);
    expect((await press("off", tablet)).json()).toMatchObject({ switched: 6 });
    await settled();
    expect(heardFrom(live, false).size).toBe(6);
    expect(texts.length).toBeGreaterThan(0);
    expect(reading(texts, coreTables)).toEqual([]);
    // Each entry of the press names the tablet.
    const { entries } = (
      await get(core, "/api/activity?limit=50", tablet)
    ).json() as { entries: ActivityInfo[] };
    expect(
      entries.filter(
        ({ who }) => who.kind === "client" && who.name === "Kitchen tablet",
      ),
    ).toHaveLength(6);
  });

  it("compiles none for the apps that follow the lights", async () => {
    // Natural Light reads the core's test clock once the core has one.
    let clock = () => new Date();
    const { core, maya, live, press } = await sixLights({
      apps: [
        catalogApp(moods, "moods"),
        catalogApp(
          createNaturalLightApp({ now: () => clock() }),
          "natural-light",
        ),
      ],
    });
    clock = core.now;
    await post(
      core,
      "/api/places/home/update",
      {
        timeZone: "Europe/Zurich",
        coordinates: { latitude: 47.3769, longitude: 8.5417 },
      },
      maya,
    );
    const published = async (type: string) =>
      (
        (
          await get(core, "/api/entities?app=sanctum.natural-light", maya)
        ).json() as EntityInfo[]
      ).filter((entity) => entity.type === type);
    const targets = () => published("naturalLight.target");
    // Let the location's curve reach all six lights before measuring a
    // press. A later curve makes each light need a new look when it comes on.
    // Natural Light publishes the room's rule for turning on after the
    // lights' targets, and a rule from before it followed all six keeps the
    // others off.
    await vi.waitFor(async () => {
      const current = await targets();
      expect(current).toHaveLength(6);
      for (const target of current) {
        expect(target.state).toMatchObject({ status: "following" });
      }
      const rules = await published(turnOnType.id);
      expect(rules).toHaveLength(1);
      const { lights } = turnOnSchema.parse(rules[0]!.state);
      expect(lights.map((light) => light.state.on)).toEqual(
        Array(6).fill(true),
      );
    }, realClock);
    core.advance(6 * 60 * 60_000);
    live.messages.length = 0;

    // What the client heard that Natural Light did, by the app's name.
    const byNaturalLight = () =>
      live.messages
        .filter((message) => message.type === "activity")
        .map((message) => message.entry as ActivityInfo)
        .filter(
          ({ who, action, outcome }) =>
            who.kind === "app" &&
            who.name === "Natural Light" &&
            action === "device.command" &&
            outcome === "ok",
        );

    const texts = compiled(core);
    expect((await press("on")).json()).toMatchObject({ switched: 6 });
    // Each light takes the new curve, reports it and has its target
    // published. Existing targets or the first activity entry alone don't
    // say that the remaining lights have been followed yet.
    await vi.waitFor(async () => {
      const current = await targets();
      expect(current).toHaveLength(6);
      for (const target of current) {
        expect(target).toMatchObject({
          updatedAt: core.now().toISOString(),
          state: { status: "following" },
        });
      }
      expect(heardFrom(live, true).size).toBe(6);
      expect(
        new Set(byNaturalLight().map(({ subject }) => subject?.id)).size,
      ).toBe(6);
    }, realClock);
    await settled();
    expect(
      texts.filter((text) => text.startsWith('insert into "entities"')).length,
    ).toBeGreaterThan(0);
    expect(reading(texts, appTables)).toEqual([]);
  });
});

describe("a list of entities", () => {
  it("compiles nothing, by app, by type, by both or by neither", async () => {
    const { core, maya } = await lampsCore();
    // Two apps with two types between them, so each way of asking answers
    // entities no other does, in the list's order: by app, then by name.
    const kept = [
      ["sanctum.example", "one", "example.thing"],
      ["sanctum.example", "two", "example.other"],
      ["sanctum.example-notes", "three", "example.thing"],
    ] as const;
    for (const [appId, key, type] of kept) {
      core.db
        .insert(entities)
        .values({
          appId,
          key,
          type,
          name: key,
          state: {},
          updatedAt: core.now(),
        })
        .run();
    }
    const texts = compiled(core);
    for (const [query, found] of [
      ["", ["one", "two", "three"]],
      ["?app=sanctum.example", ["one", "two"]],
      ["?type=example.thing", ["one", "three"]],
      ["?app=sanctum.example&type=example.thing", ["one"]],
      ["?app=sanctum.example-notes&type=example.other", []],
    ] as const) {
      const listed = (
        await get(core, `/api/entities${query}`, maya)
      ).json() as EntityInfo[];
      expect(listed.map((entity) => entity.key)).toEqual(found);
    }
    expect(reading(texts, ["entities"])).toEqual([]);
  });
});

describe("a light's adjustments", () => {
  it("compiles no activity read when successive adjustments join", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", {
      on: true,
      brightness: 30,
    });
    await settled();
    const live = await openLive(core, maya.token);
    const texts = compiled(core);
    for (const brightness of [40, 50]) {
      expect(
        (await command(core, maya.token, lamp, "light", { brightness }))
          .statusCode,
      ).toBe(200);
      await settled();
    }
    await settled();

    const heard = live.messages
      .filter((message) => message.type === "activity")
      .map((message) => message.entry as ActivityInfo)
      .filter((entry) => entry.action === "device.command");
    expect(heard.map((entry) => entry.count)).toEqual([1, 2]);
    expect(heard[1]!.id).toBe(heard[0]!.id);
    expect(texts.length).toBeGreaterThan(0);
    expect(reading(texts, ["activity"])).toEqual([]);
  });
});
