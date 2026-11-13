import { describe, expect, it, onTestFinished, vi } from "vitest";

import { firmwareRules } from "../src/devices/firmware.js";
import {
  devicesSeenBy,
  lampsCore,
  openLive,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { post, sharedClient, type TestCore } from "./support.js";

// Firmware updates and Check connection, with the lamps driver's pretend
// radio: any client checks for an update, starts it and stops it through the
// device's driver, which says how it goes; Check connection asks a device how
// it is and waits for its report.

function entries(core: TestCore, action: string) {
  return core.activity.recent().filter((entry) => entry.action === action);
}

async function firmwareOf(core: TestCore, token: string, id: string) {
  const devices = await devicesSeenBy(core, token);
  return devices.find((device: { id: string }) => device.id === id).firmware;
}

describe("a device's firmware", () => {
  it("shows what each device runs, and which can be updated or asked", async () => {
    const { core, maya } = await lampsCore();
    await radio.add("remote-1", "button", "Hall remote");

    const devices = await devicesSeenBy(core, maya.token);

    expect(
      devices.map(
        (device: { driverName: string; firmware: unknown; probe: boolean }) => [
          device.driverName,
          device.firmware,
          device.probe,
        ],
      ),
    ).toEqual([
      ["Hall remote", null, false],
      [
        "Kettle plug",
        expect.objectContaining({ version: "1.0.0", updatable: false }),
        true,
      ],
      [
        "Kitchen lamp",
        {
          version: "1.0.0",
          updatable: true,
          sleeps: false,
          state: null,
          progress: null,
          remainingSeconds: null,
          problem: null,
          checkedAt: null,
          startedAt: null,
          endedAt: null,
        },
        true,
      ],
    ]);
  });

  it("checks for an update through the driver", async () => {
    const { core, maya, lamp } = await lampsCore();
    radio.updates.add("lamp-1");

    const checked = await post(
      core,
      "/api/devices/firmware/check",
      { id: lamp },
      maya,
    );

    expect(checked.statusCode).toBe(200);
    expect(checked.json().firmware).toMatchObject({
      state: "available",
      checkedAt: core.now().toISOString(),
    });
    expect(radio.firmwareCalls).toEqual([
      {
        hook: "check",
        key: "lamp-1",
        actor: { kind: "user", id: maya.person.id },
      },
    ]);
    expect(entries(core, "device.firmware.check")).toMatchObject([
      { outcome: "ok", subjectId: lamp, personId: maya.person.id },
    ]);
  });

  it("is for every client, shared ones too, but never a workflow", async () => {
    const { core, lamp } = await lampsCore();
    radio.updates.add("lamp-1");
    const ben = personWithClient(core);
    const tablet = sharedClient(core);

    const checked = await post(
      core,
      "/api/devices/firmware/check",
      { id: lamp },
      ben,
    );
    const checkedOnTablet = await post(
      core,
      "/api/devices/firmware/check",
      { id: lamp },
      { token: tablet.token },
    );

    expect(checked.statusCode).toBe(200);
    expect(checkedOnTablet.statusCode).toBe(200);
    expect(radio.firmwareCalls.map(({ actor }) => actor)).toEqual([
      { kind: "user", id: ben.person.id },
      { kind: "client", id: tablet.id },
    ]);
    // An update takes a device away and cannot be undone: nothing starts
    // one with no person behind it.
    expect(() =>
      core.gate.permit({ kind: "workflow", id: "w" }, firmwareRules.update),
    ).toThrow(expect.objectContaining({ code: "needs_approval" }));
  });

  it("refuses a device its driver cannot update", async () => {
    const { core, maya, plug } = await lampsCore();

    const checked = await post(
      core,
      "/api/devices/firmware/check",
      { id: plug },
      maya,
    );

    expect(checked.statusCode).toBe(409);
    expect(radio.firmwareCalls).toEqual([]);
  });

  it("updates a device, following the driver until the update ends", async () => {
    const { core, maya, lamp } = await lampsCore();
    radio.updates.add("lamp-1");
    await post(core, "/api/devices/firmware/check", { id: lamp }, maya);
    const live = await openLive(core, maya.token);
    const startedAt = core.now().toISOString();

    const started = await post(
      core,
      "/api/devices/firmware/update",
      { id: lamp },
      maya,
    );

    expect(started.statusCode).toBe(200);
    expect(started.json().firmware).toMatchObject({
      state: "updating",
      progress: 0,
      startedAt,
    });
    core.advance(60_000);
    await radio.sayFirmware("lamp-1", {
      state: "updating",
      progress: 34.5,
      remainingSeconds: 3000,
    });
    expect(await firmwareOf(core, maya.token, lamp)).toMatchObject({
      state: "updating",
      progress: 34.5,
      remainingSeconds: 3000,
      startedAt,
    });
    expect(live.messages).toContainEqual(
      expect.objectContaining({
        type: "device",
        id: lamp,
        device: expect.objectContaining({
          firmware: expect.objectContaining({ progress: 34.5 }),
        }),
      }),
    );

    core.advance(60_000);
    await radio.sayFirmware("lamp-1", { state: "current" });

    expect(await firmwareOf(core, maya.token, lamp)).toMatchObject({
      state: "current",
      progress: null,
      remainingSeconds: null,
      startedAt,
      endedAt: core.now().toISOString(),
      checkedAt: core.now().toISOString(),
    });
    expect(entries(core, "device.firmware.update")).toMatchObject([
      { outcome: "ok", subjectId: lamp, personId: maya.person.id },
    ]);
    expect(entries(core, "device.firmware.updated")).toMatchObject([
      { outcome: "ok", subjectId: lamp },
    ]);
  });

  it("starts only an update the driver knows of, one device at a time", async () => {
    const { core, maya, lamp } = await lampsCore();

    const unknown = await post(
      core,
      "/api/devices/firmware/update",
      { id: lamp },
      maya,
    );
    expect(unknown.statusCode).toBe(409);

    await radio.add("lamp-2", "light", "Desk lamp");
    const desk = (await devicesSeenBy(core, maya.token)).find(
      (device: { driverName: string }) => device.driverName === "Desk lamp",
    ).id;
    radio.updates.add("lamp-1").add("lamp-2");
    await post(core, "/api/devices/firmware/check", { id: lamp }, maya);
    await post(core, "/api/devices/firmware/check", { id: desk }, maya);
    await post(core, "/api/devices/firmware/update", { id: lamp }, maya);

    const second = await post(
      core,
      "/api/devices/firmware/update",
      { id: desk },
      maya,
    );

    expect(second.statusCode).toBe(409);
    expect(
      radio.firmwareCalls.filter((call) => call.hook === "update"),
    ).toMatchObject([{ key: "lamp-1" }]);
  });

  it("keeps a failed update until the driver says it is current", async () => {
    const { core, maya, lamp } = await lampsCore();
    radio.updates.add("lamp-1");
    await post(core, "/api/devices/firmware/check", { id: lamp }, maya);
    await post(core, "/api/devices/firmware/update", { id: lamp }, maya);

    await radio.sayFirmware("lamp-1", {
      state: "failed",
      problem: "It stopped answering at 62%.",
    });
    // Zigbee2MQTT says the update is available again once one fails.
    await radio.sayFirmware("lamp-1", { state: "available" });

    expect(await firmwareOf(core, maya.token, lamp)).toMatchObject({
      state: "failed",
      problem: "It stopped answering at 62%.",
      endedAt: core.now().toISOString(),
    });
    expect(entries(core, "device.firmware.failed")).toMatchObject([
      { outcome: "failed", subjectId: lamp, reason: "driver" },
    ]);

    // Trying again is allowed.
    const again = await post(
      core,
      "/api/devices/firmware/update",
      { id: lamp },
      maya,
    );
    expect(again.json().firmware).toMatchObject({
      state: "updating",
      problem: null,
    });
  });

  it("stops an update, and the device keeps what it runs", async () => {
    const { core, maya, lamp } = await lampsCore();
    radio.updates.add("lamp-1");
    await post(core, "/api/devices/firmware/check", { id: lamp }, maya);
    await post(core, "/api/devices/firmware/update", { id: lamp }, maya);

    const stopped = await post(
      core,
      "/api/devices/firmware/stop",
      { id: lamp },
      maya,
    );

    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().firmware).toMatchObject({
      state: "available",
      version: "1.0.0",
      endedAt: core.now().toISOString(),
    });
    expect(
      (await post(core, "/api/devices/firmware/stop", { id: lamp }, maya))
        .statusCode,
    ).toBe(409);
    expect(entries(core, "device.firmware.stop")).toMatchObject([
      { outcome: "refused", reason: "conflict" },
      { outcome: "ok", subjectId: lamp },
    ]);
  });

  it("keeps a failure reported before the driver's start hook resolves", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.sayFirmware("lamp-1", { state: "available" });
    const hook = vi.spyOn(radio, "firmware").mockImplementation(async () => {
      await radio.sayFirmware("lamp-1", { state: "updating", progress: 0 });
      await radio.sayFirmware("lamp-1", {
        state: "failed",
        problem: "It stopped answering.",
      });
    });
    onTestFinished(() => hook.mockRestore());

    const started = await post(
      core,
      "/api/devices/firmware/update",
      { id: lamp },
      maya,
    );

    expect(started.json().firmware).toMatchObject({
      state: "failed",
      problem: "It stopped answering.",
    });
  });

  it("refreshes the deadline when the driver repeats the same progress", async () => {
    const { core, lamp } = await lampsCore({ firmwareStaleMs: 100 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const report = { state: "updating", progress: 10, remainingSeconds: 3000 };
    await radio.sayFirmware("lamp-1", report);
    await vi.advanceTimersByTimeAsync(80);
    await radio.sayFirmware("lamp-1", report);
    await vi.advanceTimersByTimeAsync(80);

    expect(core.devices.row(lamp)?.firmware?.state).toBe("updating");
    await vi.advanceTimersByTimeAsync(21);
    expect(core.devices.row(lamp)?.firmware?.state).toBe("failed");
  });

  it("ends an update that stops saying anything", async () => {
    const { core, maya, lamp } = await lampsCore({ firmwareStaleMs: 20 });
    radio.updates.add("lamp-1");
    await post(core, "/api/devices/firmware/check", { id: lamp }, maya);
    await post(core, "/api/devices/firmware/update", { id: lamp }, maya);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await firmwareOf(core, maya.token, lamp)).toMatchObject({
      state: "failed",
      problem: "It stopped answering.",
    });
    expect(entries(core, "device.firmware.failed")).toMatchObject([
      { outcome: "failed", reason: "stopped_answering" },
    ]);
  });

  it("fails a check the device does not answer, keeping what was known", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.unplug("lamp-1");

    const checked = await post(
      core,
      "/api/devices/firmware/check",
      { id: lamp },
      maya,
    );

    expect(checked.statusCode).toBe(500);
    expect(checked.json()).toEqual({ error: "app_failed" });
    expect(await firmwareOf(core, maya.token, lamp)).toMatchObject({
      state: null,
      checkedAt: null,
    });
    expect(entries(core, "device.firmware.check")).toMatchObject([
      { outcome: "failed", reason: "app_failed" },
    ]);
  });
});

