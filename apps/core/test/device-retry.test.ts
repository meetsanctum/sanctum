import { describe, expect, it, vi } from "vitest";

import { setupCommands } from "./device-command-support.js";
import type { testCore } from "./support.js";

describe("a command its device has not confirmed in time", () => {
  // The command's own entry in the activity log.
  const entryOf = (core: Awaited<ReturnType<typeof testCore>>) =>
    core.activity.recent().find((entry) => entry.action === "device.command");

  it("is not sent again when the device confirms it in time", async () => {
    const { command, deliveries, report, state, sent } = await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    report(20);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(1);
    expect(state()).toMatchObject({
      sync: "synced",
      desired: null,
      state: { brightness: 20 },
    });
  });

  it("goes once more at its deadline, as it went, and the device can confirm it then", async () => {
    const { core, command, deliver, deliveries, report, state, sent } =
      await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    await vi.advanceTimersByTimeAsync(99);
    expect(sent()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent()).toEqual([
      { on: true, brightness: 20 },
      { on: true, brightness: 20 },
    ]);
    expect(vi.mocked(deliver).mock.calls[1]![2]).toEqual({
      kind: "app",
      id: "test.panel",
    });
    expect(state()).toMatchObject({
      sync: "pending",
      desired: { brightness: 20 },
    });
    expect(entryOf(core)).toMatchObject({
      outcome: "ok",
      detail: { asked: { brightness: 20 }, resent: true },
    });

    deliveries[1]!.resolve();
    await vi.advanceTimersByTimeAsync(50);
    report(20);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(2);
    expect(state()).toMatchObject({ sync: "synced", desired: null });
    expect(entryOf(core)).toMatchObject({ outcome: "ok" });
  });

  it("fails once the device has answered neither", async () => {
    const { core, command, deliveries, state, sent, unansweredAgain } =
      await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(99);
    deliveries[1]!.resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(state().sync).toBe("pending");
    await unansweredAgain();
    expect(state()).toMatchObject({
      sync: "conflict",
      desired: null,
      state: { brightness: 80 },
    });
    expect(entryOf(core)).toMatchObject({
      outcome: "failed",
      reason: "no_answer",
      detail: { resent: true },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent()).toHaveLength(2);
  });

  it("never goes again once a newer command has replaced it", async () => {
    const { command, deliveries, state, sent, unansweredAgain } =
      await setupCommands();
    const first = command(20);
    deliveries[0]!.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(50);
    const second = command(40);
    deliveries[1]!.resolve();
    await second;
    await vi.advanceTimersByTimeAsync(60);
    expect(sent()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(40);
    expect(sent()).toEqual([
      { on: true, brightness: 20 },
      { on: true, brightness: 40 },
      { on: true, brightness: 40 },
    ]);
    await unansweredAgain();
    expect(state().sync).toBe("conflict");
  });

  it("leaves a newer command alone when it finishes going again after it", async () => {
    const { command, deliveries, state, sent } = await setupCommands();
    const first = command(20);
    deliveries[0]!.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(100);
    const newer = command(60);
    deliveries[2]!.resolve();
    await newer;
    deliveries[1]!.resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(state()).toMatchObject({
      sync: "pending",
      desired: { brightness: 60 },
    });
    expect(sent()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent().at(-1)).toEqual({ on: true, brightness: 60 });
  });

  it("is confirmed by a report while it goes again", async () => {
    const { command, deliveries, report, state, sent } = await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    await vi.advanceTimersByTimeAsync(100);
    report(20);
    deliveries[1]!.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(2);
    expect(state()).toMatchObject({ sync: "synced", desired: null });
  });

  it("fails at once, saying why, when it cannot go again", async () => {
    const { core, command, deliveries, state, sent } = await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    await vi.advanceTimersByTimeAsync(100);
    deliveries[1]!.reject(new Error("driver stopped"));
    await vi.advanceTimersByTimeAsync(0);
    // It restores nothing: the device took the first one.
    expect(state()).toMatchObject({ sync: "conflict", desired: null });
    expect(entryOf(core)).toMatchObject({
      outcome: "failed",
      reason: "app_failed",
      detail: { resent: true },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent()).toHaveLength(2);
  });

  it("sends only the off again for a colour asked while the off was on its way", async () => {
    const { devices, deliveries, sent } = await setupCommands();
    const { id } = devices.register("test.driver", {
      key: "bulb",
      name: "Bulb",
      capabilities: [
        {
          id: "light",
          kind: "light" as const,
          features: {
            brightness: true,
            colorTemperature: { min: 153, max: 500 },
          },
        },
      ],
    });
    devices.report("test.driver", {
      key: "bulb",
      states: { light: { on: true, brightness: 80, colorTemperature: 300 } },
    });
    const state = () => devices.get(id)!.capabilities[0]!;
    const send = (command: Record<string, unknown>) =>
      devices.command(
        { kind: "app", id: "test.panel" },
        { device: id, capability: "light", command },
        {},
        "test.panel",
      );
    const off = send({ on: false, transitionSeconds: 2 });
    deliveries[0]!.resolve();
    await off;
    await vi.advanceTimersByTimeAsync(50);
    await send({ colorTemperature: 400 });
    expect(sent()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent()).toEqual([
      { on: false, transitionSeconds: 2 },
      { on: false, transitionSeconds: 2 },
    ]);
    // The off goes again once in all, whatever is asked meanwhile.
    deliveries[1]!.resolve();
    await vi.advanceTimersByTimeAsync(20);
    await send({ colorTemperature: 450 });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(2);
    expect(state()).toMatchObject({ sync: "conflict", desired: null });
  });

  it.each([
    { isRejected: false, isRetry: false, hasReplacement: false },
    { isRejected: true, isRetry: false, hasReplacement: false },
    { isRejected: false, isRetry: true, hasReplacement: false },
    { isRejected: true, isRetry: true, hasReplacement: false },
    { isRejected: true, isRetry: false, hasReplacement: true },
    { isRejected: true, isRetry: true, hasReplacement: true },
  ])(
    "keeps a shared off's delivery result and deadline (rejected: $isRejected, retry: $isRetry, replaced: $hasReplacement)",
    async ({ isRejected, isRetry, hasReplacement }) => {
      const { core, devices, id, registration, deliveries, state, sent } =
        await setupCommands();
      devices.register("test.driver", {
        ...registration,
        capabilities: [
          {
            id: "light",
            kind: "light",
            features: {
              brightness: true,
              colorTemperature: { min: 153, max: 500 },
            },
          },
        ],
      });
      const send = (command: Record<string, unknown>) =>
        devices.command(
          { kind: "app", id: "test.panel" },
          { device: id, capability: "light", command },
          {},
          "test.panel",
        );
      const off = send({ on: false });
      const result = Promise.allSettled([off]);
      if (isRetry) {
        deliveries[0]!.resolve();
        await off;
        await vi.advanceTimersByTimeAsync(100);
      }
      // This command sends nothing: it depends on the off being delivered.
      await send({ colorTemperature: 400 });
      const replacement = hasReplacement
        ? Promise.allSettled([send({ on: true })])
        : undefined;
      if (isRejected) {
        deliveries[isRetry ? 1 : 0]!.reject(new Error("driver stopped"));
        await vi.advanceTimersByTimeAsync(0);
        if (replacement) {
          expect(state().sync).toBe("pending");
          deliveries.at(-1)!.reject(new Error("newer delivery failed"));
          await replacement;
        }
        expect(state().sync).toBe("conflict");
        expect(
          core.activity
            .recent()
            .find(
              (entry) =>
                entry.detail?.asked &&
                (entry.detail.asked as Record<string, unknown>)
                  .colorTemperature === 400,
            ),
        ).toMatchObject({
          outcome: "failed",
          reason: "app_failed",
        });
      } else {
        await vi.advanceTimersByTimeAsync(150);
        expect(state().sync).toBe("pending");
        expect(sent()).toHaveLength(isRetry ? 2 : 1);
        deliveries.at(-1)!.resolve();
        await vi.advanceTimersByTimeAsync(99);
        expect(state().sync).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        if (!isRetry) {
          deliveries.at(-1)!.resolve();
          await vi.advanceTimersByTimeAsync(100);
        }
        expect(state().sync).toBe("conflict");
      }
      await result;
      expect(
        sent().filter((command) => "on" in command && command.on === false),
      ).toEqual(
        isRejected && !isRetry
          ? [{ on: false }]
          : [{ on: false }, { on: false }],
      );
    },
  );

  it("goes again and waits even when its entry cannot say so", async () => {
    const { core, command, deliveries, state, sent, unansweredAgain } =
      await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    vi.spyOn(core.activity, "update").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent()).toHaveLength(2);
    await unansweredAgain();
    expect(state().sync).toBe("conflict");
  });

  it("does not go again once a hold's move has the light", async () => {
    const { devices, id, command, deliveries, state, sent } =
      await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    devices.moving(id, "light");
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(1);
    expect(state().sync).toBe("conflict");
  });

  it("does not go again once the core starts stopping", async () => {
    const { devices, command, deliveries, state, sent } = await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    devices.closing();
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(1);
    expect(state().sync).toBe("conflict");
  });

  it("does not go again once its capability can no longer carry it out", async () => {
    const { devices, registration, command, deliveries, state, sent } =
      await setupCommands();
    const sending = command(20);
    deliveries[0]!.resolve();
    await sending;
    devices.register("test.driver", {
      ...registration,
      capabilities: [{ id: "light", kind: "light" }],
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(1);
    expect(state()).toMatchObject({ sync: "conflict", desired: null });
  });
});
