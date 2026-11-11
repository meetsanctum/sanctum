import { describe, expect, it } from "vitest";

import { whenWords } from "../../src/ui/schedule-words.js";

describe("snapshot dates", () => {
  it.each([
    ["2026-03-29T12:00:00Z", "2026-03-29T22:30:00Z", "14:00"],
    ["2026-10-24T12:00:00Z", "2026-10-25T22:30:00Z", "14:00"],
  ])("recognises yesterday across a clock change (%s)", (at, now, time) => {
    expect(whenWords(new Date(at), new Date(now), "Europe/Zurich")).toBe(
      `at ${time} yesterday`,
    );
  });
});
