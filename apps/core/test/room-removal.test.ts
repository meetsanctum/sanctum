import {
  defineAction,
  defineApp,
  defineEntityType,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { lampsCore, personWithClient } from "./devices-support.js";
import { get, post, sharedClient } from "./support.js";
import {
  addWorkflow,
  samplePackage,
  lightsOff,
  noteStep,
  steps,
  trigger,
} from "./workflows-support.js";

// What removing a room takes with it: anyone reads it before they remove the
// room, and reading it changes nothing.

// An app that keeps moods in rooms and publishes them as entities in their
// room, as Moods does for its room section.
const moodType = defineEntityType({
  id: "moods.mood",
  title: "Mood",
  state: z.object({ placeId: z.string().nullable(), name: z.string() }),
});
const publish = defineAction({
  id: "moods.publish",
  title: "Publish",
  tier: "write",
  input: z.object({ key: z.string(), state: moodType.state }),
  output: z.object({}),
  async run(ctx, input) {
    await ctx.entities.publish({
      type: moodType.id,
      key: input.key,
      name: input.state.name,
      state: input.state,
    });
    return {};
  },
});
const moodsApp = defineApp({
  id: "test.moods",
  name: "Moods",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  actions: [publish],
  events: [],
  provides: { entities: [moodType] },
});

async function home() {
  const context = await lampsCore({
    apps: [samplePackage, { app: moodsApp, origin: "official" }],
  });
  const { core, maya } = context;
  const room = async (name: string) =>
    (await post(core, "/api/places/rooms/add", { name }, maya)).json()
      .id as string;
  const removal = (id: string, token = maya.token) =>
    get(core, `/api/places/rooms/removal?id=${id}`, { token });
  return { ...context, room, removal };
}

describe("removing a room", () => {
  it("says first what goes with it, changing nothing", async () => {
    const { core, maya, lamp, plug, room, removal } = await home();
    const kitchen = await room("Kitchen");
    const office = await room("Office");
    for (const [id, roomId] of [
      [lamp, kitchen],
      [plug, office],
    ]) {
      await post(core, "/api/devices/update", { id, roomId }, maya);
    }
    for (const [key, placeId] of [
      ["cook", kitchen],
      ["dine", kitchen],
      ["focus", office],
      ["anywhere", null],
    ]) {
      const published = await post(
        core,
        "/api/apps/test.moods/actions/moods.publish",
        { key, state: { placeId, name: key } },
        maya,
      );
      expect(published.statusCode).toBe(200);
    }
    const kitchenOff = await addWorkflow(core, maya.token, {
      name: "Kitchen lights off",
      graph: steps(
        trigger("t", "manual"),
        lightsOff("off", { kind: "room", id: kitchen }),
      ),
    });
    // Sample's trigger does not declare its room with names("room"), so
    // its config only happens to hold the id.
    await addWorkflow(core, maya.token, {
      name: "Kitchen tidied",
      graph: steps(
        trigger("t", "sample.done", { room: kitchen }, "test.sample"),
        noteStep("note"),
      ),
    });
    const before = (await get(core, "/api/places", maya)).json();

    const answer = await removal(kitchen);

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      devices: [{ id: lamp, name: expect.any(String) }],
      entities: [
        { app: "test.moods", type: "moods.mood", title: "Mood", count: 2 },
      ],
      workflows: [{ id: kitchenOff.id, name: "Kitchen lights off" }],
    });
    expect((await get(core, "/api/places", maya)).json()).toEqual(before);
  });

  it("says nothing goes with an empty room", async () => {
    const { room, removal } = await home();

    expect((await removal(await room("Attic"))).json()).toEqual({
      devices: [],
      entities: [],
      workflows: [],
    });
  });

  it("is read by every client, shared ones too", async () => {
    const { core, room, removal } = await home();
    const kitchen = await room("Kitchen");
    const ben = personWithClient(core);

    const byBen = await removal(kitchen, ben.token);
    const byShared = await removal(kitchen, sharedClient(core).token);
    const anonymous = await get(
      core,
      `/api/places/rooms/removal?id=${kitchen}`,
    );

    expect(byBen.statusCode).toBe(200);
    expect(byShared.json()).toEqual(byBen.json());
    expect(anonymous.statusCode).toBe(401);
  });

  it("refuses a room that does not exist, and no room at all", async () => {
    const { core, maya, removal } = await home();

    expect((await removal("nowhere")).statusCode).toBe(404);
    expect(
      (await get(core, "/api/places/rooms/removal", maya)).statusCode,
    ).toBe(400);
  });
});
