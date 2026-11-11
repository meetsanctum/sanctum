import { describe, expect, it } from "vitest";

import { combine, rollUps, samplesOf } from "../src/history/statistics.js";
import { floorTime } from "../src/history/time.js";

// History's roll-ups, ported from v1's recorder and weighed by time: a value
// holds from one change to the next.

const minute = 60_000;
const at = (minutes: number) => minutes * minute;

describe("history's roll-ups", () => {
  it("weigh each value by how long it held, the one before carried in", () => {
    // 80 from before the period, 20 from its fourth minute.
    const rollups = rollUps(
      [
        { at: at(-30), value: 80 },
        { at: at(3), value: 20 },
      ],
      at(0),
      at(5),
      5 * minute,
    );

    expect([...rollups]).toEqual([
      [at(0), { mean: (80 * 3 + 20 * 2) / 5, min: 20, max: 80, seconds: 300 }],
    ]);
  });

  it("split a value across the periods it spans, until the end", () => {
    const rollups = rollUps(
      [{ at: at(2), value: 1 }],
      at(0),
      at(15),
      5 * minute,
    );

    expect([...rollups]).toEqual([
      [at(0), { mean: 1, min: 1, max: 1, seconds: 180 }],
      [at(5), { mean: 1, min: 1, max: 1, seconds: 300 }],
      [at(10), { mean: 1, min: 1, max: 1, seconds: 300 }],
    ]);
  });

  it("leave out what was not known, and periods with nothing known", () => {
    const rollups = rollUps(
      [
        { at: at(0), value: 1 },
        { at: at(1), value: null },
        { at: at(9), value: 0 },
      ],
      at(0),
      at(15),
      5 * minute,
    );

    expect([...rollups]).toEqual([
      [at(0), { mean: 1, min: 1, max: 1, seconds: 60 }],
      [at(5), { mean: 0, min: 0, max: 0, seconds: 60 }],
      [at(10), { mean: 0, min: 0, max: 0, seconds: 300 }],
    ]);
  });

  it("make an hour from its 5 minutes, weighed by how long each was known", () => {
    expect(
      combine([
        { mean: 100, min: 100, max: 100, seconds: 300 },
        { mean: 40, min: 20, max: 60, seconds: 100 },
        { mean: 5, min: 5, max: 5, seconds: 0 },
      ]),
    ).toEqual({
      mean: (100 * 300 + 40 * 100) / 400,
      min: 20,
      max: 100,
      seconds: 400,
    });
    expect(combine([])).toBeNull();
  });

  it("read a light's on and its brightness while on, and nothing while it does not answer", () => {
    const samples = samplesOf("light", [
      { at: 0, availability: "online", state: { on: false, brightness: 80 } },
      { at: 1, availability: "online", state: { on: true, brightness: 80 } },
      { at: 2, availability: "offline", state: { on: true, brightness: 80 } },
      { at: 3, availability: "unknown", state: null },
    ]);

    expect(Object.fromEntries(samples)).toEqual({
      on: [
        { at: 0, value: 0 },
        { at: 1, value: 1 },
        { at: 2, value: null },
        { at: 3, value: null },
      ],
      brightness: [
        { at: 0, value: null },
        { at: 1, value: 80 },
        { at: 2, value: null },
        { at: 3, value: null },
      ],
    });
    expect(
      Object.fromEntries(
        samplesOf("switch", [
          { at: 0, availability: "online", state: { on: true } },
        ]),
      ),
    ).toEqual({ on: [{ at: 0, value: 1 }] });
    expect(samplesOf("button", []).size).toBe(0);
  });

  it("read a sensor's value, and nothing while it does not answer", () => {
    expect(
      Object.fromEntries(
        samplesOf("sensor", [
          { at: 0, availability: "online", state: { value: 21.5 } },
          { at: 1, availability: "offline", state: { value: 21.5 } },
          { at: 2, availability: "unknown", state: null },
        ]),
      ),
    ).toEqual({
      value: [
        { at: 0, value: 21.5 },
        { at: 1, value: null },
        { at: 2, value: null },
      ],
    });
  });

  it("start periods on the 5 minutes and the hour, as v1 did", () => {
    const time = Date.parse("2026-10-30T10:47:12Z");

    expect(new Date(floorTime(time, 5 * minute)).toISOString()).toBe(
      "2026-10-30T10:45:00.000Z",
    );
    expect(new Date(floorTime(time, 60 * minute)).toISOString()).toBe(
      "2026-10-30T10:00:00.000Z",
    );
  });
});
