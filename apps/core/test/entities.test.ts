import {
  defineAction,
  defineApp,
  defineEntityType,
  sunType,
  type AppDefinition,
} from "@meetsanctum/app-sdk";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openLive, personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// What apps bring to the home: an app publishes entities of the types it
// declares, the core keeps them as the app's catalog, and other apps read them
// by standard type only.

const sunOn = (date: string) => ({
  date,
  sunrise: `${date}T06:18:00.000Z`,
  sunset: `${date}T16:12:00.000Z`,
  solarNoon: `${date}T11:15:00.000Z`,
});
const sun = {
  date: "2026-10-29",
  timeZone: "Europe/Zurich",
  days: [sunOn("2026-10-28"), sunOn("2026-10-29"), sunOn("2026-10-30")],
};

// An app's own type, which only it shows, and not for shared clients.
const cloud = defineEntityType({
  id: "sky.cloud",
  title: "Cloud",
  state: z.object({ cover: z.number().min(0).max(100) }),
});

// Publishes or removes whatever a test asks, as the app.
const publish = defineAction({
  id: "sky.publish",
  title: "Publish",
  tier: "write",
  input: z.object({
    type: z.string(),
    key: z.string(),
    name: z.string(),
    state: z.unknown(),
  }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.entities.publish(input);
    return {};
  },
});
const remove = defineAction({
  id: "sky.remove",
  title: "Remove",
  tier: "write",
  input: z.object({ key: z.string() }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.entities.remove(input.key);
    return {};
  },
});
const read = defineAction({
  id: "clock.read",
  title: "Read",
  tier: "read",
  input: z.object({ type: z.string() }),
  output: z.unknown(),
  async run(ctx, input) {
    return ctx.entities.list(input.type);
  },
});

const sky = defineApp({
  id: "test.sky",
  name: "Sky",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  actions: [publish, remove],
  events: [],
  provides: { entities: [sunType, cloud] },
});

const clock = (permissions: string[]) =>
  defineApp({
    id: "test.clock",
    name: "Clock",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: permissions.map((id) => ({ id, reason: "For the test." })),
    actions: [read],
    events: [],
  });

async function home(apps: AppDefinition[] = [sky]) {
  const core = await testCore({
    apps: apps.map((app) => ({ app, origin: "official" as const })),
  });
  const maya = await claimed(core);
  return { core, maya };
}

function action(
  core: TestCore,
  token: string,
  app: string,
  id: string,
  input: object,
) {
  return post(core, `/api/apps/${app}/actions/${id}`, input, { token });
}

