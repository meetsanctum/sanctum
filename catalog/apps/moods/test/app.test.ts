import { permissionIds } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import moodsApp from "../src/index.js";

// What Moods is, as the core and the shell find it.

describe("Moods", () => {
  it("has its own page, a page for a room, the mood editor and a scheduled mood's editor", () => {
    expect(moodsApp).toMatchObject({
      id: "sanctum.moods",
      icon: { glyph: "swatch-book", color: "ember" },
      pages: ["main", "room", "mood", "scheduled"],
    });
  });

  it("needs only rooms and their lights to work; the rest serve presses and motion", () => {
    expect(
      moodsApp.permissions.map(({ id, needed, startsOn }) => [
        id,
        needed ?? false,
        startsOn ?? false,
      ]),
    ).toEqual([
      ["places.read", true, false],
      ["devices.control:light", true, false],
      // What a remote's presses do, which Moods keeps as workflows: on from
      // the start, so a remote switches its room's lights at once.
      ["devices.read:button", false, true],
      // A room's motion sensors and light level, for what motion does,
      // asked for as someone turns it on.
      ["devices.read:occupancy", false, false],
      ["devices.read:sensor", false, false],
      ["workflows.manage", false, true],
    ]);
    // Its rooms' schedules are jobs of its own, which need no permission.
    expect(permissionIds(moodsApp.permissions)).not.toContain("jobs.schedule");
  });

  it("brings its moods and what turning each room on brings to the home", () => {
    expect(moodsApp.provides?.entities?.map((type) => type.id)).toEqual([
      "moods.mood",
      "lights.turnOn",
    ]);
  });

  it("runs its moods in workflows, and leaves a place's lights to the core's own pieces", () => {
    const ids = moodsApp.actions.map((action) => action.id);
    expect(ids).not.toContain("moods.switchLights");
    expect(ids).not.toContain("moods.lightsAre");
    expect(moodsApp.provides?.conditions).toBeUndefined();
    expect(moodsApp.provides?.steps?.map((step) => step.id)).toEqual([
      "moods.runMood",
    ]);
  });

  it("adds its moods to every room's page, run with a tap, edited on its page for the room", () => {
    expect(moodsApp.provides?.roomSections).toEqual([
      {
        id: "moods.room",
        title: "Moods",
        entityType: "moods.mood",
        kind: "tiles",
        order: 200,
        press: expect.objectContaining({
          id: "moods.runMood",
          tier: "write",
        }),
        open: { page: "room", label: "Edit" },
        whenEmpty: { roomHas: "light" },
        // What its settings page previews: a room's moods, one running.
        preview: [
          { icon: "sparkles", name: "Aurora", active: true },
          { icon: "book-open", name: "Reading", active: false },
          { icon: "moon", name: "Night", active: false },
        ],
      },
    ]);
  });
});
