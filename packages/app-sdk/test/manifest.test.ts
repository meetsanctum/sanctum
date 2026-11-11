import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineAction,
  defineApp,
  defineEntityType,
  defineEvent,
  defineRoomSection,
  defineTrigger,
  previewProblems,
  toStaticManifest,
  type AppDefinition,
  type PieceWords,
  type SampleTile,
} from "../src/index.js";

// A complete sanctum-app.json: what the core would otherwise learn by
// running an app's code, its migrations, its driver hooks and its pieces'
// words, with the sample values and tiles its settings page previews, a
// one-line summary and the memory it asks for.

const lit = defineEvent({
  id: "lamp.lit",
  payload: z.object({ room: z.string() }),
});

function glow(words?: PieceWords) {
  return defineAction({
    id: "lamp.glow",
    title: "Glow",
    tier: "write",
    input: z.object({ room: z.string() }),
    output: z.object({}),
    words,
    run: async () => ({}),
  });
}

const tileType = defineEntityType({
  id: "lamp.scene",
  title: "Scene",
  state: z.object({
    placeId: z.string(),
    icon: z.enum(["sun", "moon"]),
    name: z.string(),
    order: z.number().int().min(0),
    active: z.boolean(),
    input: z.object({ room: z.string() }),
  }),
});

// Its step, the same object in its actions and its pieces.
const step = glow({ sentence: "Glow in {room}", preview: { room: "Kitchen" } });

function lamp(changes: Partial<AppDefinition> = {}): AppDefinition {
  return {
    id: "sanctum.lamp",
    name: "Lamp",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [{ id: "places.read", reason: "For the test." }],
    actions: [step],
    events: [lit],
    provides: { steps: [step] },
    ...changes,
  };
}

describe("an app's static manifest", () => {
  it("has its summary, the memory it asks for and its migrations", () => {
    const manifest = toStaticManifest(
      defineApp(
        lamp({
          summary: "Lights that glow. ",
          runtime: { memory: 256 },
          migrations: "migrations",
        }),
      ),
    );

    expect(manifest).toMatchObject({
      summary: "Lights that glow.",
      runtime: { memory: 256 },
      migrations: "migrations",
      driver: null,
    });
    // An app that says nothing gets 128 MB and has no migrations.
    expect(toStaticManifest(defineApp(lamp()))).toMatchObject({
      summary: null,
      runtime: { memory: 128, data: 256 },
      migrations: null,
    });
  });

  it("names the driver hooks a driver has", () => {
    const manifest = toStaticManifest(
      defineApp(
        lamp({
          permissions: [{ id: "devices.register", reason: "For the test." }],
          driver: {
            command: async () => {},
            probe: async () => {},
            pairing: {
              open: async () => ({ until: null }),
              close: async () => {},
            },
          },
        }),
      ),
    );

    expect(manifest.driver).toEqual({ hooks: ["command", "pairing", "probe"] });
  });

  it("has each piece's words, with their sample values", () => {
    const trigger = defineTrigger({
      id: "lamp.lit",
      title: "A lamp is lit",
      event: lit,
      config: z.object({ room: z.string().optional() }),
      words: { sentence: "A lamp is lit in {room}", preview: { room: "Hall" } },
    });
    const manifest = toStaticManifest(
      defineApp(
        lamp({ provides: { ...lamp().provides, triggers: [trigger] } }),
      ),
    );

    expect(manifest.provides.steps).toEqual([
      {
        id: "lamp.glow",
        words: { sentence: "Glow in {room}", preview: { room: "Kitchen" } },
        needs: [],
      },
    ]);
    expect(manifest.provides.triggers[0]).toMatchObject({
      words: { sentence: "A lamp is lit in {room}", preview: { room: "Hall" } },
    });
  });

  it("has its room section's sample tiles", () => {
    const tiles: SampleTile[] = [
      // Trimmed in the manifest, as its length was checked.
      { icon: "sun", name: `Morning${" ".repeat(100)}`, active: true },
      { icon: "moon", name: "Night", active: false },
    ];
    const manifest = toStaticManifest(
      defineApp(
        lamp({
          provides: {
            entities: [tileType],
            steps: [step],
            roomSections: [
              defineRoomSection({
                id: "lamp.room",
                title: "Scenes",
                entityType: tileType.id,
                kind: "tiles",
                press: step,
                preview: tiles,
              }),
            ],
          },
        }),
      ),
    );

    expect(manifest.provides.roomSections[0]?.preview).toEqual([
      { icon: "sun", name: "Morning", active: true },
      { icon: "moon", name: "Night", active: false },
    ]);
  });
});

