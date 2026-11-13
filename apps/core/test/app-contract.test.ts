import {
  defineAction,
  defineApp,
  defineEvent,
  names,
  toStaticManifest,
  type AppContext,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createActivity } from "../src/activity/activity.js";
import {
  checkManifest,
  contractOf,
  schemaCheck,
} from "../src/app-host/contract.js";
import { loadAppPackages } from "./runner-apps.js";
import { namedInSchema } from "../src/workflows/named.js";
import { claimed, get, post, testCore } from "./support.js";

// The core knows an app by its manifest: it checks everything that crosses to
// it against the manifest's JSON Schemas, while the app's own zod objects parse
// on the app's side, so what only the app can run still holds.

const base = {
  name: "Contract",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  actions: [],
  events: [],
};

describe("a check against a manifest's schema", () => {
  const check = schemaCheck(
    z.toJSONSchema(
      z.object({
        name: z.string().min(2),
        size: z.number().default(3),
        items: z.array(z.object({ id: z.string() })).optional(),
      }),
      { io: "input" },
    ),
  );

  it("fills in defaults on a copy of what it checks", () => {
    const value = { name: "ab" };

    expect(check(value)).toEqual({
      success: true,
      data: { name: "ab", size: 3 },
    });
    expect(value).toEqual({ name: "ab" });
  });

  it("says where a value doesn't fit", () => {
    const result = check({ name: "a", items: [{}] });

    expect(result.success).toBe(false);
    expect(!result.success && result.issues.map(({ path }) => path)).toEqual([
      ["name"],
      ["items", 0, "id"],
    ]);
  });

  it("fills defaults inside the matching union branch without changing other branches", () => {
    const schema = z.toJSONSchema(
      z.object({
        place: z.union([
          z.object({
            kind: z.literal("room"),
            room: z.string().default("study"),
          }),
          z.object({
            kind: z.literal("home"),
            label: z.string().default("Home"),
          }),
        ]),
      }),
      { io: "input" },
    );
    const check = schemaCheck(schema);
    const value = { place: { kind: "home" } };

    expect(check(value)).toEqual({
      success: true,
      data: { place: { kind: "home", label: "Home" } },
    });
    expect(value).toEqual({ place: { kind: "home" } });
  });

  it("resolves root defaults and nested unions through local references", () => {
    const schema = z.object({
      room: z.union([names("room").default("study"), z.number()]),
      get children() {
        return z.array(schema).optional();
      },
    });
    const value = { children: [{}] };

    expect(schemaCheck(z.toJSONSchema(schema, { io: "input" }))(value)).toEqual(
      {
        success: true,
        data: { room: "study", children: [{ room: "study" }] },
      },
    );
    expect(value).toEqual({ children: [{}] });
  });

  it("never fills defaults into what every object inherits", () => {
    // As a manifest's JSON would give it, with `__proto__` as a real key.
    const check = schemaCheck(
      JSON.parse(`{
        "type": "object",
        "properties": {
          "__proto__": {
            "type": "object",
            "properties": { "polluted": { "default": true } }
          },
          "constructor": { "type": "string" }
        }
      }`) as object,
    );

    expect(check({}).success).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("answers rather than overflows for a schema that refers to itself", () => {
    const result = schemaCheck({ $ref: "#" })("text");

    expect(result.success).toBe(false);
  });

  it("fills defaults at every level of a schema that refers to itself and ends", () => {
    let value: Record<string, unknown> = {};
    for (let level = 0; level < 100; level++) value = { child: value };

    const result = schemaCheck({
      $defs: {
        node: {
          type: "object",
          properties: {
            label: { type: "string", default: "unnamed" },
            child: { $ref: "#/$defs/node" },
          },
        },
      },
      $ref: "#/$defs/node",
    })(value);

    expect(result.success).toBe(true);
    let levels = 0;
    let node = (result as { data: Record<string, unknown> }).data;
    while (node) {
      expect(node.label).toBe("unnamed");
      levels += 1;
      node = node.child as Record<string, unknown>;
    }
    expect(levels).toBe(101);
  });

  it("answers rather than throws for a schema it can't compile", () => {
    const result = schemaCheck({ pattern: "(" })("text");

    expect(result.success).toBe(false);
  });
});

describe("what a config names, from a manifest's schema", () => {
  const schema = z.toJSONSchema(
    z.object({
      place: z.union([
        z.object({ kind: z.literal("room"), id: names("room") }),
        z.object({ kind: z.literal("zone"), id: names("zone") }),
      ]),
      lights: z.array(z.object({ device: names("device") })),
      fallback: names("room").default("hall"),
      note: z.string(),
    }),
    { io: "input" },
  ) as Record<string, unknown>;

  it("doesn't read a name from what every object inherits", () => {
    expect(
      namedInSchema(
        JSON.parse(`{
          "type": "object",
          "properties": {
            "__proto__": {
              "type": "object",
              "properties": { "room": { "type": "string", "names": "room" } }
            }
          }
        }`) as Record<string, unknown>,
        {},
      ),
    ).toEqual([]);
  });

  it("stops at a schema that refers to itself without going deeper", () => {
    expect(namedInSchema({ anyOf: [{ $ref: "#" }] }, { room: "hall" })).toEqual(
      [],
    );
  });

  it("follows the union option the config takes, lists and defaults", () => {
    expect(
      namedInSchema(schema, {
        place: { kind: "zone", id: "upstairs" },
        lights: [{ device: "lamp" }],
        note: "kitchen",
      }),
    ).toEqual([
      { kind: "zone", id: "upstairs", field: "place.id" },
      { kind: "device", id: "lamp", field: "lights.0.device" },
      { kind: "room", id: "hall", field: "fallback" },
    ]);
  });
});

describe("an app's manifest", () => {
  // An action whose code is looser than its manifest, as a manifest out of
  // step would be, and one whose refinement only the app can run.
  const ran: unknown[] = [];
  const loose = defineAction({
    id: "contract.loose",
    title: "Loose",
    tier: "write",
    input: z.object({ size: z.number() }),
    output: z.object({ size: z.number() }),
    async run(_ctx, input) {
      ran.push(input);
      return input;
    },
  });
  const refined = defineAction({
    id: "contract.refined",
    title: "Refined",
    tier: "write",
    input: z
      .object({ from: z.number(), to: z.number() })
      .refine(({ from, to }) => from < to, "from before to"),
    output: z.object({}),
    run: async () => ({}),
  });
  const app = defineApp({
    ...base,
    id: "test.contract",
    actions: [loose, refined],
  });

  async function core(change: (manifest: StaticManifest) => void = () => {}) {
    const manifest = toStaticManifest(app);
    change(manifest);
    const started = await testCore({
      apps: [{ app, manifest, origin: "official" }],
    });
    const { token } = await claimed(started);
    return { started, token };
  }

  it("decides what an action takes, whatever its code would", async () => {
    ran.length = 0;
    const { started, token } = await core((manifest) => {
      const input = manifest.actions[0]!.input as unknown as {
        properties: { size: Record<string, unknown> };
      };
      input.properties.size.maximum = 10;
    });

    const refused = await post(
      started,
      "/api/apps/test.contract/actions/contract.loose",
      { size: 11 },
      { token },
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "invalid_request" });
    expect(ran).toEqual([]);
  });

  it("decides what an action may return", async () => {
    const { started, token } = await core((manifest) => {
      const output = manifest.actions[0]!.output as unknown as {
        properties: { size: Record<string, unknown> };
      };
      output.properties.size.maximum = 10;
    });

    const failed = await post(
      started,
      "/api/apps/test.contract/actions/contract.loose",
      { size: 11 },
      { token },
    );

    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "app_failed" });
  });

  it("leaves what JSON can't say to the app's own schema", async () => {
    const { started, token } = await core();

    const refused = await post(
      started,
      "/api/apps/test.contract/actions/contract.refined",
      { from: 2, to: 1 },
      { token },
    );
    const taken = await post(
      started,
      "/api/apps/test.contract/actions/contract.refined",
      { from: 1, to: 2 },
      { token },
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "invalid_request" });
    expect(taken.statusCode).toBe(200);
  });

  it("returns the output the manifest checked, including its defaults", async () => {
    const { started, token } = await core((manifest) => {
      const output = manifest.actions[0]!.output as unknown as {
        properties: Record<string, unknown>;
        required: string[];
      };
      output.properties.label = {
        type: "string",
        default: "From its manifest",
      };
      output.required.push("label");
    });

    const response = await post(
      started,
      "/api/apps/test.contract/actions/contract.loose",
      { size: 1 },
      { token },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ size: 1, label: "From its manifest" });
  });

  it("is what clients see, and what the gate goes by", async () => {
    const { started, token } = await core((manifest) => {
      manifest.name = "From its manifest";
      manifest.actions[0]!.tier = "irreversible-external";
    });

    const apps = (await get(started, "/api/apps", { token })).json() as {
      id: string;
      name: string;
    }[];
    const manifest = (
      await get(started, "/api/apps/test.contract/manifest", { token })
    ).json() as { name: string };

    expect(apps.find(({ id }) => id === "test.contract")?.name).toBe(
      "From its manifest",
    );
    expect(manifest.name).toBe("From its manifest");
    // Its code says write, and its manifest says otherwise.
    expect(() =>
      started.workflows.jobs.schedule("test.contract", {
        key: "often",
        action: loose.id,
        input: { size: 1 },
        when: { every: 60 },
      }),
    ).toThrow("so it cannot run as a job");
  });

  it.each([
    ["read", "write", false],
    ["read", "write", true],
    ["write", "read", false],
    ["write", "read", true],
  ] as const)(
    "logs a code %s as its manifest's %s, including a failure: %s",
    async (codeTier, declaredTier, hasFailed) => {
      const action = defineAction({
        ...loose,
        tier: codeTier,
        async run(_ctx, input) {
          if (hasFailed) throw new Error("failed");
          return input;
        },
      });
      const app = defineApp({ ...base, id: "test.logged", actions: [action] });
      const manifest = toStaticManifest(app);
      manifest.actions[0]!.tier = declaredTier;
      const started = await testCore({
        apps: [{ app, manifest, origin: "official" }],
      });
      const { token } = await claimed(started);

      const response = await post(
        started,
        `/api/apps/${app.id}/actions/${action.id}`,
        { size: 1 },
        { token },
      );

      expect(response.statusCode).toBe(hasFailed ? 500 : 200);
      const entries = createActivity(started.db)
        .recent()
        .filter((entry) => entry.action === action.id);
      expect(entries).toMatchObject(
        declaredTier === "read"
          ? []
          : [{ outcome: hasFailed ? "failed" : "ok" }],
      );
      expect(entries).toHaveLength(declaredTier === "read" ? 0 : 1);
    },
  );

  it.each([
    [
      "action",
      (manifest: StaticManifest) => manifest.actions.push(manifest.actions[0]!),
    ],
    ["page", (manifest: StaticManifest) => manifest.pages.push("room", "room")],
    [
      "permission",
      (manifest: StaticManifest) =>
        manifest.permissions.push(
          { id: "places.read", reason: "Twice." } as never,
          { id: "places.read", reason: "Twice." } as never,
        ),
    ],
  ])("can't have two of its %ss with one id", (kind, change) => {
    const manifest = toStaticManifest(app);
    change(manifest);

    expect(() => checkManifest(manifest)).toThrow(
      `its manifest has two of its ${kind}s called`,
    );
  });

  it("with parts missing keeps only its own package from installing", async () => {
    const { pages: _, ...incomplete } = toStaticManifest(app);
    const started = await testCore({
      apps: [
        {
          app,
          manifest: incomplete as StaticManifest,
          origin: "official",
        },
        {
          app: defineApp({ ...base, id: "test.other" }),
          origin: "official",
        },
      ],
    });
    const { token } = await claimed(started);

    const apps = await get(started, "/api/apps", { token });

    expect(apps.statusCode).toBe(200);
    expect((apps.json() as { id: string }[]).map(({ id }) => id)).toEqual([
      "test.other",
    ]);
    expect(started.logs.join("\n")).toContain("its manifest is incomplete");
  });

  it("tells clients the oldest of its pages it works with, which only its file can say", async () => {
    const { started, token } = await core((manifest) => {
      (manifest as { oldestPage?: string }).oldestPage = "0.9.0";
    });

    const apps = (await get(started, "/api/apps", { token })).json() as {
      id: string;
      oldestPage?: string;
    }[];

    expect(apps.find(({ id }) => id === "test.contract")?.oldestPage).toBe(
      "0.9.0",
    );
  });

  it.each([9, "0.9.0oops", "0.9.0.1", "00.9.0"])(
    "refuses an oldest page that isn't a version: %s",
    async (oldestPage) => {
      const { started, token } = await core((manifest) => {
        (manifest as { oldestPage?: unknown }).oldestPage = oldestPage;
      });

      const apps = (await get(started, "/api/apps", { token })).json() as {
        id: string;
      }[];

      expect(apps.map(({ id }) => id)).not.toContain("test.contract");
      expect(started.logs.join("\n")).toContain("oldestPage");
    },
  );

  it("is what counts, though the app's code has more", async () => {
    const { started, token } = await core((manifest) => {
      manifest.actions = manifest.actions.filter(({ id }) => id !== loose.id);
    });

    const missing = await post(
      started,
      "/api/apps/test.contract/actions/contract.loose",
      { size: 1 },
      { token },
    );

    expect(missing.statusCode).toBe(404);
  });
});

