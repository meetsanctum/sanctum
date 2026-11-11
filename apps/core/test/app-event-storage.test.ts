import { defineApp } from "@meetsanctum/app-sdk";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import notesApp from "./fixtures/apps/notes/index.js";
import { notes } from "./fixtures/apps/notes/schema.js";
import { claimed, post, testCore } from "./support.js";

// A handler of the core's events closes over the start context, yet its calls
// are its own, as an action's are: what it leaves open is rolled back, and
// nothing it does afterwards gets through.

describe("event handler storage", () => {
  it.each(["timeout", "failure"])(
    "ends a handler's transaction after %s and refuses its late calls",
    async (outcome) => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => (release = resolve));
      const heard: string[] = [];
      const late: string[] = [];
      const app = defineApp({
        ...notesApp,
        permissions: [{ id: "places.read", reason: "For the test." }],
        async start(ctx) {
          await ctx.events.on("place.added", async ({ place }) => {
            if (place.kind !== "room") return;
            if (place.name === "Office") {
              await ctx.storage.db.run(sql`BEGIN`);
              await ctx.storage.db.insert(notes).values({ text: "unfinished" });
              // Even work detached by a failed handler loses its authority.
              void waiting.then(async () => {
                try {
                  await ctx.storage.db.insert(notes).values({ text: "late" });
                } catch {
                  late.push("storage refused");
                }
                try {
                  await ctx.places.list();
                } catch {
                  late.push("core refused");
                }
              });
              if (outcome === "failure") throw new Error("failed");
              await waiting;
              return;
            }
            await ctx.storage.db.insert(notes).values({ text: place.name });
            heard.push(place.name);
          });
        },
      });
      const core = await testCore({
        appTimeoutMs: 50,
        apps: [
          {
            app,
            origin: "official",
            migrationsFolder: fileURLToPath(
              new URL("./fixtures/apps/notes/migrations", import.meta.url),
            ),
          },
        ],
      });
      const maya = await claimed(core);
      try {
        await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
        await post(core, "/api/places/rooms/add", { name: "Hall" }, maya);
        await expect.poll(() => heard).toEqual(["Hall"]);
        const result = await post(
          core,
          "/api/apps/test.notes/actions/notes.list",
          {},
          maya,
        );
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual([
          { id: expect.any(Number), text: "Hall", personal: false },
        ]);
        release();
        await expect
          .poll(() => late)
          .toEqual(["storage refused", "core refused"]);
      } finally {
        release();
      }
    },
  );
});
