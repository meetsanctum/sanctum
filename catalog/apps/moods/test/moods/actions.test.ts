import {
  ActionError,
  createAppContext,
  type ActionDefinition,
  type ActionInput,
  type ActionOutput,
  type Actor,
  type CapabilityInfo,
  type CoreCalls,
  type DeviceCommand,
  type DeviceInfo,
  type Job,
  permissionIds,
} from "@meetsanctum/app-sdk";
import { createTestStorage, type TestStorage } from "@meetsanctum/app-testkit";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import moodsApp from "../../src/index.js";
import {
  createMood,
  deleteMood,
  listMoods,
  orderMoods,
  previewMood,
  runMood,
  updateMood,
} from "../../src/moods/actions.js";
import {
  assignSmartMood,
  listSmartMoods,
  updateSmartMood,
} from "../../src/moods/smart-actions.js";
import { smartDefinition } from "../../src/moods/smart.js";
import { device, lightCapability, places } from "./home.js";

// Moods' actions against its own database, migrated as the core
// migrates it, and a core that answers what each test gives it.

const migrationsFolder = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);
const alex: Actor = { kind: "user", id: "alex" };

const homeDevices = [
  device("desk", "office", [lightCapability({ on: true, brightness: 60 })]),
  device("ceiling", "office", [lightCapability({ on: true, brightness: 90 })]),
  device("shelf", "office", [lightCapability({ on: false, brightness: 30 })]),
  device("away", "office", [lightCapability({ on: true })], "offline"),
  device("counter", "kitchen", [lightCapability({ on: true, brightness: 50 })]),
];

let storage: TestStorage | undefined;
afterEach(() => {
  storage?.close();
  storage = undefined;
});

function home(
  options: {
    devices?: DeviceInfo[];
    command?: (command: DeviceCommand) => Promise<CapabilityInfo>;
    actor?: Actor;
  } = {},
) {
  storage = createTestStorage({ migrationsFolder });
  const commands: DeviceCommand[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not in this test");
  };
  const core: CoreCalls = {
    query: storage.query,
    serviceConnection: unused,
    settings: unused,
    // Every permission Moods asks for, granted.
    permissions: async () => permissionIds(moodsApp.permissions),
    permissionsRevision: async () => 0,
    register: unused,
    report: unused,
    firmware: unused,
    device: unused,
    location: unused,
    // Each change publishes its room's moods: entities.test.ts follows them.
    publish: async () => undefined,
    unpublish: async () => undefined,
    entities: unused,
    fetch: unused,
    people: unused,
    places: async () => places,
    devices: async () => options.devices ?? homeDevices,
    async command(command) {
      commands.push(command);
      return options.command
        ? options.command(command)
        : lightCapability({ on: true });
    },
    present: unused,
    press: unused,
    release: unused,
    emit: unused,
    follow: unused,
    // Deleting a mood sets the schedule's jobs again: schedules.test.ts
    // follows them.
    scheduleJob: async (job) => ({ ...job, nextAt: null }) as Job,
    cancelJob: async () => undefined,
    jobs: async () => [],
    putWorkflow: unused,
    removeWorkflow: unused,
    workflows: async () => [],
    joining: unused,
    secret: unused,
    putSecret: unused,
    removeSecret: unused,
    log() {},
  };
  return {
    commands,
    sent: () => commands.map((each) => [each.device, each.command]),
    // As the core calls an action: its input and output checked.
    async call<Action extends ActionDefinition>(
      action: Action,
      input: ActionInput<Action>,
      actor: Actor = options.actor ?? alex,
    ): Promise<ActionOutput<Action>> {
      const ctx = createAppContext({
        appId: moodsApp.id,
        actor,
        core,
      });
      return action.output.parse(
        await action.run(ctx, action.input.parse(input)),
      ) as ActionOutput<Action>;
    },
    query: storage.query,
  };
}

const relaxLights = [
  {
    device: "desk",
    capability: "light",
    state: { on: true, brightness: 40, colorTemperature: 400 },
  },
  { device: "ceiling", capability: "light", state: { on: false } },
] as const;

const notFound = expect.objectContaining({ code: "not_found" });

