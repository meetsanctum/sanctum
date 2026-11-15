import { describe, expect, it } from "vitest";

import {
  capabilityKinds,
  deviceTypeOf,
  deviceTypes,
  shownAsOf,
  shownType,
} from "../src/index.js";

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
    expect(deviceTypeOf(["sensor", "motion"])).toBe("motion");
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

describe("what a device may be shown as", () => {
  it("is a door or a window for a contact sensor, and nothing else for the rest", () => {
    expect(shownAsOf("contact")).toEqual(["door", "window"]);
    for (const type of deviceTypes) {
      if (type.id !== "contact") {
        expect(shownAsOf(type.id), type.id).toEqual([]);
      }
    }
  });

  it("is a type only the household chooses, made of what the device's own type has", () => {
    for (const type of deviceTypes) {
      for (const id of type.showAs ?? []) {
        const shown = deviceTypes.find((each) => each.id === id);
        expect(shown?.chosenOnly, id).toBe(true);
        // So what it shows and does stays the device's own.
        expect(shown?.needs, id).toEqual(type.needs);
      }
    }
    // And each such type is offered by exactly one type.
    for (const type of deviceTypes.filter((each) => each.chosenOnly)) {
      expect(
        deviceTypes.filter((each) => each.showAs?.includes(type.id)),
        type.id,
      ).toHaveLength(1);
    }
  });

  it("is never what a device is by its kinds, whatever says so", () => {
    expect(deviceTypeOf(["contact"])).toBe("contact");
    expect(deviceTypeOf(["contact"], () => true)).toBe("contact");
    expect(deviceTypeOf(["contact", "sensor"])).toBe("contact");
  });

  it("is the choice while the device's own type lists it, and its own type otherwise", () => {
    expect(shownType("contact", "door")).toBe("door");
    expect(shownType("contact", "window")).toBe("window");
    expect(shownType("contact", null)).toBe("contact");
    expect(shownType("contact", undefined)).toBe("contact");
    // A choice that does not fit, and one this version does not know.
    expect(shownType("contact", "light")).toBe("contact");
    expect(shownType("contact", "gate")).toBe("contact");
    expect(shownType("unknown", "door")).toBe("unknown");
    expect(shownType("light", "door")).toBe("light");
  });
});
