import {
  defineAction,
  defineApp,
  defineEntityType,
  defineRoomSection,
  toStaticManifest,
  type AppDefinition,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCoreCalls } from "../src/app-host/calls.js";
import { checkManifest } from "../src/app-host/contract.js";
import { claimed, get, post, sharedClient, testCore } from "./support.js";

// Room sections: the core lists each app's for clients, refuses an app whose
// section's type has no tile shape, and checks every state the app publishes of
// that type against it.

const spotState = z.object({
  placeId: z.string(),
  icon: z.enum(["sun", "moon"]),
  name: z.string(),
  order: z.number().int().min(0),
  active: z.boolean(),
  input: z.object({ id: z.string() }),
});
const spotType = defineEntityType({
  id: "nook.spot",
  title: "Spot",
  state: spotState,
});
const publish = defineAction({
  id: "nook.publish",
  title: "Publish",
  tier: "write",
  input: z.object({ key: z.string(), state: z.unknown() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.entities.publish({
      type: spotType.id,
      key: input.key,
      name: input.key,
      state: input.state,
    });
    return {};
  },
});
const use = defineAction({
  id: "nook.use",
  title: "Use a spot",
  tier: "write",
  input: z.object({ id: z.string() }),
  output: z.object({}),
  run: async () => ({}),
});
const nook = (state: z.ZodObject = spotState): AppDefinition => ({
  id: "test.nook",
  name: "Nook",
  version: "0.1.0",
  core: "^1.0.0",
  icon: { glyph: "sofa", color: "leaf" },
  pages: ["room"],
  permissions: [{ id: "devices.read:light", reason: "For the test." }],
  actions: [publish, use],
  events: [],
  provides: {
    entities: [{ ...spotType, state }],
    roomSections: [
      defineRoomSection({
        id: "nook.room",
        title: "Spots",
        entityType: spotType.id,
        kind: "tiles",
        press: use,
        open: { page: "room", label: "Edit" },
        whenEmpty: { roomHas: "light" },
      }),
    ],
  },
});

const spot = {
  placeId: "office",
  icon: "sun",
  name: "Desk",
  order: 0,
  active: true,
  input: { id: "desk" },
};

describe("room sections", () => {
  it("are listed with each app for every client, with the action a tap calls", async () => {
    const core = await testCore({
      apps: [{ app: defineApp(nook()), origin: "official" }],
    });
    const maya = await claimed(core);
    for (const token of [maya.token, sharedClient(core).token]) {
      const [app] = (await get(core, "/api/apps", { token })).json();
      expect(app.provides.roomSections).toEqual([
        {
          id: "nook.room",
          title: "Spots",
          entityType: "nook.spot",
          kind: "tiles",
          order: 500,
          press: { action: "nook.use" },
          open: { page: "room", label: "Edit" },
          whenEmpty: { roomHas: "light" },
        },
      ]);
    }
  });

  it("keep an app whose manifest gives its section's type no tile shape from being installed", async () => {
    // Its own defineApp refuses such an app, so only its manifest says it.
    const manifest = toStaticManifest(defineApp(nook()));
    const spot = manifest.provides.entities[0]!.state as {
      properties: Record<string, unknown>;
    };
    spot.properties.active = { type: "string" };
    const core = await testCore({
      apps: [{ app: nook(), manifest, origin: "official" }],
    });
    const maya = await claimed(core);
    expect((await get(core, "/api/apps", maya)).json()).toEqual([]);
    expect(core.logs).toContainEqual(
      expect.stringMatching(
        /test.nook was not installed .*its active does not fit a tile/,
      ),
    );
  });

  it.each([
    [
      "a second section",
      (manifest: StaticManifest) =>
        manifest.provides.roomSections.push({
          ...manifest.provides.roomSections[0]!,
          id: "nook.other",
        }),
      "more than one room section",
    ],
    [
      "a type it doesn't provide",
      (manifest: StaticManifest) => {
        manifest.provides.roomSections[0]!.entityType = "nook.elsewhere";
      },
      "shows nook.elsewhere, which it doesn't provide",
    ],
    [
      "an action that isn't its own",
      (manifest: StaticManifest) => {
        manifest.provides.roomSections[0]!.press = { action: "nook.gone" };
      },
      "pressed with nook.gone, which must be one of its read or write actions",
    ],
  ])(
    "keep an app whose manifest gives its section %s from being installed",
    (_, change, refusal) => {
      const manifest = toStaticManifest(defineApp(nook()));
      change(manifest);

      expect(() => checkManifest(manifest)).toThrow(refusal);
    },
  );

  it("keep the places before 300 for Sanctum's own apps", async () => {
    const early = (app: AppDefinition): AppDefinition => ({
      ...app,
      provides: {
        ...app.provides,
        roomSections: app.provides!.roomSections!.map((section) => ({
          ...section,
          order: 200,
        })),
      },
    });
    const core = await testCore({
      apps: [
        { app: early(nook()), origin: "third-party" },
        { app: { ...early(nook()), id: "test.den" }, origin: "official" },
        { app: { ...nook(), id: "test.loft" }, origin: "third-party" },
      ],
    });
    const maya = await claimed(core);
    expect(
      (await get(core, "/api/apps", maya))
        .json()
        .map((app: { id: string }) => app.id),
    ).toEqual(["test.den", "test.loft"]);
    expect(core.logs).toContainEqual(
      expect.stringMatching(
        /test.nook was not installed .*a third-party app's room section takes an order from 300/,
      ),
    );
  });

  it("take what the app publishes for them in the tile shape", async () => {
    const core = await testCore({
      apps: [{ app: defineApp(nook()), origin: "official" }],
    });
    const maya = await claimed(core);
    const published = await post(
      core,
      "/api/apps/test.nook/actions/nook.publish",
      { key: "desk", state: spot },
      maya,
    );
    expect(published.statusCode).toBe(200);
    expect(
      (await get(core, "/api/entities?type=nook.spot", maya)).json(),
    ).toMatchObject([{ app: "test.nook", key: "desk", state: spot }]);
  });

  it("fail an app that publishes one of their entities out of the tile shape", async () => {
    const core = await testCore();
    const calls = (isTileType: boolean) =>
      createCoreCalls({
        appId: "test.nook",
        actor: { kind: "app", id: "test.nook" },
        permissions: () => [],
        permissionsRevision: () => 0,
        query: async () => ({}),
        ended: () => false,
        services: new Map(),
        people: core.people,
        places: core.places,
        devices: core.devices,
        presses: core.presses,
        firmware: core.firmware,
        problems: { report() {} },
        emit() {},
        entities: core.entities,
        // A type looser than its section, as no install would let through.
        entityType: () => ({
          id: spotType.id,
          state: (data) => ({ success: true, data }),
        }),
        isTileType: () => isTileType,
        settings: () => ({}),
        net: async () => {
          throw new Error("No internet here");
        },
        watch: () => ({ signal: new AbortController().signal, done() {} }),
        pairing: () => core.pairing,
        secrets: { get: () => null, put() {}, remove() {} },
        log() {},
      });
    const loose = {
      type: "nook.spot",
      key: "desk",
      name: "Desk",
      state: { ...spot, order: -1 },
    };
    await expect(calls(true).publish(loose)).rejects.toThrow(
      /test.nook's desk does not fit a room section's tile/,
    );
    await expect(calls(false).publish(loose)).resolves.toBeUndefined();
  });
});
