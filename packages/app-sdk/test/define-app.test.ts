import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  ActionError,
  actorSchema,
  createAppContext,
  defineAction,
  defineApp,
  defineEntityType,
  defineEvent,
  defineWidget,
  entityTypeOf,
  forecastType,
  isActionError,
  sunType,
  toStaticManifest,
  type ActionInput,
  type ActionOutput,
  type CoreCalls,
} from "../src/index.js";

const addItem = defineAction({
  id: "example.addItem",
  title: "Add an item",
  tier: "write",
  input: z.object({ listId: z.string(), name: z.string().min(1) }),
  output: z.object({ itemId: z.string() }),
  async run(_ctx, input) {
    return { itemId: `${input.listId}:${input.name}` };
  },
});

const itemAdded = defineEvent({
  id: "example.itemAdded",
  payload: z.object({ itemId: z.string() }),
});

const base = {
  id: "sanctum.example",
  name: "Example",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [{ id: "people.read", reason: "For the test." }],
  actions: [addItem],
  events: [itemAdded],
};

describe("defineApp", () => {
  it("accepts a valid app", () => {
    expect(defineApp(base).id).toBe("sanctum.example");
  });

  it("rejects an id that is not reverse-DNS", () => {
    expect(() => defineApp({ ...base, id: "Example" })).toThrow();
  });

  it("rejects a non-semver version", () => {
    expect(() => defineApp({ ...base, version: "1" })).toThrow();
  });

  it.each(["1.0.0+build.1", "1.0.0-alpha.1+001", "0.0.0", "1.2.3-0"])(
    "accepts the SemVer version %s",
    (version) => {
      expect(defineApp({ ...base, version }).version).toBe(version);
    },
  );

  it.each([
    "01.0.0",
    "1.02.0",
    "1.0.03",
    "1.0.0-01",
    "1.0.0-alpha..1",
    "1.0.0+",
  ])("rejects the invalid SemVer version %s", (version) => {
    expect(() => defineApp({ ...base, version })).toThrow();
  });

  it("rejects duplicate action ids", () => {
    expect(() => defineApp({ ...base, actions: [addItem, addItem] })).toThrow(
      /Duplicate action id/,
    );
  });

  it("rejects action ids that are not namespaced", () => {
    const bare = defineAction({ ...addItem, id: "addItem" });
    expect(() => defineApp({ ...base, actions: [bare] })).toThrow(/namespaced/);
  });

  it("checks what a loaded package hands it, not only its types", () => {
    const loaded = (actions: unknown[]) =>
      ({ ...base, actions }) as unknown as Parameters<typeof defineApp>[0];

    expect(() => defineApp(loaded([null]))).toThrow(/schemas and a run/);
    expect(() =>
      defineApp(loaded([{ ...addItem, run: "not a function" }])),
    ).toThrow(/schemas and a run/);
    expect(() => defineApp(loaded([{ ...addItem, tier: "admin" }]))).toThrow(
      /needs a tier/,
    );
  });

  it("keeps the migrations folder inside the package", () => {
    expect(defineApp({ ...base, migrations: "migrations" }).migrations).toBe(
      "migrations",
    );
    for (const migrations of ["/data", "../core/migrations", "a/../../b"]) {
      expect(() => defineApp({ ...base, migrations })).toThrow();
    }
  });
});

describe("pages", () => {
  const icon = { glyph: "list-checks", color: "sky" } as const;

  it("open from the app overview at main, under the app's icon", () => {
    const app = defineApp({ ...base, icon, pages: ["main", "list"] });
    expect(toStaticManifest(app)).toMatchObject({
      icon,
      pages: ["main", "list"],
    });
  });

  it("need an icon, and no main page unless the overview opens one", () => {
    expect(defineApp({ ...base, icon, pages: ["list"] }).pages).toEqual([
      "list",
    ]);
    expect(() => defineApp({ ...base, pages: ["main"] })).toThrow(/an icon/);
    expect(() => defineApp({ ...base, icon, pages: ["main", "main"] })).toThrow(
      /Duplicate page/,
    );
  });

  it("take an icon in one of the eight app colours", () => {
    expect(() =>
      defineApp({
        ...base,
        icon: { glyph: "list-checks", color: "#12A594" as "sky" },
      }),
    ).toThrow();
  });

  it("are left out of an app without them", () => {
    expect(toStaticManifest(defineApp(base))).toMatchObject({
      icon: null,
      pages: [],
    });
  });
});