describe("what an app writes", () => {
  const event = defineEvent({
    id: "contract.happened",
    payload: z.object({ count: z.number().int() }),
  });
  const typeState = z
    .object({ low: z.number(), high: z.number() })
    .refine(({ low, high }) => low <= high, "low before high");
  let ctx: AppContext | undefined;
  const app = defineApp({
    ...base,
    id: "test.writes",
    permissions: [],
    events: [event],
    provides: {
      entities: [{ id: "contract.span", title: "Span", state: typeState }],
    },
    async start(context) {
      ctx = context;
    },
  });

  it("parses on its side, then the core checks what results", async () => {
    await testCore({ apps: [{ app, origin: "official" }] });
    const started = ctx!;

    await expect(
      started.entities.publish({
        type: "contract.span",
        key: "a",
        name: "A",
        state: { low: 2, high: 1 },
      }),
    ).rejects.toThrow("low before high");
    await expect(
      started.entities.publish({
        type: "contract.span",
        key: "a",
        name: "A",
        state: { low: 1, high: 2 },
      }),
    ).resolves.toBeUndefined();
    await expect(
      started.events.emit(event, { count: 1.5 } as never),
    ).rejects.toThrow("does not fit its schema");
  });

  it("are kept when a broken schema can't say whether they fit", async () => {
    const first = await testCore({ apps: [{ app, origin: "official" }] });
    await ctx!.entities.publish({
      type: "contract.span",
      key: "kept",
      name: "Kept",
      state: { low: 1, high: 2 },
    });
    const manifest = toStaticManifest(app);
    (manifest.provides.entities[0] as { state: unknown }).state = {
      pattern: "(",
    };

    const again = await testCore({
      apps: [{ app, manifest, origin: "official" }],
      dataDir: first.dataDir,
    });

    expect(
      again.entities.list({ app: "test.writes" }).map(({ key }) => key),
    ).toEqual(["kept"]);
  });

  it("is refused by the manifest however it was parsed", async () => {
    const manifest = toStaticManifest(app);
    const state = manifest.provides.entities[0]!.state as unknown as {
      properties: { low: Record<string, unknown> };
    };
    state.properties.low.minimum = 0;
    await testCore({ apps: [{ app, manifest, origin: "official" }] });

    await expect(
      ctx!.entities.publish({
        type: "contract.span",
        key: "a",
        name: "A",
        state: { low: -1, high: 2 },
      }),
    ).rejects.toThrow("does not fit contract.span");
  });
});

