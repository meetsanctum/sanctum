import { createNaturalLightApp } from "@meetsanctum/natural-light";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AppPackage } from "../src/app-host/host.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";

// Natural light on the core's own lights, end to end: it reads who last set a
// light, its check runs as its job, and a light that is off holds the curve's
// look in Devices until anyone switches it on. The panel test app stands in for
// Moods.

const minutes = (count: number) => count * 60_000;

async function naturalLightCore() {
  // The app reads the core's test clock once the core has one.
  let clock = () => new Date();
  const naturalLight: AppPackage = {
    app: createNaturalLightApp({ now: () => clock() }),
    origin: "official",
    migrationsFolder: fileURLToPath(
      new URL(
        "../../../catalog/apps/natural-light/migrations",
        import.meta.url,
      ),
    ),
  };
  const context = await lampsCore({ apps: [naturalLight] });
  const { core, maya } = context;
  clock = core.now;
  await post(
    core,
    "/api/places/home/update",
    {
      timeZone: "Europe/Zurich",
      coordinates: { latitude: 47.3769, longitude: 8.5417 },
    },
    maya,
  );
  return context;
}

function call(core: TestCore, token: string, action: string, input: object) {
  return post(
    core,
    `/api/apps/sanctum.natural-light/actions/${action}`,
    input,
    {
      token,
    },
  );
}

function viaPanel(core: TestCore, token: string, input: object) {
  return post(core, "/api/apps/test.panel/actions/panel.command", input, {
    token,
  });
}

async function lampOf(core: TestCore, token: string, lamp: string) {
  const devices = (await get(core, "/api/devices", { token })).json();
  return devices.find((device: { id: string }) => device.id === lamp)
    .capabilities[0];
}

async function targetOf(core: TestCore, token: string) {
  const entities = (
    await get(core, "/api/entities?app=sanctum.natural-light", { token })
  ).json();
  return entities[0]?.state;
}

// Runs what is due, as the core's 10-second tick does.
async function tick(core: TestCore) {
  core.workflows.tick();
  await core.workflows.settled();
  await settled();
}

describe("natural light on the core's lights", () => {
  it("holds the curve for a light that is off, and it comes back on at it", async () => {
    const { core, maya, lamp } = await naturalLightCore();

    const followed = await call(core, maya.token, "naturalLight.follow", {
      device: lamp,
      capability: "light",
      follow: true,
    });
    await settled();
    const { colorTemperature, brightness } = followed.json();

    expect(followed.statusCode).toBe(200);
    expect(followed.json()).toMatchObject({ status: "following" });
    expect(radio.received.map(({ command }) => command.command)).toEqual([
      { on: false },
    ]);
    expect(await lampOf(core, maya.token, lamp)).toMatchObject({
      sync: "held",
      state: { on: false, brightness, colorTemperature },
      setBy: {
        app: "sanctum.natural-light",
        actor: { kind: "user", id: maya.person.id },
      },
    });

    await viaPanel(core, maya.token, {
      device: lamp,
      capability: "light",
      command: { on: true },
    });
    expect(radio.received.at(-1)!.command.command).toEqual({
      on: true,
      brightness,
      colorTemperature,
    });
  });

  it("pauses a light another app set to a look, from its job, until it is switched off", async () => {
    const { core, maya, lamp } = await naturalLightCore();
    await viaPanel(core, maya.token, {
      device: lamp,
      capability: "light",
      command: { on: true },
    });
    await call(core, maya.token, "naturalLight.follow", {
      device: lamp,
      capability: "light",
      follow: true,
    });
    await settled();
    core.advance(1_000);
    await viaPanel(core, maya.token, {
      device: lamp,
      capability: "light",
      command: { brightness: 30, colorTemperature: 400 },
    });
    await settled();
    const sent = radio.received.length;

    core.advance(minutes(10));
    await tick(core);

    expect(await targetOf(core, maya.token)).toMatchObject({
      status: "paused",
    });
    expect(radio.received).toHaveLength(sent);

    await viaPanel(core, maya.token, {
      device: lamp,
      capability: "light",
      command: { on: false },
    });
    await settled();
    core.advance(minutes(5));
    await tick(core);

    expect(await targetOf(core, maya.token)).toMatchObject({
      status: "following",
    });
    expect(radio.received.at(-1)).toEqual({
      command: expect.objectContaining({ command: { on: false } }),
      actor: { kind: "app", id: "sanctum.natural-light" },
    });
  });

  it.each(["off", "awaiting confirmation"] as const)(
    "takes a new curve to its lights without its job when the light is %s",
    async (state) => {
      const { core, maya, lamp } = await naturalLightCore();
      if (state === "awaiting confirmation") {
        await viaPanel(core, maya.token, {
          device: lamp,
          capability: "light",
          command: { on: true },
        });
        await settled();
        radio.confirms = false;
      }
      await call(core, maya.token, "naturalLight.follow", {
        device: lamp,
        capability: "light",
        follow: true,
      });
      await settled();
      const before = await lampOf(core, maya.token, lamp);
      if (state === "awaiting confirmation") {
        expect(before.sync).toBe("pending");
      }
      const sent = radio.received.length;

      const changed = await post(
        core,
        "/api/apps/sanctum.natural-light/settings/update",
        { lowKelvin: 2700, lowBrightness: 50, highKelvin: 2700 },
        maya,
      );
      expect(changed.statusCode).toBe(200);

      // 2,700 K is 370 mireds, all day with the peak that warm.
      await expect
        .poll(async () => (await lampOf(core, maya.token, lamp)).state)
        .toMatchObject({ on: state !== "off", colorTemperature: 370 });
      expect(before.state.colorTemperature).not.toBe(370);
      expect(radio.received).toHaveLength(sent + 1);
      expect(await targetOf(core, maya.token)).toMatchObject({
        status: "following",
        colorTemperature: 370,
      });
    },
  );
});