describe("driver apps", () => {
  const driver = { command: async () => {} };

  it("hold devices.register and carry out their devices' commands", () => {
    const app = defineApp({
      ...base,
      permissions: [{ id: "devices.register", reason: "For the test." }],
      driver,
    });
    expect(app.driver).toBe(driver);
  });

  it("need both, since a device's commands go to the app that brings it", () => {
    expect(() =>
      defineApp({
        ...base,
        permissions: [{ id: "devices.register", reason: "For the test." }],
      }),
    ).toThrow(/driver.command/);
    expect(() => defineApp({ ...base, driver })).toThrow(/devices.register/);
  });

  it("may let devices join and remove them, with functions for each", () => {
    const pairing = {
      open: async () => ({ until: null }),
      close: async () => {},
    };
    const app = defineApp({
      ...base,
      permissions: [{ id: "devices.register", reason: "For the test." }],
      driver: { ...driver, pairing, remove: async () => {} },
    });
    expect(app.driver?.pairing).toBe(pairing);
    expect(() =>
      defineApp({
        ...base,
        permissions: [{ id: "devices.register", reason: "For the test." }],
        driver: { ...driver, pairing: { open: pairing.open } },
      } as unknown as typeof base),
    ).toThrow(/open and close functions/);
    expect(() =>
      defineApp({
        ...base,
        permissions: [{ id: "devices.register", reason: "For the test." }],
        driver: { ...driver, remove: "leave" },
      } as unknown as typeof base),
    ).toThrow(/remove must be a function/);
    expect(() =>
      defineApp({
        ...base,
        permissions: [{ id: "devices.register", reason: "For the test." }],
        driver: { ...driver, move: "up" },
      } as unknown as typeof base),
    ).toThrow(/move must be a function/);
  });

  it("may update firmware and ask devices how they are, with functions for each", () => {
    const firmware = {
      check: async () => {},
      update: async () => {},
      stop: async () => {},
    };
    const app = defineApp({
      ...base,
      permissions: [{ id: "devices.register", reason: "For the test." }],
      driver: { ...driver, firmware, probe: async () => {} },
    });
    expect(app.driver?.firmware).toBe(firmware);
    expect(() =>
      defineApp({
        ...base,
        permissions: [{ id: "devices.register", reason: "For the test." }],
        driver: { ...driver, firmware: { check: firmware.check } },
      } as unknown as typeof base),
    ).toThrow(/check, update and stop functions/);
    expect(() =>
      defineApp({
        ...base,
        permissions: [{ id: "devices.register", reason: "For the test." }],
        driver: { ...driver, probe: "ping" },
      } as unknown as typeof base),
    ).toThrow(/probe must be a function/);
  });

  it("have lifecycle hooks that are functions, like any app", () => {
    expect(() =>
      defineApp({ ...base, start: "connect" } as unknown as typeof base),
    ).toThrow(/start must be a function/);
  });
});

describe("action types", () => {
  it("give a caller's input before defaults and the output", () => {
    const action = defineAction({
      ...addItem,
      input: z.object({ listId: z.string(), limit: z.number().default(10) }),
      async run(_ctx, input) {
        return { itemId: `${input.listId}:${input.limit}` };
      },
    });
    expectTypeOf<ActionInput<typeof action>>().toEqualTypeOf<{
      listId: string;
      limit?: number | undefined;
    }>();
    expectTypeOf<ActionOutput<typeof action>>().toEqualTypeOf<{
      itemId: string;
    }>();
  });
});

