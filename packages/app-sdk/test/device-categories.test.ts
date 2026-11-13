import { describe, expect, it } from "vitest";

import {
  capabilityKinds,
  deviceCategories,
  deviceCategoryOf,
} from "../src/index.js";

// Where a device's parts show: the list the shell's sidebar, room pages and
// status read.

describe("the device categories", () => {
  it("have an id and a title each, neither twice", () => {
    const ids = deviceCategories.map((category) => category.id);
    const titles = deviceCategories.map((category) => category.title);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) {
      expect(title).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    }
  });

  it("hold every capability kind, each in one category", () => {
    for (const kind of capabilityKinds) {
      const holding = deviceCategories.filter((category) =>
        category.holds.some((each) => each.kind === kind),
      );
      expect(holding, kind).toHaveLength(1);
      expect(deviceCategoryOf(kind)).toBe(holding[0]);
    }
  });

  it("have none for a kind they do not know", () => {
    expect(deviceCategoryOf("curtain")).toBeUndefined();
  });
});
