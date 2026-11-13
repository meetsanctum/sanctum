import { describe, expect, it } from "vitest";

import { capabilityKinds, deviceTypeOf, deviceTypes } from "../src/index.js";

// What a device is: the list every driver's devices are matched against.

describe("the device types", () => {
  it("have an id and a title each, neither twice, and a noun where a room's name can lead", () => {
    const ids = deviceTypes.map((type) => type.id);
    const titles = deviceTypes.map((type) => type.title);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(titles).size).toBe(titles.length);
    for (const type of deviceTypes) {
      expect(type.title).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
      // A noun is its title as a name ends with it: "Office motion sensor".
      if (type.noun !== null) {
        expect(type.noun).toBe(type.title.toLowerCase());
      }
    }
    // Only what Sanctum cannot use has none.
    expect(
      deviceTypes.filter((type) => type.noun === null).map((type) => type.id),
    ).toEqual(["unknown"]);
  });

  it("end with the one that needs nothing, so every device is one of them", () => {
    const needsNothing = deviceTypes.filter((type) => type.needs.length === 0);
    expect(needsNothing).toEqual([deviceTypes.at(-1)]);
    expect(deviceTypeOf([])).toBe("unknown");
  });

  it("have a type for a device of each capability kind alone", () => {
    for (const kind of capabilityKinds) {
      expect(deviceTypeOf([kind]), kind).not.toBe("unknown");
    }
  });

  it("follow a type the kinds do not tell with one they do", () => {
    for (const [at, type] of deviceTypes.entries()) {
      if (!type.declaredOnly) continue;
      const next = deviceTypes.slice(at + 1).find((each) => !each.declaredOnly);
      expect(next?.needs, type.id).toEqual(type.needs);
    }
  });
});

describe("what a device with some kinds is", () => {
  it("is the first type whose kinds it has", () => {
    expect(deviceTypeOf(["sensor", "light"])).toBe("light");
    expect(deviceTypeOf(["sensor", "switch"])).toBe("switch");
    expect(deviceTypeOf(["sensor", "button"])).toBe("button");
    expect(deviceTypeOf(["sensor", "occupancy"])).toBe("motion");
    expect(deviceTypeOf(["sensor", "sensor"])).toBe("sensor");
  });

  it("is a plug only where something says so", () => {
    expect(deviceTypeOf(["switch"])).toBe("switch");
    expect(deviceTypeOf(["switch"], (type) => type === "plug")).toBe("plug");
    // Saying so of a device without its kinds changes nothing.
    expect(deviceTypeOf(["sensor"], () => true)).toBe("sensor");
    expect(deviceTypeOf(["light", "switch"], () => true)).toBe("light");
  });
});