describe("what an app provides", () => {
  const list = defineEntityType({
    id: "example.list",
    title: "List",
    state: z.object({ items: z.number().int() }),
  });
  const board = defineWidget({
    id: "example.board",
    title: "Board",
    size: { columns: 4, rows: 4 },
    preview: {
      blocks: [{ kind: "headline", value: "5 items" }],
    },
  });

  it("is declared in its static manifest, with each state's schema", () => {
    const app = defineApp({
      ...base,
      provides: { entities: [list, sunType], widgets: [board] },
    });
    expect(toStaticManifest(app).provides).toEqual({
      entities: [
        {
          id: "example.list",
          title: "List",
          standard: false,
          state: expect.objectContaining({ type: "object" }),
        },
        {
          id: "sun",
          title: "Sun",
          standard: true,
          state: expect.objectContaining({ type: "object" }),
        },
      ],
      widgets: [
        {
          id: "example.board",
          title: "Board",
          size: { columns: 4, rows: 4 },
          preview: { blocks: [{ kind: "headline", value: "5 items" }] },
        },
      ],
      roomSections: [],
      devicePages: [],
      triggers: [],
      conditions: [],
      steps: [],
    });
    expect(toStaticManifest(defineApp(base)).provides).toEqual({
      entities: [],
      widgets: [],
      roomSections: [],
      devicePages: [],
      triggers: [],
      conditions: [],
      steps: [],
    });
  });

  it("takes the core's definition of a standard type, whatever the app's copy says", () => {
    const copy = { ...sunType, state: z.object({}) };
    const app = defineApp({ ...base, provides: { entities: [copy] } });
    expect(entityTypeOf(app, "sun")).toBe(sunType);
    expect(entityTypeOf(app, "weather.forecast")).toBeUndefined();
  });

  it("keeps an app's own types namespaced and apart from the standard ones", () => {
    expect(() =>
      defineApp({
        ...base,
        provides: { entities: [{ ...list, id: "list" }] },
      }),
    ).toThrow('Entity type "list" must be namespaced');
    expect(() =>
      defineApp({
        ...base,
        provides: { entities: [{ ...forecastType, standard: false }] },
      }),
    ).toThrow('"weather.forecast" is a standard entity type');
    expect(() =>
      defineApp({
        ...base,
        provides: { entities: [{ ...list, standard: true }] },
      }),
    ).toThrow('"example.list" is not one of the core\'s standard entity types');
    expect(() =>
      defineApp({ ...base, provides: { entities: [list, list] } }),
    ).toThrow('Duplicate entity type id "example.list"');
  });

  it("has a widget's cards be entities of the widget's own type", () => {
    const app = defineApp({ ...base, provides: { widgets: [board] } });
    expect(entityTypeOf(app, "example.board")).toMatchObject({
      id: "example.board",
      title: "Board",
    });
    expect(() =>
      defineApp({
        ...base,
        provides: {
          entities: [{ ...list, id: "example.board" }],
          widgets: [board],
        },
      }),
    ).toThrow("so no entity type may have its id");
    expect(() =>
      defineApp({
        ...base,
        provides: { widgets: [{ ...board, id: "sun" }] },
      }),
    ).toThrow("needs a namespaced id");
  });
});

describe("settings", () => {
  const temperatureUnit = z
    .enum(["celsius", "fahrenheit"])
    .default("celsius")
    .meta({
      title: "Temperature unit",
      options: { celsius: "Celsius", fahrenheit: "Fahrenheit" },
    });

  it("are declared in the static manifest as JSON Schema, for the form", () => {
    const app = defineApp({
      ...base,
      settings: z.object({
        temperatureUnit,
        showFeelsLike: z.boolean().default(false).meta({ title: "Feels like" }),
        days: z.number().int().min(1).max(14).default(7).meta({
          title: "Days",
          description: "How many days the forecast shows",
        }),
        stationName: z.string().max(40).optional().meta({ title: "Station" }),
      }),
    });

    expect(toStaticManifest(app).settings).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        temperatureUnit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          default: "celsius",
          title: "Temperature unit",
          options: { celsius: "Celsius", fahrenheit: "Fahrenheit" },
        },
        showFeelsLike: { type: "boolean", default: false, title: "Feels like" },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 14,
          default: 7,
          title: "Days",
          description: "How many days the forecast shows",
        },
        stationName: { type: "string", maxLength: 40, title: "Station" },
      },
    });
  });

  it("are null in the manifest of an app without any", () => {
    expect(toStaticManifest(defineApp(base)).settings).toBeNull();
  });

  it.each([
    ["not a zod object", z.string(), /are a zod object/],
    [
      "a setting without a title",
      z.object({ days: z.number().default(7) }),
      /"days" needs a title/,
    ],
    [
      "a setting without a default",
      z.object({ days: z.number().meta({ title: "Days" }) }),
      /needs a default/,
    ],
    [
      "a list",
      z.object({
        days: z.array(z.string()).default([]).meta({ title: "Days" }),
      }),
      /must be a choice, a switch, a number or text/,
    ],
    [
      "a setting that may be null",
      z.object({
        station: z.string().nullable().default(null).meta({ title: "Station" }),
      }),
      /must be a choice, a switch, a number or text/,
    ],
    [
      "a choice without its options' titles",
      z.object({
        unit: z
          .enum(["celsius", "fahrenheit"])
          .default("celsius")
          .meta({ title: "Unit", options: { celsius: "Celsius" } }),
      }),
      /needs a title for fahrenheit/,
    ],
    [
      "options on something other than a choice",
      z.object({
        days: z
          .number()
          .default(7)
          .meta({ title: "Days", options: { 7: "A week" } }),
      }),
      /needs a z.enum/,
    ],
    [
      "a name that is not one word",
      z.object({
        "temperature-unit": temperatureUnit,
      }),
      /needs a name such as temperatureUnit/,
    ],
    [
      "a schema without a JSON Schema",
      z.object({
        since: z.date().default(new Date()).meta({ title: "Since" }),
      }),
      /must have a JSON Schema/,
    ],
    [
      "a transform hidden by the input JSON Schema",
      z.object({
        station: z
          .string()
          .transform((name) => ({ name }))
          .default({ name: "Home" })
          .meta({ title: "Station" }),
      }),
      /must have a JSON Schema/,
    ],
    [
      "a value that parses into something the form cannot show",
      z.object({
        station: z
          .codec(z.string(), z.object({ name: z.string() }), {
            decode: (name) => ({ name }),
            encode: (station) => station.name,
          })
          .default({ name: "Home" })
          .meta({ title: "Station" }),
      }),
      /must parse to the kind of value it takes/,
    ],
    [
      "numeric choices that the form would send as strings",
      z.object({
        speed: z
          .enum({ Low: 1, High: 2 })
          .default(1)
          .meta({ title: "Speed", options: { 1: "Low", 2: "High" } }),
      }),
      /needs string choices/,
    ],
  ])("refuse %s", (_case, settings, error) => {
    expect(() =>
      defineApp({ ...base, settings: settings as z.ZodObject }),
    ).toThrow(error);
  });

  it("are read from the core with ctx.settings.get()", async () => {
    const ctx = createAppContext({
      appId: base.id,
      actor: { kind: "app", id: base.id },
      core: {
        ...noCore,
        settings: async () => ({ temperatureUnit: "celsius" }),
      },
    });

    expect(await ctx.settings.get()).toEqual({ temperatureUnit: "celsius" });
  });
});