describe("the catalog's apps, from their packages", () => {
  const catalog = resolve(import.meta.dirname, "../../../catalog/apps");

  it("have manifests whose every schema compiles", async () => {
    const packages = await loadAppPackages(catalog, "official");

    expect(packages.map(({ app }) => app.id).sort()).toEqual([
      "sanctum.moods",
      "sanctum.natural-light",
      "sanctum.weather",
      "sanctum.zigbee",
    ]);
    for (const { manifest } of packages) {
      const contract = contractOf(manifest!);
      const checks = [
        ...[...contract.actions.values()].flatMap(({ input, output }) => [
          input,
          output,
        ]),
        ...contract.events.values(),
        ...[...contract.entityTypes.values()].map(({ state }) => state),
      ];
      for (const check of checks) {
        const result = check({});
        expect(
          !result.success &&
            result.issues.some(({ message }) =>
              message.startsWith("Its schema failed"),
            ),
        ).toBe(false);
      }
    }
  });

  it("start and do their work against the core", async () => {
    const started = await testCore({
      apps: await loadAppPackages(catalog, "official"),
    });
    const { token } = await claimed(started);
    const call = (app: string, action: string, input: object) =>
      post(started, `/api/apps/${app}/actions/${action}`, input, { token });

    const room = (
      await post(started, "/api/places/rooms/add", { name: "Den" }, { token })
    ).json() as { id: string };
    const moods = await call("sanctum.moods", "moods.moods", {
      roomId: room.id,
    });
    // Its refinement, that a span ends apart from where it starts, is one only
    // the app can run.
    const refused = await call("sanctum.moods", "moods.scheduleMood", {
      roomId: room.id,
      moodId: "no-such-mood",
      start: 600,
      end: 600,
    });
    const settings = await post(
      started,
      "/api/apps/sanctum.natural-light/settings/update",
      { nope: 1 },
      { token },
    );

    expect(moods.statusCode).toBe(200);
    expect(refused.statusCode).toBe(400);
    expect(settings.statusCode).toBe(400);
    expect(
      started.logs.filter((line) =>
        /was not installed|schema failed|does not fit|refuses/.test(line),
      ),
    ).toEqual([]);
  });
});