describe("what a manifest may say", () => {
  it.each([
    ["a summary longer than 80 characters", { summary: "x".repeat(81) }],
    ["an empty summary", { summary: "  " }],
    ["a multiline summary", { summary: "First line\nSecond line" }],
    ["a carriage return in a summary", { summary: "First\rSecond" }],
    ["a Unicode line separator in a summary", { summary: "First\u2028Second" }],
    [
      "a Unicode paragraph separator in a summary",
      { summary: "First\u2029Second" },
    ],
    ["more memory than 512 MB", { runtime: { memory: 1024 } }],
    ["less memory than 64 MB", { runtime: { memory: 32 } }],
  ])("refuses %s", (_case, changes) => {
    expect(() => defineApp(lamp(changes as Partial<AppDefinition>))).toThrow();
  });

  it("refuses a room section's preview that is not a few sample tiles", () => {
    const withPreview = (preview: unknown) =>
      lamp({
        provides: {
          entities: [tileType],
          steps: [step],
          roomSections: [
            defineRoomSection({
              id: "lamp.room",
              title: "Scenes",
              entityType: tileType.id,
              kind: "tiles",
              press: step,
              preview: preview as SampleTile[],
            }),
          ],
        },
      });

    for (const preview of [
      [],
      new Array<SampleTile>(1),
      [{ icon: "rocket", name: "Launch", active: false }],
      [{ icon: "sun", name: "", active: true }],
      Array.from({ length: 7 }, () => ({
        icon: "sun",
        name: "Morning",
        active: false,
      })),
    ]) {
      expect(() => defineApp(withPreview(preview))).toThrow(
        /previews 1 to 6 sample tiles/,
      );
    }
  });
});

describe("a piece's preview", () => {
  it.each([{ preview: [] }, { preview: ["Kitchen"] }])(
    "refuses an array of sample values: $preview",
    ({ preview }) => {
      const action = glow({
        sentence: preview.length ? "Glow in {0}" : "Glow",
        preview: preview as unknown as Record<string, string>,
      });

      expect(() =>
        defineApp(lamp({ actions: [action], provides: { steps: [action] } })),
      ).toThrow("its preview must be an object of sample values");
    },
  );

  it.each(["constructor", "toString", "__proto__"])(
    "does not count an inherited %s as a sample value",
    (token) => {
      const action = glow({ sentence: `Glow in {${token}}`, preview: {} });

      expect(() =>
        defineApp(lamp({ actions: [action], provides: { steps: [action] } })),
      ).toThrow(`its preview gives {${token}} no value`);
    },
  );

  it.each([
    { preview: Object.create({ room: "Kitchen" }) as Record<string, string> },
    {
      preview: Object.defineProperty({}, "room", {
        value: "Kitchen",
      }) as Record<string, string>,
    },
  ])("requires sample values to survive JSON serialization", ({ preview }) => {
    const action = glow({ sentence: "Glow in {room}", preview });

    expect(JSON.parse(JSON.stringify(preview))).toEqual({});
    expect(() =>
      defineApp(lamp({ actions: [action], provides: { steps: [action] } })),
    ).toThrow("its preview gives {room} no value");
  });

  it("gives every token its words and presets use a value, and nothing else one", () => {
    expect(
      previewProblems({
        sentence: "Glow in {room}",
        presets: [
          {
            title: "Glow at night",
            sentence: "Glow in {room} at {time}",
            config: {},
          },
        ],
        preview: { room: "Kitchen", time: "22:00" },
      }),
    ).toEqual([]);
    expect(
      previewProblems({
        sentence: "Glow in {room} at {time}",
        preview: { room: "Kitchen", colour: "Amber" },
      }),
    ).toEqual([
      "its preview gives {time} no value",
      "its preview gives colour a value, but no words use it",
    ]);
    expect(
      previewProblems({
        sentence: "Glow in {room}",
        preview: { room: "x".repeat(41) },
      }),
    ).toEqual(["its preview's room must be a text of at most 40 characters"]);
    // Words without a preview are fine: it is the settings page's sample.
    expect(previewProblems({ sentence: "Glow in {room}" })).toEqual([]);
  });

  it("is checked when the app is defined", () => {
    const bare = glow({ sentence: "Glow in {room}", preview: {} });

    expect(() =>
      defineApp(lamp({ actions: [bare], provides: { steps: [bare] } })),
    ).toThrow('"lamp.glow": its preview gives {room} no value');
  });
});
