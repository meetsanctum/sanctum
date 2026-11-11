import {
  ActionError,
  defineApp,
  registerPermission,
  toStaticManifest,
} from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import { describe, expect, it, vi } from "vitest";

import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { claimed, post } from "./support.js";

useCleanUps();

describe("a driver that runs apart", () => {
  const driverApp = (commands: { key: string; actor: string }[]) =>
    defineApp({
      ...base,
      id: "test.driver",
      permissions: [{ id: registerPermission, reason: "For the test." }],
      actions: [],
      start: async (ctx) => {
        await ctx.devices.register({
          key: "lamp",
          name: "Lamp",
          capabilities: [{ id: "light", kind: "switch", features: {} }],
        } as never);
        await ctx.devices.report({
          key: "lamp",
          availability: "online",
          states: { light: { on: false } },
        } as never);
      },
      driver: {
        command: async (ctx, command) => {
          commands.push({ key: command.key, actor: ctx.actor.id });
          if (command.key === "nope") throw new ActionError("not_found");
        },
      },
    });

  it("takes a command as the person behind it", async () => {
    const commands: { key: string; actor: string }[] = [];
    const { core } = await apart(driverApp(commands), { confirmMs: 40 });
    const maya = await claimed(core);
    await running(core, "test.driver");
    const device = core.devices.list()[0]!;

    const answer = await post(
      core,
      "/api/devices/command",
      {
        device: device.id,
        capability: "light",
        command: { on: true },
      },
      maya,
    );

    expect(answer.statusCode).toBe(200);
    expect(commands).toEqual([{ key: "lamp", actor: maya.person.id }]);
  });

  it("sends a command again to the same run, unconfirmed", async () => {
    const commands: { key: string; actor: string }[] = [];
    const { core } = await apart(driverApp(commands), { confirmMs: 40 });
    const maya = await claimed(core);
    await running(core, "test.driver");
    const device = core.devices.list()[0]!;

    await post(
      core,
      "/api/devices/command",
      { device: device.id, capability: "light", command: { on: true } },
      maya,
    );

    await vi.waitFor(() => expect(commands).toHaveLength(2), {
      timeout: 2_000,
    });
  });

  it("never sends a command again to a driver that has restarted", async () => {
    const commands: { key: string; actor: string }[] = [];
    const { core, session, reconnect } = await apart(driverApp(commands), {
      confirmMs: 150,
    });
    const maya = await claimed(core);
    await running(core, "test.driver");
    const device = core.devices.list()[0]!;

    await post(
      core,
      "/api/devices/command",
      { device: device.id, capability: "light", command: { on: true } },
      maya,
    );
    expect(commands).toHaveLength(1);
    await session.shutdown(100);
    reconnect();
    await vi.waitFor(() => expect(core.apps.driverRun("test.driver")).toBe(2));
    await running(core, "test.driver");

    await new Promise((done) => setTimeout(done, 400));

    expect(commands).toHaveLength(1);
    // It ended as a command that couldn't go, with its light as it reported.
    expect(core.devices.get(device.id)?.capabilities[0]).toMatchObject({
      sync: "conflict",
      desired: null,
      state: { on: false },
    });
  });

  it("never sends a command again to a driver that was removed and installed again", async () => {
    const commands: { key: string; actor: string }[] = [];
    const app = driverApp(commands);
    const { core, reconnect } = await apart(app, { confirmMs: 1_000 });
    const maya = await claimed(core);
    await running(core, app.id);
    const device = core.devices.list()[0]!;

    await post(
      core,
      "/api/devices/command",
      { device: device.id, capability: "light", command: { on: true } },
      maya,
    );
    expect(commands).toHaveLength(1);
    await core.apps.remove(app.id);
    const manifest = toStaticManifest(app);
    await core.apps.start([
      {
        apart: {
          manifest,
          digest: manifestDigest(JSON.stringify(manifest)),
          folder: "1.0.0+test",
        },
        origin: "official",
      },
    ]);
    reconnect();
    await running(core, app.id);

    await vi.waitFor(
      () =>
        expect(core.devices.get(device.id)?.capabilities[0]?.sync).toBe(
          "conflict",
        ),
      { timeout: 3_000 },
    );

    expect(commands).toHaveLength(1);
  });
});
