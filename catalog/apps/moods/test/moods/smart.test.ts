import { describe, expect, it } from "vitest";

import { moodIcons } from "../../src/moods/icons.js";
import { activeMood, moodCommands } from "../../src/moods/light-states.js";
import {
  lightsOf,
  smartCatalog,
  smartDefinitions,
  smartLights,
  type SmartDefinition,
} from "../../src/moods/smart.js";
import type { Mood } from "../../src/moods/store.js";
import { light } from "./home.js";

// Smart moods, ported from v1's tests (room-schedules.test.ts and
// moods-db.test.ts in the core, mood-actions.test.ts in web-nuxt,
// Pragmata v1-final).

const colour = { color: true };

const testSmart: SmartDefinition = {
  id: "test-smart",
  name: "Test smart",
  icon: "sparkles",
  brightness: 30,
  colours: [
    { hue: 10, saturation: 80 },
    { hue: 120, saturation: 70 },
  ],
};

describe("smart moods", () => {
  it("builds deterministic smart mood commands for on and off lights", () => {
    const alpha = light(
      "alpha-light",
      { on: true, brightness: 50 },
      { features: colour },
    );
    alpha.device.name = "Alpha Light";
    const beta = light(
      "beta-light",
      { on: true, brightness: 50 },
      { features: colour },
    );
    beta.device.name = "Beta Light";
    const mono = light("mono-light", { on: false, brightness: 50 });
    mono.device.name = "Mono Light";
    const room = [mono, beta, alpha];

    const lights = smartLights(
      testSmart,
      {
        brightness: 30,
        off: [{ device: "beta-light", capability: "light" }],
      },
      room,
    );
    expect(lights).toEqual([
      {
        device: "alpha-light",
        capability: "light",
        state: { on: true, brightness: 30, hue: 10, saturation: 80 },
      },
      { device: "beta-light", capability: "light", state: { on: false } },
      // No colour where the light has none, and the next colour in turn.
      {
        device: "mono-light",
        capability: "light",
        state: { on: true, brightness: 30 },
      },
    ]);
    expect(
      moodCommands(lights, room).map(({ light, command }) => [
        light.device.id,
        command,
      ]),
    ).toEqual([
      ["alpha-light", { on: true, brightness: 30, hue: 10, saturation: 80 }],
      ["beta-light", { on: false }],
      ["mono-light", { on: true, brightness: 30 }],
    ]);
  });

  it("hands the colours out in turn, and only turns on a light that cannot dim", () => {
    const names = ["a", "b", "c"].map((id) =>
      light(id, { on: false }, { features: colour }),
    );
    const plain = light(
      "d",
      { on: false },
      { features: { brightness: false } },
    );
    expect(
      smartLights(testSmart, { brightness: 55, off: [] }, [
        ...names,
        plain,
      ]).map((each) => each.state),
    ).toEqual([
      { on: true, brightness: 55, hue: 10, saturation: 80 },
      { on: true, brightness: 55, hue: 120, saturation: 70 },
      { on: true, brightness: 55, hue: 10, saturation: 80 },
      { on: true },
    ]);
  });

  it("resolves active smart moods from catalog expectations", () => {
    const officeLight = light(
      "office-light",
      {
        on: true,
        brightness: 70,
        colorMode: "color",
        hue: 190,
        saturation: 82,
      },
      { features: colour },
    );
    const aurora: Mood = {
      id: "smart-aurora",
      roomId: "office",
      name: "Aurora",
      icon: "sparkles",
      lights: [],
      smart: { definition: "aurora", brightness: 70, off: [] },
    };
    const moods = (room: (typeof officeLight)[]) =>
      [aurora].map((mood) => ({ id: mood.id, lights: lightsOf(mood, room) }));

    expect(activeMood(moods([officeLight]), [officeLight])).toBe(
      "smart-aurora",
    );
    // Another light in the room, on, takes the next colour: no longer shown.
    const extra = light(
      "extra",
      { on: true, brightness: 70, colorMode: "color", hue: 20, saturation: 50 },
      { features: colour },
    );
    expect(activeMood(moods([officeLight, extra]), [officeLight, extra])).toBe(
      null,
    );
    // A definition the catalog no longer has sets nothing and shows nowhere.
    expect(
      lightsOf({ ...aurora, smart: { ...aurora.smart!, definition: "gone" } }, [
        officeLight,
      ]),
    ).toEqual([]);
  });

  it("has a valid catalog, as v1's schema checked it", () => {
    const ids = smartDefinitions.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = smartCatalog.map((group) => group.id);
    expect(new Set(groups).size).toBe(groups.length);
    for (const definition of smartDefinitions) {
      expect(moodIcons).toContain(definition.icon);
      expect(definition.brightness).toBeGreaterThanOrEqual(1);
      expect(definition.brightness).toBeLessThanOrEqual(100);
      expect(definition.colours.length).toBeGreaterThanOrEqual(1);
      expect(definition.colours.length).toBeLessThanOrEqual(5);
    }
    // v1's catalog: Colour, Calm and Energy.
    expect(ids).toEqual([
      "aurora",
      "crimson-pulse",
      "chromaluminescentdreamscape",
      "quiet-harbor",
      "circuit-bloom",
      "late-night-library-warm-corners",
      "morningsunshinethatneverquiteends",
    ]);
  });
});