describe("the mood actions", () => {
  it("creates, lists, changes and deletes a room's moods", async () => {
    const { call } = home();
    // Only Moods' own icons.
    expect(
      createMood.input.safeParse({
        roomId: "office",
        name: "Relax",
        icon: "sofa",
        lights: [...relaxLights],
      }).success,
    ).toBe(false);

    const created = await call(createMood, {
      roomId: "office",
      name: " Relax ",
      icon: "armchair",
      lights: [...relaxLights],
    });
    expect(created).toEqual({
      id: expect.any(String),
      roomId: "office",
      name: "Relax",
      icon: "armchair",
      // By device.
      lights: [relaxLights[1], relaxLights[0]],
      smart: null,
    });
    await call(createMood, {
      roomId: "kitchen",
      name: "Cooking",
      lights: [{ device: "counter", capability: "light", state: { on: true } }],
    });

    expect(await call(listMoods, { roomId: "office" })).toEqual([created]);
    expect(
      (await call(listMoods, {})).map((mood) => [mood.roomId, mood.name]),
    ).toEqual([
      ["kitchen", "Cooking"],
      ["office", "Relax"],
    ]);

    const changed = await call(updateMood, {
      id: created.id,
      name: "Evening",
      lights: [{ device: "shelf", capability: "light", state: { on: false } }],
    });
    expect(changed).toEqual({
      ...created,
      name: "Evening",
      lights: [{ device: "shelf", capability: "light", state: { on: false } }],
    });

    expect(await call(deleteMood, { id: created.id })).toEqual({
      id: created.id,
    });
    expect(await call(listMoods, { roomId: "office" })).toEqual([]);
    await expect(call(deleteMood, { id: created.id })).rejects.toThrow(
      notFound,
    );
    await expect(
      call(updateMood, { id: created.id, name: "Gone" }),
    ).rejects.toThrow(notFound);
  });

  it("refuses a room the home does not have", async () => {
    const { call } = home();
    await expect(
      call(createMood, {
        roomId: "attic",
        name: "Dust",
        lights: [...relaxLights],
      }),
    ).rejects.toThrow(notFound);
    await expect(
      call(orderMoods, { roomId: "attic", moodIds: [] }),
    ).rejects.toThrow(notFound);
    await expect(
      call(previewMood, { roomId: "attic", lights: [...relaxLights] }),
    ).rejects.toThrow(notFound);
  });

  it("refuses lights a mood cannot set", () => {
    const input = (state: unknown, more: unknown[] = []) => ({
      roomId: "office",
      name: "Odd",
      lights: [{ device: "desk", capability: "light", state }, ...more],
    });
    for (const state of [
      { on: true, hue: 20 },
      { on: true, hue: 20, saturation: 50, colorTemperature: 300 },
      { on: true, brightness: 0 },
      { on: false, brightness: 40 },
    ]) {
      expect(createMood.input.safeParse(input(state)).success).toBe(false);
    }
    expect(
      createMood.input.safeParse(
        input({ on: false }, [
          { device: "desk", capability: "light", state: { on: true } },
        ]),
      ).success,
    ).toBe(false);
    expect(
      createMood.input.safeParse({ ...input({ on: false }), lights: [] })
        .success,
    ).toBe(false);
    expect(updateMood.input.safeParse({ id: "relax" }).success).toBe(false);
  });

  it("replaces per-room mood order and cascades deleted moods", async () => {
    const { call } = home();
    const add = async (name: string, roomId = "office") =>
      (await call(createMood, { roomId, name, lights: [...relaxLights] })).id;
    const relax = await add("Relax");
    const movie = await add("Movie");
    const work = await add("Work");
    const cooking = await add("Cooking", "kitchen");
    const names = async () =>
      (await call(listMoods, { roomId: "office" })).map((mood) => mood.name);
    // New moods come after the room's others.
    expect(await names()).toEqual(["Relax", "Movie", "Work"]);

    expect(
      await call(orderMoods, { roomId: "office", moodIds: [work, relax] }),
    ).toEqual({ moodIds: [work, relax, movie] });
    expect(
      await call(orderMoods, { roomId: "office", moodIds: [movie] }),
    ).toEqual({ moodIds: [movie, work, relax] });
    expect(await names()).toEqual(["Movie", "Work", "Relax"]);

    expect(
      orderMoods.input.safeParse({
        roomId: "office",
        moodIds: [movie, movie],
      }).success,
    ).toBe(false);
    for (const moodIds of [["missing"], [cooking]]) {
      await expect(
        call(orderMoods, { roomId: "office", moodIds }),
      ).rejects.toThrow(notFound);
    }
    expect(await names()).toEqual(["Movie", "Work", "Relax"]);

    await call(deleteMood, { id: movie });
    expect(await names()).toEqual(["Work", "Relax"]);
    expect(await call(listMoods, { roomId: "kitchen" })).toMatchObject([
      { name: "Cooking" },
    ]);
  });

  it("deletes a mood's lights through mood deletion", async () => {
    const { call, query } = home();
    const { id } = await call(createMood, {
      roomId: "office",
      name: "Relax",
      lights: [...relaxLights],
    });
    const count = async () =>
      (
        await query({
          sql: "select count(*) from mood_lights",
          params: [],
          method: "get",
        })
      ).rows;
    expect(await count()).toEqual([2]);
    await call(deleteMood, { id });
    expect(await count()).toEqual([0]);
  });

  it("runs a mood in its room by the target-portion rule", async () => {
    const office = home();
    const { id } = await office.call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: [
        {
          device: "shelf",
          capability: "light",
          state: { on: true, brightness: 70 },
        },
        { device: "counter", capability: "light", state: { on: false } },
        { device: "away", capability: "light", state: { on: true } },
      ],
    });
    expect(await office.call(runMood, { id })).toEqual({
      switched: 3,
      failed: [],
    });
    // Its light in the kitchen and the one offline are left alone; the
    // office's other lights that are on turn off.
    expect(office.sent()).toEqual([
      ["shelf", { on: true, brightness: 70 }],
      ["desk", { on: false }],
      ["ceiling", { on: false }],
    ]);

    await expect(office.call(runMood, { id: "missing" })).rejects.toThrow(
      notFound,
    );
  });

  it("previews a draft and puts the lights back, through the same rule", async () => {
    const { call, sent } = home();
    await call(previewMood, { roomId: "office", lights: [...relaxLights] });
    expect(sent()).toEqual([
      ["desk", { on: true, brightness: 40, colorTemperature: 400 }],
      ["ceiling", { on: false }],
    ]);
    expect(await call(listMoods, {})).toEqual([]);
  });

  it("puts a light back off with the level and colour it comes back at", async () => {
    const { call, sent } = home();
    const putBack = [
      {
        device: "desk",
        capability: "light",
        state: { on: false, brightness: 70, colorTemperature: 400 },
      },
    ];
    await call(previewMood, { roomId: "office", lights: putBack });
    expect(sent()).toEqual([
      ["desk", { on: false, brightness: 70, colorTemperature: 400 }],
      ["ceiling", { on: false }],
    ]);
    // A mood only turns a light off.
    expect(() =>
      createMood.input.parse({
        roomId: "office",
        name: "Off",
        lights: putBack,
      }),
    ).toThrow();
    expect(() =>
      previewMood.input.parse({
        roomId: "office",
        lights: [
          {
            ...putBack[0],
            state: { on: false, hue: 30, colorTemperature: 400 },
          },
        ],
      }),
    ).toThrow();
  });

  it("names the lights it could not set, and passes a refusal on", async () => {
    const failing = home({
      async command(command) {
        if (command.device === "desk") throw new Error("unavailable");
        if (command.device === "ceiling") throw new ActionError("not_found");
        return lightCapability({ on: true });
      },
    });
    expect(
      await failing.call(previewMood, {
        roomId: "office",
        lights: [...relaxLights],
      }),
    ).toEqual({
      switched: 0,
      failed: [{ device: "desk", capability: "light" }],
    });

    const refused = home({
      command: async () => {
        throw new ActionError("needs_approval");
      },
    });
    await expect(
      refused.call(previewMood, { roomId: "office", lights: [...relaxLights] }),
    ).rejects.toThrow(expect.objectContaining({ code: "needs_approval" }));
  });

  it("lets anyone run, make, change, order and delete moods, a shared client too", () => {
    expect(listMoods).toMatchObject({ tier: "read" });
    // Moods are the household's; its page asks before deleting one.
    for (const action of [
      runMood,
      createMood,
      updateMood,
      orderMoods,
      previewMood,
      deleteMood,
    ]) {
      expect(action).toMatchObject({ tier: "write" });
    }
    expect(moodsApp.migrations).toBe("migrations");
  });
});