describe("entities", () => {
  it("are what an app publishes, kept by the core as its catalog", async () => {
    const { core, maya } = await home();

    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sun",
      key: "home",
      name: "Home",
      state: sun,
    });
    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sky.cloud",
      key: "over-home",
      name: "Over the home",
      state: { cover: 40 },
    });

    const all = (await get(core, "/api/entities", maya)).json();
    expect(all).toEqual([
      {
        app: "test.sky",
        key: "home",
        type: "sun",
        name: "Home",
        state: sun,
        updatedAt: "2026-10-26T12:00:00.000Z",
      },
      expect.objectContaining({ key: "over-home", state: { cover: 40 } }),
    ]);
    expect((await get(core, "/api/entities?type=sun", maya)).json()).toEqual([
      all[0],
    ]);
    expect(
      (await get(core, "/api/entities?app=test.clock", maya)).json(),
    ).toEqual([]);
    expect((await get(core, "/api/entities")).statusCode).toBe(401);
  });

  it("must fit a type their app declares", async () => {
    const { core, maya } = await home();
    const tryPublish = (state: unknown, type = "sun") =>
      action(core, maya.token, "test.sky", "sky.publish", {
        type,
        key: "home",
        name: "Home",
        state,
      });

    expect(
      (await tryPublish({ ...sun, days: [sunOn("dawn")] })).statusCode,
    ).toBe(500);
    expect(
      (await tryPublish({ ...sun, timeZone: "Mars/Olympus" })).statusCode,
    ).toBe(500);
    expect((await tryPublish(sun, "weather.forecast")).statusCode).toBe(500);
    expect((await get(core, "/api/entities", maya)).json()).toEqual([]);
    expect(core.logs.join("\n")).toContain(
      "test.sky does not provide weather.forecast",
    );
    expect(core.logs.join("\n")).toContain("does not fit sun");
  });

  it("change only when what they hold changes", async () => {
    const { core, maya } = await home();
    const again = () =>
      action(core, maya.token, "test.sky", "sky.publish", {
        type: "sun",
        key: "home",
        name: "Home",
        state: sun,
      });

    await again();
    core.advance(60_000);
    await again();
    expect((await get(core, "/api/entities", maya)).json()[0].updatedAt).toBe(
      "2026-10-26T12:00:00.000Z",
    );
  });

  it("reach every client, shared ones too", async () => {
    const { core, maya } = await home();
    const kitchen = sharedClient(core);
    const ben = personWithClient(core);
    for (const [type, key, state] of [
      ["sun", "home", sun],
      ["sky.cloud", "over-home", { cover: 40 }],
    ] as const) {
      await action(core, maya.token, "test.sky", "sky.publish", {
        type,
        key,
        name: key,
        state,
      });
    }
    const keys = async (token: string) =>
      (await get(core, "/api/entities", { token }))
        .json()
        .map((entity: { key: string }) => entity.key);

    expect(await keys(kitchen.token)).toEqual(["home", "over-home"]);
    expect(await keys(ben.token)).toEqual(["home", "over-home"]);
  });

  it("are read by other apps by standard type, with its permission", async () => {
    const { core, maya } = await home([sky, clock(["entities.read:sun"])]);
    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sun",
      key: "home",
      name: "Home",
      state: sun,
    });

    const read = await action(core, maya.token, "test.clock", "clock.read", {
      type: "sun",
    });
    expect(read.json()).toEqual([expect.objectContaining({ state: sun })]);
    expect(
      (
        await action(core, maya.token, "test.clock", "clock.read", {
          type: "weather.forecast",
        })
      ).statusCode,
    ).toBe(500);
    expect(core.logs.join("\n")).toContain(
      "test.clock does not hold entities.read:weather.forecast",
    );
  });

  it("of an app's own type stay out of other apps' reach", async () => {
    const { core, maya } = await home([
      sky,
      clock(["entities.read:sky.cloud"]),
    ]);

    expect(
      (
        await action(core, maya.token, "test.clock", "clock.read", {
          type: "sky.cloud",
        })
      ).statusCode,
    ).toBe(500);
    expect(core.logs.join("\n")).toContain(
      "sky.cloud is not a standard entity type",
    );
  });

  it("reach live clients as they change and go", async () => {
    const { core, maya } = await home();
    const kitchen = sharedClient(core);
    const mine = await openLive(core, maya.token);
    const shared = await openLive(core, kitchen.token);

    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sky.cloud",
      key: "over-home",
      name: "Over the home",
      state: { cover: 40 },
    });
    await action(core, maya.token, "test.sky", "sky.remove", {
      key: "over-home",
    });
    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sun",
      key: "home",
      name: "Home",
      state: sun,
    });

    const entities = (messages: { type: string }[]) =>
      messages.filter((message) => message.type === "entity");
    await expect.poll(() => entities(mine.messages).length).toBe(3);
    expect(entities(mine.messages)).toEqual([
      {
        type: "entity",
        app: "test.sky",
        key: "over-home",
        entity: expect.objectContaining({ state: { cover: 40 } }),
        was: null,
      },
      {
        type: "entity",
        app: "test.sky",
        key: "over-home",
        entity: null,
        was: "sky.cloud",
      },
      expect.objectContaining({ key: "home", was: null }),
    ]);
    // A shared client hears the same.
    await expect.poll(() => entities(shared.messages).length).toBe(3);
    expect(entities(shared.messages)).toEqual(entities(mine.messages));
  });

  it("go with their app, and with the types it no longer declares", async () => {
    const { core, maya } = await home();
    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sun",
      key: "home",
      name: "Home",
      state: sun,
    });
    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sky.cloud",
      key: "over-home",
      name: "Over the home",
      state: { cover: 40 },
    });

    // Restarted with a version that no longer brings clouds.
    const next = await testCore({
      dataDir: core.dataDir,
      apps: [
        {
          origin: "official",
          app: defineApp({ ...sky, provides: { entities: [sunType] } }),
        },
      ],
    });
    expect(next.entities.list().map((each) => each.key)).toEqual(["home"]);

    await next.apps.remove("test.sky");
    expect(next.entities.list()).toEqual([]);
  });

  it("rechecks persisted entities when a type's schema changes", async () => {
    const { core, maya } = await home();
    for (const [key, cover] of [
      ["valid", 20],
      ["invalid", 80],
    ] as const) {
      await action(core, maya.token, "test.sky", "sky.publish", {
        type: cloud.id,
        key,
        name: key,
        state: { cover },
      });
    }
    expect(core.entities.list()).toHaveLength(2);

    const next = await testCore({
      dataDir: core.dataDir,
      apps: [
        {
          origin: "official",
          app: defineApp({
            ...sky,
            provides: {
              entities: [
                {
                  ...cloud,
                  state: z.object({ cover: z.number().max(50) }),
                },
              ],
            },
          }),
        },
      ],
    });

    expect(next.entities.list().map((each) => each.key)).toEqual(["valid"]);
  });

  it("stay when their app's database cannot open", async () => {
    const { core, maya } = await home();
    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sun",
      key: "home",
      name: "Home",
      state: sun,
    });

    // As after a failed migration: the app is not installed this time.
    const next = await testCore({
      dataDir: core.dataDir,
      apps: [
        {
          origin: "official",
          app: sky,
          migrationsFolder: join(core.dataDir, "no-such-migrations"),
        },
      ],
    });
    expect(next.logs.join("\n")).toContain("test.sky was not installed");
    expect(next.entities.list().map((each) => each.key)).toEqual(["home"]);
  });

  it("of an app the core no longer has go when it starts", async () => {
    const { core, maya } = await home();
    await action(core, maya.token, "test.sky", "sky.publish", {
      type: "sun",
      key: "home",
      name: "Home",
      state: sun,
    });

    const next = await testCore({ dataDir: core.dataDir });
    expect(next.entities.list()).toEqual([]);
  });
});