describe("checking a device's connection", () => {
  it("answers how long the device took to say how it is", async () => {
    const { core, maya, lamp } = await lampsCore();

    const probed = await post(core, "/api/devices/probe", { id: lamp }, maya);

    expect(probed.statusCode).toBe(200);
    expect(probed.json()).toEqual({ answeredInMs: expect.any(Number) });
    expect(radio.probes).toEqual([
      { key: "lamp-1", actor: { kind: "user", id: maya.person.id } },
    ]);
    expect(entries(core, "device.probe")).toMatchObject([
      { outcome: "ok", subjectId: lamp, personId: maya.person.id },
    ]);
  });

  it("says when a device does not answer in time", async () => {
    const { core, maya, lamp } = await lampsCore({ probeWaitMs: 20 });
    await radio.unplug("lamp-1");
    await settled();

    const probed = await post(core, "/api/devices/probe", { id: lamp }, maya);

    expect(probed.json()).toEqual({ answeredInMs: null });
    expect(entries(core, "device.probe")).toMatchObject([
      { outcome: "ok", reason: "no_answer" },
    ]);
  });

  it("does not count an offline report as an answer", async () => {
    const { core, maya, lamp } = await lampsCore({ probeWaitMs: 20 });
    const hook = vi.spyOn(radio, "probe").mockImplementation(async () => {
      core.devices.report("test.lamps", {
        key: "lamp-1",
        availability: "offline",
      });
    });
    onTestFinished(() => hook.mockRestore());

    const probed = await post(core, "/api/devices/probe", { id: lamp }, maya);

    expect(probed.json()).toEqual({ answeredInMs: null });
  });

  it("answers in its own time when the driver never finishes asking", async () => {
    const { core, maya, lamp } = await lampsCore({ probeWaitMs: 20 });
    radio.probeHangs = true;

    const probed = await post(core, "/api/devices/probe", { id: lamp }, maya);

    expect(probed.statusCode).toBe(200);
    expect(probed.json()).toEqual({ answeredInMs: null });
  });

  it("refuses a device that cannot be asked", async () => {
    const { core, maya } = await lampsCore();
    await radio.add("remote-1", "button", "Hall remote");
    const remote = (await devicesSeenBy(core, maya.token)).find(
      (device: { driverName: string }) => device.driverName === "Hall remote",
    ).id;

    const probed = await post(core, "/api/devices/probe", { id: remote }, maya);

    expect(probed.statusCode).toBe(409);
    expect(radio.probes).toEqual([]);
  });
});
