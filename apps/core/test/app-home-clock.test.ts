import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { apart, running, useCleanUps } from "./app-apart-support.js";
import { claimed, post, testCore } from "./support.js";

useCleanUps();

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

  it("keeps one clock during startup and reads changes afterwards", async () => {
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const reads: { timeZone: string; hourCycle: string }[] = [];
    const startingApp = defineApp({
      ...app,
      permissions: [{ id: "places.read", reason: "Follow room changes." }],
      start: async (ctx) => {
        const read = async () => {
          const { timeZone, hourCycle } = await ctx.clock();
          reads.push({ timeZone, hourCycle });
        };
        await ctx.events.on("place.added", read);
        await read();
        await paused;
        await read();
      },
    });
    const { core } = await apart(startingApp, { timeZone: null });
    const maya = await claimed(core);
    const initialTimeZone = core.places.clock().timeZone;
    const timeZone =
      initialTimeZone === "Asia/Tokyo" ? "Europe/Zurich" : "Asia/Tokyo";

    try {
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      const update = await post(
        core,
        "/api/places/home/update",
        { timeZone, hourCycle: "12h" },
        maya,
      );
      expect(update.statusCode).toBe(200);
    } finally {
      resume();
    }
    await running(core, startingApp.id);
    expect(reads).toEqual([
      { timeZone: initialTimeZone, hourCycle: "24h" },
      { timeZone: initialTimeZone, hourCycle: "24h" },
    ]);

    const room = await post(
      core,
      "/api/places/rooms/add",
      { name: "Office" },
      maya,
    );
    expect(room.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(reads[2]).toEqual({ timeZone, hourCycle: "12h" }),
    );
  });
});
