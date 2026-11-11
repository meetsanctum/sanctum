import { describe, expect, it } from "vitest";

import {
  command,
  devicesSeenBy,
  lampsCore,
  radio,
  settled,
} from "./devices-support.js";
import { post, sharedClient, type TestCore } from "./support.js";

// Who last set a light: each capability names the app that sent the last
// command the core carried out, and the actor behind it, so natural light can
// tell a mood's or a person's change from its own.

function viaPanel(core: TestCore, token: string, input: object) {
  return post(core, "/api/apps/test.panel/actions/panel.command", input, {
    token,
  });
}

async function lampSeenBy(core: TestCore, token: string, lamp: string) {
  const devices = await devicesSeenBy(core, token);
  return devices.find((device: { id: string }) => device.id === lamp)
    .capabilities[0];
}

describe("who last set a light", () => {
  it("names nobody before the first command", async () => {
    const { core, maya, lamp } = await lampsCore();

    expect((await lampSeenBy(core, maya.token, lamp)).setBy).toBeNull();
  });

  it("names the app that sent the command and the person behind it", async () => {
    const { core, maya, lamp } = await lampsCore();

    await viaPanel(core, maya.token, {
      device: lamp,
      capability: "light",
      command: { on: true, brightness: 40 },
    });

    expect((await lampSeenBy(core, maya.token, lamp)).setBy).toEqual({
      app: "test.panel",
      actor: { kind: "user", id: maya.person.id },
      asked: { on: true, brightness: 40 },
      at: core.now().toISOString(),
    });
  });

  it("names no app for a client's own command", async () => {
    const { core, maya, lamp } = await lampsCore();

    await command(core, maya.token, lamp, "light", { colorTemperature: 300 });

    expect((await lampSeenBy(core, maya.token, lamp)).setBy).toMatchObject({
      app: null,
      actor: { kind: "user", id: maya.person.id },
      asked: { colorMode: "temperature", colorTemperature: 300 },
    });
  });

  it("names the person to shared clients too, and the shared client itself", async () => {
    const { core, maya, lamp } = await lampsCore();
    const kitchen = sharedClient(core);

    await command(core, maya.token, lamp, "light", { on: true });
    expect(await lampSeenBy(core, kitchen.token, lamp)).toMatchObject({
      setBy: {
        app: null,
        actor: { kind: "user", id: maya.person.id },
        asked: { on: true },
      },
    });

    await viaPanel(core, kitchen.token, {
      device: lamp,
      capability: "light",
      command: { on: false },
    });
    expect(await lampSeenBy(core, kitchen.token, lamp)).toMatchObject({
      setBy: {
        app: "test.panel",
        actor: { kind: "client", id: kitchen.id },
        asked: { on: false },
      },
    });
  });

  it("counts a look held for a light that is off", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", { on: false });
    await settled();

    await viaPanel(core, maya.token, {
      device: lamp,
      capability: "light",
      command: { on: false, brightness: 30, colorTemperature: 400 },
    });
    await settled();

    expect(await lampSeenBy(core, maya.token, lamp)).toMatchObject({
      sync: "held",
      setBy: {
        app: "test.panel",
        asked: { on: false, brightness: 30, colorTemperature: 400 },
      },
    });
  });

  it("keeps the last command through a report and a command that fails", async () => {
    const { core, maya, lamp } = await lampsCore();
    await viaPanel(core, maya.token, {
      device: lamp,
      capability: "light",
      command: { on: true, brightness: 40 },
    });
    await settled();
    const before = (await lampSeenBy(core, maya.token, lamp)).setBy;

    // Its wall switch, then a command the radio cannot carry out.
    await radio.press("lamp-1", { on: false });
    await radio.unplug("lamp-1");
    core.advance(60_000);
    const failed = await command(core, maya.token, lamp, "light", {
      on: true,
    });

    expect(failed.statusCode).toBe(500);
    expect((await lampSeenBy(core, maya.token, lamp)).setBy).toEqual(before);
  });
});
