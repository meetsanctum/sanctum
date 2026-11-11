import { createWeatherApp } from "@meetsanctum/weather";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { settled } from "./devices-support.js";
import { claimed, post, testCore } from "./support.js";

// Location handlers have their own call lifetime. Weather's background work
// must keep using its start context after the handler that woke it returns.
describe("Weather on the core", () => {
  it("follows a move, keeps checking afterwards and clears a removed location", async () => {
    let now = new Date("2026-10-29T09:00:00Z");
    const app = createWeatherApp({ checkMs: 50, now: () => now });
    const core = await testCore({
      apps: [
        {
          app,
          origin: "official",
          migrationsFolder: fileURLToPath(
            new URL(
              "../../../catalog/apps/weather/migrations",
              import.meta.url,
            ),
          ),
        },
      ],
      fetch: async () =>
        Response.json({
          daily: {
            time: ["2026-10-29"],
            temperature_2m_max: [14],
            temperature_2m_min: [6],
            precipitation_probability_max: [10],
          },
        }),
    });
    const maya = await claimed(core);
    await settled();
    const weather = () => core.entities.list({ app: app.id });
    const sun = () => weather().find(({ type }) => type === "sun")?.state;

    await post(
      core,
      "/api/places/home/update",
      {
        timeZone: "Europe/Zurich",
        coordinates: { latitude: 47.3769, longitude: 8.5417 },
      },
      maya,
    );

    await expect.poll(weather).toHaveLength(3);
    expect(sun()).toMatchObject({ date: "2026-10-29" });

    now = new Date("2026-10-30T09:00:00Z");
    await expect.poll(sun).toMatchObject({ date: "2026-10-30" });

    await post(core, "/api/places/home/update", { coordinates: null }, maya);
    await expect.poll(weather).toEqual([]);
    expect(
      core.logs.filter((message) => message.startsWith(`${app.id}:`)),
    ).toEqual([]);
  });
});
