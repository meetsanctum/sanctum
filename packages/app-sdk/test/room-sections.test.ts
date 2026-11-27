import { describe, expect, it } from "vitest";
import { z } from "zod";

import { brokenPromises } from "../src/contract.js";
import {
  defineAction,
  defineApp,
  defineEntityType,
  defineRoomSection,
  roomSectionTile,
  tileShapeProblems,
  toStaticManifest,
  type AppDefinition,
  type RoomSectionDefinition,
} from "../src/index.js";

// Room sections: an app's part of every room's row, drawn by the shell from
// its entities of one type in the tile shape, as tiles or as buttons.

const moodState = z.object({
  placeId: z.string(),
  icon: z.enum(["sun", "moon"]),
  name: z.string(),
  order: z.number().int().min(0),
  active: z.boolean(),
  input: z.object({ id: z.string() }),
  // A type may keep more than its tiles show.
  smart: z.boolean(),
});
const moodType = defineEntityType({
  id: "example.scene",
  title: "Mood",
  state: moodState,
});
const action = (id: string, tier: "read" | "write" | "destructive") =>
  defineAction({
    id,
    title: id,
    tier,
    input: z.object({ id: z.string() }),
    output: z.object({}),
    run: async () => ({}),
  });
const runScene = action("example.runScene", "write");
const deleteScene = action("example.deleteScene", "destructive");
const section = defineRoomSection({
  id: "example.room",
  title: "Scenes",
  entityType: "example.scene",
  kind: "tiles",
  order: 200,
  press: runScene,
});

function app(
  changes: Partial<RoomSectionDefinition> = {},
  more: Partial<AppDefinition> = {},
): AppDefinition {
  return {
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    icon: { glyph: "sofa", color: "ember" },
    pages: ["main", "room"],
    permissions: [{ id: "devices.control:light", reason: "For the test." }],
    actions: [runScene, deleteScene],
    events: [],
    provides: {
      entities: [moodType],
      roomSections: [{ ...section, ...changes }],
    },
    ...more,
  };
}

describe("a room section", () => {
  it("is declared in the static manifest, with the action a tap calls", () => {
    expect(toStaticManifest(defineApp(app())).provides.roomSections).toEqual([
      {
        id: "example.room",
        title: "Scenes",
        entityType: "example.scene",
        kind: "tiles",
        order: 200,
        press: { action: "example.runScene" },
        preview: null,
      },
    ]);
  });

  it("may leave out its order", () => {
    const plain = app({ order: undefined });
    expect(toStaticManifest(defineApp(plain)).provides.roomSections).toEqual([
      expect.objectContaining({ order: 500 }),
    ]);
    expect(
      toStaticManifest(defineApp({ ...plain, provides: {} })).provides
        .roomSections,
    ).toEqual([]);
  });

  it.each<[string, Partial<RoomSectionDefinition>, RegExp]>([
    ["an id that is not namespaced", { id: "moods" }, /namespaced id/],
    ["no title", { title: " " }, /needs a title/],
    [
      "a kind other than tiles or buttons",
      { kind: "rows" as "tiles" },
      /kind tiles or buttons/,
    ],
    ["an order before Sanctum's", { order: 50 }, /an order from 300 to 799/],
    ["an order after any app's", { order: 800 }, /an order from 300 to 799/],
    ["an order that is not whole", { order: 350.5 }, /an order from 300/],
    [
      "a type the app does not provide",
      { entityType: "sun" },
      /does not provide/,
    ],
    [
      "an action that is not the app's",
      { press: action("example.other", "write") },
      /not one of the app's/,
    ],
    [
      "an action more than write",
      { press: deleteScene },
      /must be read or write/,
    ],
  ])("refuses %s", (_name, changes, error) => {
    expect(() => defineApp(app(changes))).toThrow(error);
  });

  it("may show buttons, with their sample for the app's settings", () => {
    const buttons = app({
      kind: "buttons",
      order: 300,
      preview: [{ icon: "sun", name: "Natural Light", active: true }],
    });
    expect(toStaticManifest(defineApp(buttons)).provides.roomSections).toEqual([
      expect.objectContaining({
        kind: "buttons",
        order: 300,
        preview: [{ icon: "sun", name: "Natural Light", active: true }],
      }),
    ]);
  });

  it("is one per app at most", () => {
    const two = app();
    expect(() =>
      defineApp({
        ...two,
        provides: {
          ...two.provides,
          roomSections: [section, { ...section, id: "example.other" }],
        },
      }),
    ).toThrow(/one room section at most/);
  });

  it("refuses a type without the tile shape", () => {
    const loose = defineEntityType({
      ...moodType,
      state: moodState.extend({ icon: z.string() }),
    });
    expect(() =>
      defineApp(
        app(
          {},
          {
            provides: { entities: [loose], roomSections: [section] },
          },
        ),
      ),
    ).toThrow(/example.scene, but its icon does not fit a tile/);
  });
});

describe("the tile shape", () => {
  it("is what a section's type keeps, beside anything else", () => {
    expect(tileShapeProblems(moodState)).toEqual([]);
    expect(
      roomSectionTile.safeParse({
        placeId: "office",
        icon: "sun",
        name: "Reading",
        order: 0,
        active: false,
        input: { id: "m1" },
        smart: true,
      }).success,
    ).toBe(true);
  });

  it("names each field a state lacks or has of another kind", () => {
    expect(
      tileShapeProblems(
        z.object({
          placeId: z.string(),
          icon: z.enum(["sun", "lamp"]),
          name: z.string().optional(),
          order: z.number(),
          active: z.string(),
          input: z.string(),
        }),
      ),
    ).toEqual([
      "its icon does not fit a tile",
      "its state needs name",
      "its order does not fit a tile",
      "its active does not fit a tile",
      "its input does not fit a tile",
    ]);
    expect(tileShapeProblems(z.string())).toEqual([
      "its state is not an object",
    ]);
  });
});

describe("the contract", () => {
  it("promises its room section's id", () => {
    const earlier = toStaticManifest(defineApp(app()));
    const next = toStaticManifest(
      defineApp({ ...app(), provides: { entities: [moodType] } }),
    );
    expect(brokenPromises(earlier, next)).toEqual(["roomSection example.room"]);
    expect(
      brokenPromises(earlier, {
        ...next,
        version: "0.2.0",
      }),
    ).toEqual([]);
  });
});
