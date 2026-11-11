import { describe, expect, it } from "vitest";
import { z } from "zod";

import { settingsAsRead } from "../src/settings.js";

describe("settings as an app reads them", () => {
  const schema = z
    .object({
      low: z.number().default(1),
      high: z.number().default(9),
      name: z.string().trim().default("home"),
    })
    .refine(({ low, high }) => low <= high);

  it("runs its own schema, so defaults, transforms and refinements hold", () => {
    expect(settingsAsRead(schema as never, { name: "  den " })).toEqual({
      low: 1,
      high: 9,
      name: "den",
    });
  });

  it("drops what its schema no longer declares or takes", () => {
    expect(
      settingsAsRead(z.object({ low: z.number().default(1) }), {
        low: "two",
        gone: true,
      }),
    ).toEqual({ low: 1 });
  });

  it("falls back to its defaults when the choices refuse each other", () => {
    expect(settingsAsRead(schema as never, { low: 5, high: 2 })).toEqual({
      low: 1,
      high: 9,
      name: "home",
    });
  });
});
