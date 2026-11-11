import { describe, expect, it, vi } from "vitest";

import { setupCommands } from "./device-command-support.js";

describe("commands whose deliveries overlap", () => {
  it.each([60, 110])(
    "keeps the previous deadline on rollback after %s ms",
    async (elapsed) => {
      const { command, deliveries, state, sent, unansweredAgain } =
        await setupCommands();
      const first = command(20);
      deliveries[0]!.resolve();
      await first;
      const second = command(40);
      const refused = expect(second).rejects.toMatchObject({
        code: "app_failed",
      });
      await vi.advanceTimersByTimeAsync(elapsed);
      deliveries[1]!.reject(new Error("radio failed"));
      await refused;
      if (elapsed < 100) {
        expect(state()).toMatchObject({
          sync: "pending",
          desired: { brightness: 20 },
        });
        await vi.advanceTimersByTimeAsync(100 - elapsed);
      }
      // The target the failure restored goes again, once.
      expect(sent().at(-1)).toEqual({ on: true, brightness: 20 });
      expect(state().sync).toBe("pending");
      await unansweredAgain();
      expect(sent()).toHaveLength(3);
      expect(state().sync).toBe("conflict");
    },
  );

  it("does not restore features that were removed while a newer command was pending", async () => {
    const { devices, registration, command, deliveries, state } =
      await setupCommands();
    const first = command(20);
    deliveries[0]!.resolve();
    await first;
    const second = devices.command(
      { kind: "app", id: "test.panel" },
      {
        device: devices.list()[0]!.id,
        capability: "light",
        command: { on: false },
      },
      {},
      "test.panel",
    );
    const refused = expect(second).rejects.toMatchObject({
      code: "app_failed",
    });
    devices.register("test.driver", {
      ...registration,
      capabilities: [{ id: "light", kind: "light" }],
    });
    deliveries[1]!.reject(new Error("radio failed"));
    await refused;
    expect(state()).toMatchObject({ desired: null, sync: "conflict" });
  });

  it("keeps the newer target when an older delivery fails", async () => {
    const { command, deliveries, state, sent, unansweredAgain } =
      await setupCommands();
    const first = command(20);
    const refused = expect(first).rejects.toMatchObject({ code: "app_failed" });
    const second = command(40);
    deliveries[1]!.resolve();
    await second;
    deliveries[0]!.reject(new Error("radio failed"));
    await refused;
    expect(state()).toMatchObject({
      sync: "pending",
      desired: { brightness: 40 },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent().at(-1)).toEqual({ on: true, brightness: 40 });
    await unansweredAgain();
    expect(state().sync).toBe("conflict");
  });

  it("does not let an older confirmation timer expire a newer delivery", async () => {
    const { command, deliveries, state, sent, unansweredAgain } =
      await setupCommands();
    const first = command(20);
    deliveries[0]!.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(50);
    const second = command(40);
    await vi.advanceTimersByTimeAsync(60);
    expect(state()).toMatchObject({
      sync: "pending",
      desired: { brightness: 40 },
    });
    deliveries[1]!.resolve();
    await second;
    await vi.advanceTimersByTimeAsync(99);
    expect(sent()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent()).toEqual([
      { on: true, brightness: 20 },
      { on: true, brightness: 40 },
      { on: true, brightness: 40 },
    ]);
    await unansweredAgain();
    expect(state().sync).toBe("conflict");
  });

  it("does not extend the newer deadline when an older delivery completes", async () => {
    const { command, deliveries, state, sent } = await setupCommands();
    const first = command(20);
    const second = command(40);
    deliveries[1]!.resolve();
    await second;
    await vi.advanceTimersByTimeAsync(80);
    deliveries[0]!.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(20);
    expect(sent()).toHaveLength(3);
    expect(state().sync).toBe("pending");
  });

  it.each([true, false])(
    "restores no failed target when both deliveries fail (oldest first: %s)",
    async (isOldestFirst) => {
      const { command, deliveries, state } = await setupCommands();
      const first = command(20);
      const second = command(40);
      const results = Promise.allSettled([first, second]);
      for (const index of isOldestFirst ? [0, 1] : [1, 0]) {
        deliveries[index]!.reject(new Error("radio failed"));
        await vi.advanceTimersByTimeAsync(0);
      }
      await results;
      expect(state()).toMatchObject({
        sync: "synced",
        desired: null,
        state: { brightness: 80 },
      });
    },
  );

  it("preserves a report that confirmed the command before delivery failed", async () => {
    const { command, deliveries, report, state } = await setupCommands();
    const first = command(20);
    deliveries[0]!.resolve();
    await first;
    const second = command(40);
    const refused = expect(second).rejects.toMatchObject({
      code: "app_failed",
    });
    report(40);
    deliveries[1]!.reject(new Error("failed after reporting"));
    await refused;
    expect(state()).toMatchObject({
      sync: "synced",
      desired: null,
      state: { brightness: 40 },
    });
  });

  it.each([true, false])(
    "keeps a delivered hold through failed targets (oldest first: %s)",
    async (isOldestFirst) => {
      const { devices, id, command, deliveries, state } = await setupCommands();
      const first = command(20);
      const setBy = {
        app: null,
        actor: { kind: "workflow" as const, id: "hold" },
        asked: { brightness: 100 },
        at: new Date().toISOString(),
      };
      devices.moved(id, "light", setBy);
      const second = command(40);
      const results = Promise.allSettled([first, second]);
      for (const index of isOldestFirst ? [0, 1] : [1, 0]) {
        deliveries[index]!.reject(new Error("radio failed"));
        await vi.advanceTimersByTimeAsync(0);
      }
      await results;
      expect(state()).toMatchObject({
        desired: null,
        sync: "synced",
        setBy,
      });
    },
  );

  it("preserves a restored look when off is reported before delivery fails", async () => {
    const { devices, id, deliveries, state } = await setupCommands();
    const sent = devices.command(
      { kind: "app", id: "test.panel" },
      {
        device: id,
        capability: "light",
        command: { on: false, brightness: 30 },
      },
      {},
      "test.panel",
    );
    const refused = expect(sent).rejects.toMatchObject({ code: "app_failed" });
    devices.report("test.driver", {
      key: "lamp",
      states: { light: { on: false, brightness: 80 } },
    });
    expect(state()).toMatchObject({
      sync: "held",
      desired: { brightness: 30 },
    });
    deliveries[0]!.reject(new Error("failed after reporting off"));
    await refused;
    expect(state()).toMatchObject({
      sync: "held",
      desired: { brightness: 30 },
      state: { on: false, brightness: 30 },
    });
  });

  it("does not restore a target onto a replacement capability", async () => {
    const { devices, registration, command, deliveries, state } =
      await setupCommands();
    const sent = command(20);
    const refused = expect(sent).rejects.toMatchObject({ code: "app_failed" });
    devices.register("test.driver", {
      ...registration,
      capabilities: [{ id: "light", kind: "switch" }],
    });
    deliveries[0]!.reject(new Error("radio failed"));
    await refused;
    expect(state()).toMatchObject({
      kind: "switch",
      sync: "synced",
      desired: null,
    });
  });
});

describe("who set a light, when deliveries overlap", () => {
  async function apps() {
    const context = await setupCommands();
    const send = (app: string, brightness: number) =>
      context.devices.command(
        { kind: "app", id: app },
        { device: context.id, capability: "light", command: { brightness } },
        {},
        app,
      );
    return { ...context, send };
  }

  it("goes back to who set the target a failure restores", async () => {
    const { send, deliveries, state } = await apps();
    const first = send("test.first", 20);
    deliveries[0]!.resolve();
    await first;
    const second = send("test.second", 40);
    expect(state().setBy).toMatchObject({ app: "test.second" });

    const refused = expect(second).rejects.toMatchObject({
      code: "app_failed",
    });
    deliveries[1]!.reject(new Error("radio failed"));
    await refused;

    expect(state().setBy).toMatchObject({
      app: "test.first",
      asked: { brightness: 20 },
    });
  });

  it("keeps who set the newer target when an older delivery fails", async () => {
    const { send, deliveries, state } = await apps();
    const first = send("test.first", 20);
    const refused = expect(first).rejects.toMatchObject({ code: "app_failed" });
    const second = send("test.second", 40);
    deliveries[1]!.resolve();
    await second;
    deliveries[0]!.reject(new Error("radio failed"));
    await refused;

    expect(state().setBy).toMatchObject({ app: "test.second" });
  });
});

describe("a light whose reports trail its commands", () => {
  it.each([true, false])(
    "keeps the brightness through an earlier off's fade (later on reported: %s)",
    async (hasLaterOnReport) => {
      const { devices, id, deliveries, report, state } = await setupCommands();
      const sent = Promise.all(
        [{ on: false }, { on: true, brightness: 40 }, { on: false }].map(
          (command) =>
            devices.command(
              { kind: "app", id: "test.panel" },
              { device: id, capability: "light", command },
              {},
              "test.panel",
            ),
        ),
      );
      for (const delivery of deliveries) delivery.resolve();
      await sent;
      const off = () =>
        devices.report("test.driver", {
          key: "lamp",
          states: { light: { on: false, brightness: 1 } },
        });

      report(10);
      off();
      expect(state()).toMatchObject({
        observed: { on: false, brightness: 80 },
        sync: "pending",
      });
      if (hasLaterOnReport) {
        report(40);
        report(10);
        off();
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(state()).toMatchObject({
        state: { on: false, brightness: hasLaterOnReport ? 40 : 80 },
        desired: null,
        sync: "synced",
      });
      // Its last report decided: nothing went again.
      expect(deliveries).toHaveLength(3);
    },
  );

  async function previewThenCancel(cancel: Record<string, unknown>) {
    const { devices, id, deliveries, state } = await setupCommands();
    const lamp = (on: boolean, brightness: number) =>
      devices.report("test.driver", {
        key: "lamp",
        states: { light: { on, brightness } },
      });
    const send = (command: Record<string, unknown>) =>
      devices.command(
        { kind: "app", id: "test.panel" },
        { device: id, capability: "light", command },
        {},
        "test.panel",
      );
    lamp(false, 80);
    const sent = Promise.all([
      send({ on: true, brightness: 40 }),
      send(cancel),
    ]);
    for (const delivery of deliveries) delivery.resolve();
    await sent;
    return { lamp, state, deliveries };
  }

  it("holds what an off says the light comes back at, after an echo of the light before", async () => {
    const { lamp, state } = await previewThenCancel({
      on: false,
      brightness: 80,
    });
    // Zigbee2MQTT's echo of the light before the preview.
    lamp(false, 80);
    lamp(false, 80);
    expect(state().sync).toBe("pending");
    for (let report = 0; report < 4; report++) lamp(true, 40);
    lamp(false, 1);
    expect(state()).toMatchObject({
      sync: "held",
      desired: { brightness: 80 },
      state: { on: false, brightness: 80 },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(state().sync).toBe("held");
  });

  it("goes by the light's last report once the off's time is up", async () => {
    const { lamp, state, deliveries } = await previewThenCancel({
      on: false,
      brightness: 30,
    });
    // It never showed the preview's on.
    lamp(false, 80);
    await vi.advanceTimersByTimeAsync(99);
    expect(state().sync).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(state()).toMatchObject({
      sync: "held",
      desired: { brightness: 30 },
      state: { on: false, brightness: 30 },
    });
    expect(deliveries).toHaveLength(2);
  });
});
