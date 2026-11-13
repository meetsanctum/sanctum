import { describe, expect, it } from "vitest";

import { createLimit } from "../src/waitlist/limit";

// A limit on how often one key gets through.

describe("a limit", () => {
  it("lets a key through so many times in its window, each key for itself", () => {
    const allows = createLimit(2, 1000);
    expect(allows("one", 0)).toBe(true);
    expect(allows("one", 10)).toBe(true);
    expect(allows("one", 20)).toBe(false);
    expect(allows("another", 20)).toBe(true);
  });

  it("lets it through again as its tries grow old, and counts no refusal", () => {
    const allows = createLimit(2, 1000);
    allows("one", 0);
    allows("one", 500);
    expect(allows("one", 900)).toBe(false);
    expect(allows("one", 1001)).toBe(true);
    expect(allows("one", 1400)).toBe(false);
    expect(allows("one", 1501)).toBe(true);
  });

  it("refuses new keys when it is full, and gives no key its tries back", () => {
    const allows = createLimit(1, 1000);
    expect(allows("one", 0)).toBe(true);
    for (let key = 1; key < 10_000; key++) allows(`key-${key}`, 0);
    expect(allows("one more", 1)).toBe(false);
    expect(allows("one", 1)).toBe(false);
  });

  it("forgets the keys gone quiet to make room", () => {
    const allows = createLimit(1, 1000);
    for (let key = 0; key < 10_000; key++) allows(`key-${key}`, 0);
    expect(allows("one more", 1001)).toBe(true);
  });
});