describe("permissions", () => {
  it("each come with a reason, and say whether the app needs them to work", () => {
    const manifest = toStaticManifest(
      defineApp({
        ...base,
        permissions: [
          { id: "people.read", reason: "  To show whose turn it is. " },
          {
            id: "notifications.send",
            reason: "To remind you of a task.",
            needed: true,
          },
        ],
      }),
    );
    expect(manifest.permissions).toEqual([
      {
        id: "people.read",
        reason: "To show whose turn it is.",
        needed: false,
        asked: null,
        startsOn: false,
      },
      {
        id: "notifications.send",
        reason: "To remind you of a task.",
        needed: true,
        asked: null,
        startsOn: false,
      },
    ]);
  });

  it("say when an optional one is asked, or that it starts on, but never for one the app needs", () => {
    const manifest = toStaticManifest(
      defineApp({
        ...base,
        permissions: [
          {
            id: "people.read",
            reason: "To show who added each item.",
            asked: " when you choose who an item is for ",
          },
          {
            id: "places.read",
            reason: "To list your rooms.",
            startsOn: true,
            asked: "with people",
          },
        ],
      }),
    );
    expect(manifest.permissions).toMatchObject([
      { asked: "when you choose who an item is for", startsOn: false },
      { asked: "with people", startsOn: true },
    ]);
    for (const wrong of [
      { asked: "When you choose" },
      { asked: "once a week" },
      { asked: `when ${"x".repeat(60)}` },
      { asked: "when you\nchoose" },
      { needed: true, asked: "when you choose" },
      { needed: true, startsOn: true },
    ]) {
      expect(() =>
        defineApp({
          ...base,
          permissions: [{ id: "people.read", reason: "To show.", ...wrong }],
        }),
      ).toThrow();
    }
  });

  it("need a short reason, so a phone shows it whole", () => {
    for (const reason of ["", "   ", "x".repeat(81)]) {
      expect(() =>
        defineApp({ ...base, permissions: [{ id: "people.read", reason }] }),
      ).toThrow();
    }
    expect(
      defineApp({
        ...base,
        permissions: [{ id: "people.read", reason: "x".repeat(80) }],
      }).permissions,
    ).toHaveLength(1);
  });

  it("are asked for once each", () => {
    const ask = { id: "people.read", reason: "To show who lives here." };
    expect(() => defineApp({ ...base, permissions: [ask, ask] })).toThrow(
      /permission/,
    );
  });

  it("an app holds now are read from the core with ctx.permissions.list()", async () => {
    const ctx = createAppContext({
      appId: base.id,
      actor: { kind: "app", id: base.id },
      core: { ...noCore, permissions: async () => ["people.read"] },
    });

    expect(await ctx.permissions.list()).toEqual(["people.read"]);
  });
});

