import { describe, expect, it } from "vitest";

import {
  capabilityKinds,
  declaredTypes,
  type DeclaredType,
  deviceTypeOf,
  deviceTypes,
  deviceWords,
  fitsType,
  ownTypeOf,
  sensorMeasures,
  showAsChoices,
  shownAsOf,
  shownType,
} from "../src/index.js";

// What a device is: the list every driver says its devices' types from.

describe("the device types", () => {
  it("have an id and a title each, neither twice, and a noun where a room's name can lead", () => {
    const ids = deviceTypes.map((type) => type.id);
    const titles = deviceTypes.map((type) => type.title);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(titles).size).toBe(titles.length);
    for (const type of deviceTypes) {
      // Sentence case, an acronym such as TV keeping its capitals.
      expect(type.title).toMatch(/^([A-Z][a-z]+|[A-Z]{2,})( [a-z]+)*$/);
      // A noun is how a name ends, its title or the end of it: "Office
      // motion sensor", and a smart speaker's "Office Speaker".
      if (type.noun !== null) {
        expect(
          type.title.toLowerCase().endsWith(type.noun.toLowerCase()),
          type.id,
        ).toBe(true);
        expect(type.noun, type.id).toMatch(/^([a-z]+|[A-Z]{2,})( [a-z]+)*$/);
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

  it("is never a plug or a type the household chooses, for any kinds", () => {
    // Every set of the kinds there are.
    const sets = capabilityKinds.reduce<(typeof capabilityKinds)[number][][]>(
      (all, kind) => [...all, ...all.map((set) => [...set, kind])],
      [[]],
    );
    expect(sets).toHaveLength(2 ** capabilityKinds.length);
    for (const kinds of sets) {
      const type = deviceTypeOf(kinds);
      expect(["plug", "door", "window"], kinds.join()).not.toContain(type);
      // And it is a type the device fits.
      expect(fitsType(type, new Set(kinds)), kinds.join()).toBe(true);
    }
  });
});

describe("what a driver may say a device is", () => {
  it("is any type but those only the household chooses, from the build on", () => {
    // @ts-expect-error A door is the household's to choose.
    const door: DeclaredType = "door";
    // @ts-expect-error So is a window.
    const window: DeclaredType = "window";
    const plug: DeclaredType = "plug";
    expect([door, window, plug]).toHaveLength(3);
    expect(declaredTypes).toEqual(
      deviceTypes.filter((type) => !type.chosenOnly).map((type) => type.id),
    );
    expect(declaredTypes).not.toContain("door");
    expect(declaredTypes).not.toContain("window");
    expect(declaredTypes).toContain("plug");
  });

  it("fits a device that has every kind the type needs, whatever else it has", () => {
    expect(fitsType("plug", new Set(["switch"]))).toBe(true);
    expect(fitsType("switch", new Set(["light", "switch"]))).toBe(true);
    expect(fitsType("sensor", new Set(["light", "sensor"]))).toBe(true);
    expect(fitsType("light", new Set(["contact"]))).toBe(false);
    expect(fitsType("plug", new Set(["sensor"]))).toBe(false);
  });

  it("is unknown only for a device with no capability Sanctum uses", () => {
    expect(fitsType("unknown", new Set())).toBe(true);
    expect(fitsType("unknown", new Set(["light"]))).toBe(false);
  });
});

describe("what a device is called", () => {
  it("is its type's words, whatever it measures, for any type but a sensor", () => {
    expect(deviceWords("motion", ["illuminance", "temperature"])).toEqual({
      title: "Motion sensor",
      noun: "motion sensor",
    });
    expect(deviceWords("light", ["temperature"])).toEqual({
      title: "Light",
      noun: "light",
    });
  });

  it("is a sensor's one measure, by its own words", () => {
    expect(deviceWords("sensor", ["temperature"])).toEqual({
      title: "Temperature sensor",
      noun: "temperature sensor",
    });
    expect(deviceWords("sensor", ["humidity"]).title).toBe("Humidity sensor");
    expect(deviceWords("sensor", ["illuminance"]).title).toBe("Light sensor");
    // Two readings of the same measure are still one measure.
    expect(deviceWords("sensor", ["temperature", "temperature"]).title).toBe(
      "Temperature sensor",
    );
  });

  it("is an environment sensor for a sensor that measures several things", () => {
    for (const measures of [
      ["temperature", "humidity"],
      ["temperature", "humidity", "illuminance"],
    ] as const) {
      expect(deviceWords("sensor", measures), measures.join()).toEqual({
        title: "Environment sensor",
        noun: "environment sensor",
      });
    }
  });

  it("is a sensor for one that says no measure", () => {
    expect(deviceWords("sensor", [])).toEqual({
      title: "Sensor",
      noun: "sensor",
    });
  });

  it("has words for every measure, a title and its noun", () => {
    for (const measure of sensorMeasures) {
      const { title, noun } = deviceWords("sensor", [measure]);
      expect(noun).toBe(title.toLowerCase());
    }
  });

  it.each([
    { measures: ["temperature"], title: "Temperature sensor" },
    { measures: ["temperature", "humidity"], title: "Environment sensor" },
  ] as const)("returns independent words for $title", ({ measures, title }) => {
    const words = deviceWords("sensor", measures);
    words.title = "Other sensor";
    expect(deviceWords("sensor", measures).title).toBe(title);
  });
});

describe("what a device may be shown as", () => {
  it("is a door or a window for a contact sensor, a TV or a speaker for a media player, and nothing else for the rest", () => {
    expect(shownAsOf("contact")).toEqual(["door", "window"]);
    expect(shownAsOf("media-player")).toEqual(["tv", "speaker"]);
    for (const type of deviceTypes) {
      if (type.id !== "contact" && type.id !== "media-player") {
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

  it("has its own type found again from what it is shown as", () => {
    expect(ownTypeOf("contact", null)).toBe("contact");
    expect(ownTypeOf("door", "door")).toBe("contact");
    expect(ownTypeOf("window", "window")).toBe("contact");
    expect(ownTypeOf("light", null)).toBe("light");
  });

  it("offers a device's own type first, then what it lists, and nothing where it lists none", () => {
    expect(showAsChoices("contact", null)).toEqual([
      "contact",
      "door",
      "window",
    ]);
    expect(showAsChoices("window", "window")).toEqual([
      "contact",
      "door",
      "window",
    ]);
    expect(showAsChoices("light", null)).toEqual([]);
    expect(showAsChoices("unknown", null)).toEqual([]);
  });
});
