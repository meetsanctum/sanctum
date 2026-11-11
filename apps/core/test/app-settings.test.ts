import {
  defineAction,
  defineApp,
  type AppDefinition,
  type AppInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createActivity } from "../src/activity/activity.js";
import { openLive, personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Apps' settings: an app declares its preferences as a schema, the core keeps
// what admins choose and fills in the defaults, every client of the home reads
// them and the app reads its own with ctx.settings.get().

const unit = (options: Record<string, string>) =>
  z
    .enum(Object.keys(options) as [string, ...string[]])
    .default("celsius")
    .meta({ title: "Temperature unit", options });
const units = { celsius: "Celsius", fahrenheit: "Fahrenheit" };

// What the app reads from the core, as an action shows it.
const readSettings = defineAction({
  id: "sky.settings",
  title: "Settings",
  tier: "read",
  input: z.object({}),
  output: z.record(z.string(), z.unknown()),
  run: (ctx) => ctx.settings.get(),
});

const sky = (settings: Record<string, string> = units): AppDefinition => ({
  id: "test.sky",
  name: "Sky",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  settings: z.object({
    temperatureUnit: unit(settings),
    days: z.number().int().min(1).max(14).default(7).meta({ title: "Days" }),
    note: z.string().max(2000).optional().meta({ title: "Note" }),
  }),
  actions: [readSettings],
  events: [],
});
const plain: AppDefinition = {
  ...sky(),
  id: "test.plain",
  name: "Plain",
  settings: undefined,
  actions: [],
};

async function home(app = sky()) {
  const core = await testCore({
    apps: [
      { origin: "official", app: defineApp(app) },
      { origin: "official", app: defineApp(plain) },
    ],
  });
  return { core, maya: await claimed(core) };
}

const settingsOf = (core: TestCore, token: string, app = "test.sky") =>
  get(core, `/api/apps/${app}/settings`, { token });
const change = (core: TestCore, token: string, changes: unknown) =>
  post(core, "/api/apps/test.sky/settings/update", changes, { token });
const asApp = async (core: TestCore, token: string) =>
  (
    await post(core, "/api/apps/test.sky/actions/sky.settings", {}, { token })
  ).json();

function activity(core: TestCore) {
  return createActivity(core.db)
    .recent()
    .filter((entry) => entry.action === "settings.update");
}

describe("an app's settings", () => {
  it("are its schema's defaults until an admin changes them", async () => {
    const { core, maya } = await home();
    const defaults = { temperatureUnit: "celsius", days: 7 };

    expect((await settingsOf(core, maya.token)).json()).toEqual(defaults);
    expect(await asApp(core, maya.token)).toEqual(defaults);
  });

  it("come with the installed apps as JSON Schema, for the form", async () => {
    const { core, maya } = await home();

    const apps: AppInfo[] = (await get(core, "/api/apps", maya)).json();

    expect(apps.find((app) => app.id === "test.sky")?.settings).toMatchObject({
      type: "object",
      properties: {
        temperatureUnit: { title: "Temperature unit", options: units },
        days: { type: "integer", default: 7 },
      },
    });
    expect(apps.find((app) => app.id === "test.plain")?.settings).toBeNull();
  });

  it("are what an admin chose, for the app and every client", async () => {
    const { core, maya } = await home();

    const changed = await change(core, maya.token, {
      temperatureUnit: "fahrenheit",
    });

    const chosen = { temperatureUnit: "fahrenheit", days: 7 };
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual(chosen);
    expect(await asApp(core, maya.token)).toEqual(chosen);
    const kitchen = sharedClient(core);
    expect((await settingsOf(core, kitchen.token)).json()).toEqual(chosen);
    expect(activity(core)).toMatchObject([
      {
        source: "test.sky",
        outcome: "ok",
        personId: maya.person!.id,
        clientId: maya.client.id,
        subjectId: "temperatureUnit",
      },
    ]);
  });

  it("take any value the app's schema allows, such as a long text", async () => {
    const { core, maya } = await home();
    const note = "n".repeat(1500);

    const changed = await change(core, maya.token, { note });

    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ note });
    expect(
      (await change(core, maya.token, { note: "n".repeat(2001) })).statusCode,
    ).toBe(400);
  });

  it("go back to the default when an admin clears one", async () => {
    const { core, maya } = await home();
    await change(core, maya.token, { temperatureUnit: "fahrenheit", days: 3 });

    const cleared = await change(core, maya.token, { temperatureUnit: null });

    expect(cleared.json()).toEqual({ temperatureUnit: "celsius", days: 3 });
  });

  it("are changed by everyone, shared clients too", async () => {
    const { core, maya } = await home();
    const kitchen = sharedClient(core);
    const ben = personWithClient(core);

    const shared = await change(core, kitchen.token, { days: 3 });
    const member = await change(core, ben.token, { days: 5 });

    expect(shared.json()).toMatchObject({ days: 3 });
    expect(member.json()).toMatchObject({ days: 5 });
    expect((await settingsOf(core, maya.token)).json()).toMatchObject({
      days: 5,
    });
    expect(
      activity(core).map(({ outcome, personId, clientId }) => ({
        outcome,
        personId,
        clientId,
      })),
    ).toEqual(
      expect.arrayContaining([
        { outcome: "ok", personId: null, clientId: kitchen.id },
        { outcome: "ok", personId: ben.person.id, clientId: ben.client.id },
      ]),
    );
  });

  it.each([
    ["a setting the app does not declare", { colour: "blue" }],
    ["a choice it does not offer", { temperatureUnit: "kelvin" }],
    ["a value out of its range", { days: 30 }],
    ["a value of another type", { days: "7" }],
    ["nothing to change", {}],
    ["something other than settings", ["days"]],
  ])("refuse %s, and keep what they were", async (_case, changes) => {
    const { core, maya } = await home();

    const refused = await change(core, maya.token, changes);

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "invalid_request" });
    expect((await settingsOf(core, maya.token)).json()).toEqual({
      temperatureUnit: "celsius",
      days: 7,
    });
    expect(activity(core)).toEqual([]);
  });

  it("are none for an app without settings, and not found for no app", async () => {
    const { core, maya } = await home();

    expect((await settingsOf(core, maya.token, "test.plain")).json()).toEqual(
      {},
    );
    expect(
      (
        await post(
          core,
          "/api/apps/test.plain/settings/update",
          { days: 3 },
          maya,
        )
      ).statusCode,
    ).toBe(400);
    expect((await settingsOf(core, maya.token, "test.none")).statusCode).toBe(
      404,
    );
  });

  it("reach every live client when an admin changes them", async () => {
    const { core, maya } = await home();
    const kitchen = sharedClient(core);
    const mine = await openLive(core, maya.token);
    const shared = await openLive(core, kitchen.token);

    await change(core, maya.token, { days: 3 });

    const message = {
      type: "settings",
      app: "test.sky",
      settings: { temperatureUnit: "celsius", days: 3 },
    };
    for (const live of [mine, shared]) {
      await expect
        .poll(() => live.messages.filter((each) => each.type === "settings"))
        .toEqual([message]);
    }
  });

  it("are kept across a restart, and a choice a new version no longer offers falls back to its default", async () => {
    const withKelvin = { ...units, kelvin: "Kelvin" };
    const { core, maya } = await home(sky(withKelvin));
    await change(core, maya.token, { temperatureUnit: "kelvin", days: 10 });

    const next = await testCore({
      dataDir: core.dataDir,
      apps: [{ origin: "official", app: defineApp(sky()) }],
    });

    expect(next.apps.settings("test.sky")).toEqual({
      temperatureUnit: "celsius",
      days: 10,
    });
    // What no longer fits does not hold up a change to the rest.
    expect((await change(next, maya.token, { days: 12 })).json()).toEqual({
      temperatureUnit: "celsius",
      days: 12,
    });
  });
});
