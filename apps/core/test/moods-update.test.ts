import moods from "@meetsanctum/moods";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

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

// What the home holds of Moods': its entities, and its jobs with their next runs.
const holds = (core: TestCore) => ({
  entities: core.entities
    .list({ app: moods.id })
    .map(({ key }) => key)
    .sort(),
  jobs: core.workflows.jobs
    .list(moods.id)
    .map(({ key, nextAt }) => ({ key, nextAt }))
    .sort((a, b) => a.key.localeCompare(b.key)),
});

describe("Moods through an update of its own", () => {
  it("keeps its moods and its rooms' scheduled moods, each job's next run as it was", async () => {
    const home = await versions({ migrationsFolder });
    const before = await home.coreWith(moods);
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
      entities: [focus.id],
      jobs: [
        { key: `schedule:${office}:1020`, nextAt: expect.any(String) },
        { key: `schedule:${office}:540`, nextAt: expect.any(String) },
      ],
    });

    const after = await home.coreWith({ ...moods, version: "0.9.1" });
    await vi.waitFor(() => expect(committedOf(after)?.version).toBe("0.9.1"));

    expect(holds(after)).toEqual(held);
  });
});