describe("the smart mood actions", () => {
  it("lists the catalog for anyone", async () => {
    const { call } = home({ actor: { kind: "client", id: "wall" } });
    const catalog = await call(listSmartMoods, {});
    expect(catalog.map((group) => group.name)).toEqual([
      "Colour",
      "Calm",
      "Energy",
    ]);
    expect(catalog[0]?.moods[0]).toMatchObject({
      id: "aurora",
      name: "Aurora",
      icon: "sparkles",
      brightness: 70,
    });
  });

  it("stores catalog default brightness and updates smart assignment brightness", async () => {
    const { call } = home();
    const created = await call(assignSmartMood, {
      roomId: "office",
      definitionId: "aurora",
    });
    expect(created).toEqual({
      id: expect.any(String),
      roomId: "office",
      name: "Aurora",
      icon: "sparkles",
      lights: [],
      smart: {
        definition: "aurora",
        brightness: smartDefinition("aurora")!.brightness,
        off: [],
      },
    });

    const updated = await call(updateSmartMood, {
      id: created.id,
      brightness: 41,
      off: [{ device: "desk", capability: "light" }],
    });
    expect(updated.smart).toEqual({
      definition: "aurora",
      brightness: 41,
      off: [{ device: "desk", capability: "light" }],
    });
    expect(await call(listMoods, { roomId: "office" })).toEqual([updated]);
  });

  it("assigns a definition once per room, and only one the catalog has", async () => {
    const { call } = home();
    await call(assignSmartMood, { roomId: "office", definitionId: "aurora" });
    await expect(
      call(assignSmartMood, { roomId: "office", definitionId: "aurora" }),
    ).rejects.toThrow(expect.objectContaining({ code: "conflict" }));
    await call(assignSmartMood, { roomId: "kitchen", definitionId: "aurora" });
    for (const input of [
      { roomId: "office", definitionId: "gone" },
      { roomId: "attic", definitionId: "aurora" },
    ]) {
      await expect(call(assignSmartMood, input)).rejects.toThrow(notFound);
    }
  });

  it("keeps smart and custom moods to their own changes", async () => {
    const { call } = home();
    const smart = await call(assignSmartMood, {
      roomId: "office",
      definitionId: "aurora",
    });
    const custom = await call(createMood, {
      roomId: "office",
      name: "Relax",
      lights: [...relaxLights],
    });
    const conflict = expect.objectContaining({ code: "conflict" });
    await expect(
      call(updateMood, { id: smart.id, name: "Mine" }),
    ).rejects.toThrow(conflict);
    await expect(
      call(updateSmartMood, { id: custom.id, brightness: 20 }),
    ).rejects.toThrow(conflict);
    await expect(
      call(updateSmartMood, { id: "missing", brightness: 20 }),
    ).rejects.toThrow(notFound);

    // They share the room's order, and delete alike.
    expect(
      await call(orderMoods, { roomId: "office", moodIds: [custom.id] }),
    ).toEqual({ moodIds: [custom.id, smart.id] });
    await call(deleteMood, { id: smart.id });
    expect(
      (await call(listMoods, { roomId: "office" })).map((mood) => mood.id),
    ).toEqual([custom.id]);
  });

  it("runs a smart mood on the room's lights as they are, by name", async () => {
    const { call, sent } = home();
    const { id } = await call(assignSmartMood, {
      roomId: "office",
      definitionId: "aurora",
      brightness: 40,
      off: [{ device: "shelf", capability: "light" }],
    });
    expect(await call(runMood, { id })).toEqual({ switched: 3, failed: [] });
    // The lights here only dim, so they take the brightness; the one
    // offline is left alone, and the one it leaves off turns off.
    expect(sent()).toEqual([
      ["ceiling", { on: true, brightness: 40 }],
      ["desk", { on: true, brightness: 40 }],
      ["shelf", { on: false }],
    ]);
  });

  it("lets anyone see the catalog, and add and change smart moods", () => {
    expect(listSmartMoods).toMatchObject({ tier: "read" });
    for (const action of [assignSmartMood, updateSmartMood]) {
      expect(action).toMatchObject({ tier: "write" });
    }
  });
});