describe("actors", () => {
  it("include the shared client, which acts as the household", () => {
    expect(actorSchema.parse({ kind: "client", id: "kitchen" })).toEqual({
      kind: "client",
      id: "kitchen",
    });
  });
});

// A core that answers nothing but what a test gives it.
const unused = async (): Promise<never> => {
  throw new Error("not in this test");
};
const noCore: CoreCalls = {
  query: unused,
  serviceConnection: unused,
  settings: unused,
  permissions: unused,
  permissionsRevision: unused,
  people: unused,
  places: unused,
  devices: unused,
  device: unused,
  command: unused,
  register: unused,
  report: unused,
  present: unused,
  press: unused,
  release: unused,
  emit: unused,
  follow: unused,
  scheduleJob: unused,
  cancelJob: unused,
  jobs: unused,
  putWorkflow: unused,
  removeWorkflow: unused,
  workflows: unused,
  location: unused,
  publish: unused,
  unpublish: unused,
  entities: unused,
  fetch: unused,
  firmware: unused,
  joining: unused,
  secret: unused,
  putSecret: unused,
  removeSecret: unused,
  log() {},
};

describe("createAppContext", () => {
  it("sends the app's Drizzle queries to the core as messages", async () => {
    const queries: unknown[] = [];
    const core: CoreCalls = {
      ...noCore,
      async query(query) {
        queries.push(query);
        return { rows: query.method === "get" ? [1] : [[1], [2]] };
      },
    };
    const ctx = createAppContext({
      appId: base.id,
      actor: { kind: "client", id: "kitchen" },
      core,
    });

    const all = await ctx.storage.db.all<[number]>("select 1 where 1 = ?");

    expect(all).toEqual([[1], [2]]);
    expect(queries).toEqual([
      { sql: "select 1 where 1 = ?", params: [], method: "all" },
    ]);
    expect(ctx.actor).toEqual({ kind: "client", id: "kitchen" });
  });
});

describe("toStaticManifest", () => {
  it("leaves an app's origin to the core", () => {
    // The core decides it from where the package came from, so a claim in the
    // definition never reaches the manifest.
    const claimed = { ...base, origin: "system" };

    expect(toStaticManifest(defineApp(claimed))).not.toHaveProperty("origin");
  });

  it("describes caller input before defaults and transforms are applied", () => {
    const action = defineAction({
      ...addItem,
      input: z.object({
        name: z
          .string()
          .transform((value) => value.length)
          .pipe(z.number()),
        limit: z.number().default(10),
      }),
      output: z.object({ itemId: z.string() }),
      async run(_ctx, input) {
        expectTypeOf(input).toEqualTypeOf<{ name: number; limit: number }>();
        return { itemId: String(input.name) };
      },
    });
    const manifest = toStaticManifest(
      defineApp({ ...base, actions: [action] }),
    );
    expect(manifest.actions[0]?.input).toMatchObject({
      required: ["name"],
      properties: { name: { type: "string" }, limit: { default: 10 } },
    });
  });

  it("lets the core validate and transform an action's returned value", async () => {
    const action = defineAction({
      ...addItem,
      output: z
        .string()
        .transform((value) => value.length)
        .pipe(z.number()),
      async run() {
        return "item";
      },
    });
    const ctx = createAppContext({
      appId: base.id,
      actor: { kind: "user", id: "test" },
      core: { ...noCore, query: async () => ({ rows: [] }) },
    });
    const result = await action.run(ctx, { listId: "board", name: "milk" });
    expect(action.output.parse(result)).toBe(4);
    expect(
      toStaticManifest({ ...base, actions: [action] }).actions[0]?.output,
    ).toMatchObject({ type: "number" });
  });

  it("serializes schemas to JSON Schema", () => {
    const manifest = toStaticManifest(defineApp(base));
    expect(manifest.actions[0]?.input).toMatchObject({
      type: "object",
      required: ["listId", "name"],
    });
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe("isActionError", () => {
  it("recognises a refusal from another copy of the SDK by its name and code", () => {
    // What an ActionError from an app's own copy of this package looks like.
    class OtherActionError extends Error {
      constructor(readonly code: string) {
        super(code);
        this.name = "ActionError";
      }
    }

    expect(isActionError(new ActionError("not_found"))).toBe(true);
    expect(isActionError(new OtherActionError("forbidden"))).toBe(true);
    expect(isActionError(new OtherActionError("teapot"))).toBe(false);
    expect(isActionError(new Error("not_found"))).toBe(false);
    expect(isActionError({ name: "ActionError", code: "forbidden" })).toBe(
      false,
    );
  });
});
