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

// Room sections: an app's part of every room's page, drawn by the shell from
// its entities of one type in the tile shape.

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
  id: "moods.mood",
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
const runMood = action("moods.runMood", "write");
const deleteMood = action("moods.deleteMood", "destructive");
const section = defineRoomSection({
  id: "moods.room",
  title: "Moods",
  entityType: "moods.mood",
  kind: "tiles",
  order: 200,
  press: runMood,
  open: { page: "room", label: "Edit" },
  whenEmpty: { roomHas: "light" },
});

function app(
  changes: Partial<RoomSectionDefinition> = {},
  more: Partial<AppDefinition> = {},
): AppDefinition {
  return {
    id: "sanctum.moods",
    name: "Moods",
    version: "0.1.0",
    core: "^1.0.0",
    icon: { glyph: "sofa", color: "ember" },
    pages: ["main", "room"],
    permissions: [{ id: "devices.control:light", reason: "For the test." }],
    actions: [runMood, deleteMood],
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
        id: "moods.room",
        title: "Moods",
        entityType: "moods.mood",
        kind: "tiles",
        order: 200,
        press: { action: "moods.runMood" },
        open: { page: "room", label: "Edit" },
        whenEmpty: { roomHas: "light" },
        preview: null,
      },
    ]);
  });

  it("may leave out its order, what it opens and when it is shown empty", () => {
    const plain = app({
      order: undefined,
      open: undefined,
      whenEmpty: undefined,
    });
    expect(toStaticManifest(defineApp(plain)).provides.roomSections).toEqual([
      expect.objectContaining({ order: 500, open: null, whenEmpty: null }),
    ]);
    expect(
      toStaticManifest(defineApp({ ...plain, provides: {} })).provides
        .roomSections,
    ).toEqual([]);
  });

  it.each<[string, Partial<RoomSectionDefinition>, RegExp]>([
    ["an id that is not namespaced", { id: "moods" }, /namespaced id/],
    ["no title", { title: " " }, /needs a title/],
    ["a kind other than tiles", { kind: "rows" as "tiles" }, /kind tiles/],
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
      { press: action("moods.other", "write") },
      /not one of the app's/,
    ],
    [
      "an action more than write",
      { press: deleteMood },
      /must be read or write/,
    ],
    [
      "a page the app does not have",
      { open: { page: "rooms", label: "Edit" } },
      /opens one of the app's pages/,
    ],
    [
      "no label for what it opens",
      { open: { page: "room", label: "" } },
      /opens one of the app's pages/,
    ],
    [
      "an empty rule for a kind of device that is not one",
      { whenEmpty: { roomHas: "camera" as "light" } },
      /kind of device/,
    ],
    [
      "an empty rule for a kind it does not read",
      { whenEmpty: { roomHas: "switch" } },
      /does not read/,
    ],
    [
      "an empty rule with nothing to open",
      { open: undefined },
      /only to offer what it opens/,
    ],
  ])("refuses %s", (_name, changes, error) => {
    expect(() => defineApp(app(changes))).toThrow(error);
  });

  it("is one per app at most", () => {
    const two = app();
    expect(() =>
      defineApp({
        ...two,
        provides: {
          ...two.provides,
          roomSections: [section, { ...section, id: "moods.other" }],
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
    ).toThrow(/moods.mood, but its icon does not fit a tile/);
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
    expect(brokenPromises(earlier, next)).toEqual(["roomSection moods.room"]);
    expect(
      brokenPromises(earlier, {
        ...next,
        version: "0.2.0",
      }),
    ).toEqual([]);
  });
});
