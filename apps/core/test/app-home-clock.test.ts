import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { claimed, post, testCore } from "./support.js";

// ctx.clock(): the home clock for an app's server, bound to the time zone and
// hours the household set. It needs no permission: every app's page has both
// in its frame already, and a zone says far less than where the home is.

const at = Date.parse("2026-11-24T13:30:00Z");

const app = defineApp({
  id: "sanctum.example",
  name: "Example",
  version: "0.1.0",
  core: "^2.0.0",
  permissions: [],
  actions: [
    defineAction({
      id: "example.clock",
      title: "Clock",
      tier: "read",
      input: z.object({}),
      output: z.unknown(),
      run: async (ctx) => {
        const clock = await ctx.clock();
        return {
          timeZone: clock.timeZone,
          hourCycle: clock.hourCycle,
          date: clock.date(at),
          time: clock.timeText(at),
        };
      },
    }),
  ],
  events: [],
});

describe("the home clock an app's server asks for", () => {
  it("is the home's zone and hours, and follows the household's changes", async () => {
    const core = await testCore({
      apps: [{ app, origin: "third-party" }],
      timeZone: null,
    });
    const maya = await claimed(core);
    const ask = async () =>
      (
        await post(
          core,
          "/api/apps/sanctum.example/actions/example.clock",
          {},
          maya,
        )
      ).json();
    const update = (change: Record<string, unknown>) =>
      post(core, "/api/places/home/update", change, maya);

    expect((await update({ timeZone: "Europe/Zurich" })).statusCode).toBe(200);
    expect(await ask()).toEqual({
      timeZone: "Europe/Zurich",
      hourCycle: "24h",
      date: "2026-11-24",
      time: "14:30",
    });

    expect(
      (await update({ timeZone: "Asia/Tokyo", hourCycle: "12h" })).statusCode,
    ).toBe(200);
    expect(await ask()).toEqual({
      timeZone: "Asia/Tokyo",
      hourCycle: "12h",
      date: "2026-11-24",
      time: "10:30 PM",
    });
  });
});
