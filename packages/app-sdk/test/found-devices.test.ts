import { describe, expect, it } from "vitest";

import {
  defineApp,
  foundDevices,
  maxFound,
  toStaticManifest,
} from "../src/index.js";

// What a driver says it could add: each device once, at most a few dozen,
// with what adding it asks by its questions' ids, and the hook that adds one.

describe("found devices", () => {
  it("are listed with what each is and asks, or nothing of either", () => {
    expect(
      foundDevices.parse([
        { key: "kitchen", name: "Kitchen sensor", type: "sensor" },
        {
          key: "plug",
          name: "Living room plug",
          description: "needs its encryption key",
          asks: ["key"],
        },
      ]),
    ).toEqual([
      {
        key: "kitchen",
        name: "Kitchen sensor",
        description: null,
        type: "sensor",
        asks: [],
      },
      {
        key: "plug",
        name: "Living room plug",
        description: "needs its encryption key",
        type: null,
        asks: ["key"],
      },
    ]);
  });

  it.each([
    [
      "twice",
      [
        { key: "a", name: "A" },
        { key: "a", name: "B" },
      ],
    ],
    ["without a name", [{ key: "a", name: " " }]],
    [
      "asking by an id it can't declare",
      [{ key: "a", name: "A", asks: ["Key"] }],
    ],
    [
      "more than the most",
      Array.from({ length: maxFound + 1 }, (_, n) => ({
        key: `${n}`,
        name: "A",
      })),
    ],
  ])("are refused when listed %s", (_what, list) => {
    expect(foundDevices.safeParse(list).success).toBe(false);
  });

  it("are added by a driver's add hook, which its manifest names", () => {
    const app = defineApp({
      id: "sanctum.example",
      name: "Example",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [{ id: "devices.register", reason: "For the test." }],
      actions: [],
      events: [],
      driver: { command: async () => undefined, add: async () => undefined },
    });

    expect(toStaticManifest(app).driver?.hooks).toEqual(["command", "add"]);
    expect(() =>
      defineApp({
        ...app,
        driver: { ...app.driver!, add: "later" as never },
      }),
    ).toThrow("A driver's add must be a function");
  });
});
