import {
  defineEntityType,
  entityOf,
  moodSchema,
  moodType,
  type AppContext,
  type AppDefinition,
} from "@meetsanctum/app-sdk";
import moods from "@meetsanctum/moods";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useCleanUps } from "./app-apart-support.js";
import { committedOf, running, versions } from "./app-update-support.js";
import { claimed, post, type TestCore } from "./support.js";

// Moods running apart, through an update of its own. The core keeps only what
// the new version's start says Moods owns, so its start says it all again from
// its own database, its rooms' schedules included.

useCleanUps();

const migrationsFolder = fileURLToPath(
  new URL("../../../catalog/apps/moods/migrations", import.meta.url),
);

const previousMood = defineEntityType({
  id: "moods.mood",
  title: "Mood",
  state: moodSchema,
  assistant: moodType.assistant,
});

// The previous Moods contract publishes the same saved mood under its own type.
function previousContext(ctx: AppContext): AppContext {
  return {
    ...ctx,
    entities: {
      ...ctx.entities,
      publish: (entity) =>
        ctx.entities.publish(
          entity.type === moodType.id
            ? { ...entity, type: previousMood.id }
            : entity,
        ),
    },
  };
}

const previousActions = moods.actions.map((action) => ({
  ...action,
  ...(action.runs === moodType.id
    ? {
        runs: undefined,
        input: z.object({ id: entityOf(previousMood.id) }),
        assistant: {
          ...action.assistant!,
          needs: action.assistant!.needs!.map((need) =>
            need === moodType.id ? previousMood.id : need,
          ),
        },
      }
    : {}),
  run: (ctx: AppContext, input: unknown) =>
    action.run(previousContext(ctx), input),
}));
const previousRunner = previousActions.find(
  ({ id }) => id === "moods.runMood",
)!;
const previousMoods: AppDefinition = {
  ...moods,
  version: "0.13.1",
  actions: previousActions,
  provides: {
    ...moods.provides,
    entities: moods.provides!.entities!.map((type) =>
      type.id === moodType.id ? previousMood : type,
    ),
    roomSections: moods.provides!.roomSections!.map((section) => ({
      ...section,
      entityType: previousMood.id,
      press: previousRunner,
    })),
    steps: [previousRunner],
  },
  start: (ctx, starting) => moods.start!(previousContext(ctx), starting),
  resume: (ctx, starting) => moods.resume!(previousContext(ctx), starting),
};

// What the home holds of Moods': its entities, and its jobs with their next runs.
const holds = (core: TestCore) => ({
  entities: core.entities
    .list({ app: moods.id })
    .map(({ type, key }) => ({ type, key })),
  jobs: core.workflows.jobs
    .list(moods.id)
    .map(({ key, nextAt }) => ({ key, nextAt }))
    .sort((a, b) => a.key.localeCompare(b.key)),
});

describe("Moods through an update of its own", () => {
  it("keeps its moods and its rooms' scheduled moods, each job's next run as it was", async () => {
    const home = await versions({ migrationsFolder });
    const before = await home.coreWith(previousMoods);
    await running(before, moods.id);
    const maya = await claimed(before);
    const office = (
      await post(before, "/api/places/rooms/add", { name: "Office" }, maya)
    ).json().id;
    const call = (action: string, input: object) =>
      post(before, `/api/apps/${moods.id}/actions/${action}`, input, maya);
    // A mood names its lights; Moods doesn't ask whether the home has them yet.
    const focus = (
      await call("moods.createMood", {
        roomId: office,
        name: "Focus",
        lights: [{ device: "desk", capability: "light", state: { on: true } }],
      })
    ).json();
    const scheduled = await call("moods.scheduleMood", {
      roomId: office,
      moodId: focus.id,
      start: 540,
      end: 1020,
    });
    expect(scheduled.statusCode).toBe(200);
    const held = holds(before);
    expect(held).toEqual({
      entities: [{ type: previousMood.id, key: focus.id }],
      jobs: [
        { key: `schedule:${office}:1020`, nextAt: expect.any(String) },
        { key: `schedule:${office}:540`, nextAt: expect.any(String) },
      ],
    });

    const after = await home.coreWith(moods);
    await vi.waitFor(() =>
      expect(committedOf(after)?.version).toBe(moods.version),
    );

    expect(holds(after)).toEqual({
      ...held,
      entities: [{ type: moodType.id, key: focus.id }],
    });
  });
});
