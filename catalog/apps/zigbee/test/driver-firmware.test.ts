import { createDriverCore } from "@meetsanctum/app-testkit";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { createZigbeeApp } from "../src/index.js";
import {
  actionExpose,
  lightExpose,
  PretendBridge,
  zigbeeDevice,
} from "./pretend-bridge.js";

// Firmware over the air and Check connection against Zigbee2MQTT, played by
// the pretend bridge: what the driver registers of each device's firmware,
// what it says as Zigbee2MQTT publishes it, and the requests it makes for
// someone's check, update and stop and for a probe. Rewritten from v1's
// OTA and probe tests (core-zigbee-ota.test.ts, core-zigbee-events.test.ts,
// Pragmata v1-final) against the Drivers contract.

const bridge = await PretendBridge.start();
afterAll(() => bridge.stop());
beforeEach(() => bridge.reset());

let made = 0;
function fresh(name: string) {
  made += 1;
  return {
    key: `0x00178802000000${made.toString(16).padStart(2, "0")}`,
    name: `${name}_${made}`,
  };
}

async function running(heartbeatMs = 60_000) {
  const app = createZigbeeApp({
    answerMs: 300,
    removeMs: 300,
    reconnectWaitMs: 300,
    checkMs: 300,
    progressEveryMs: 0,
    heartbeatMs,
  });
  const core = createDriverCore(app, {
    services: { zigbee2mqtt: bridge.connection },
  });
  await core.start();
  onTestFinished(async () => {
    await core.stop();
    expect(core.refused).toEqual([]);
  });
  return core;
}

// A Hue bulb Zigbee2MQTT can update over the air.
function hueBulb(key: string, name: string, extra = {}) {
  return zigbeeDevice(key, name, [lightExpose()], {
    software_build_id: "1.126.9",
    definition: {
      vendor: "Philips",
      model: "LCA016",
      description: "Hue Essential White and Color Ambiance A60",
      exposes: [lightExpose()],
      supports_ota: true,
    },
    ...extra,
  });
}

async function added(core: Awaited<ReturnType<typeof running>>, bulb = true) {
  const { key, name } = fresh(bulb ? "bulb" : "remote");
  await bridge.add(
    bulb
      ? hueBulb(key, name)
      : zigbeeDevice(key, name, [actionExpose(["single", "double"])], {
          power_source: "Battery",
          definition: {
            vendor: "Philips",
            model: "RWL021",
            description: "Hue dimmer switch",
            exposes: [actionExpose(["single", "double"])],
            supports_ota: true,
          },
        }),
    bulb ? { state: "ON", brightness: 200 } : {},
  );
  // Its retained availability reaches the driver once it listens, so what
  // it says from then on, asleep or not, is heard.
  await core.until(() => core.availability.get(key) === "online", "listening");
  return { key, name };
}

const requests = (kind: string) =>
  bridge.received.filter(
    (each) => each.topic === `bridge/request/device/ota_update/${kind}`,
  );

describe("a device's firmware", () => {
  it("is registered with what it runs, and whether it can be updated or asked", async () => {
    const core = await running();
    const bulb = await added(core);
    const remote = await added(core, false);
    const { key, name } = fresh("plug");
    await bridge.add(
      zigbeeDevice(key, name, [lightExpose()], { date_code: "20240101" }),
      { state: "OFF" },
    );
    await core.until(() => core.registered.has(key), "registered");

    expect(core.registered.get(bulb.key)).toMatchObject({
      firmware: { version: "1.126.9", updatable: true },
      probe: true,
    });
    expect(core.registered.get(remote.key)).toMatchObject({
      firmware: { version: null, updatable: true, sleeps: true },
      probe: false,
    });
    expect(core.registered.get(key)).toMatchObject({
      firmware: { version: "20240101", updatable: false },
      probe: true,
    });
  });

  it("follows what Zigbee2MQTT publishes of it with the device's state", async () => {
    const core = await running();
    const { key, name } = await added(core);

    await bridge.offerFirmware(name, 16780552, 16781824);

    await core.until(
      () => core.firmwareOf(key)?.state === "available",
      "an update available",
    );
    // The same again is no news.
    await bridge.say(name, { brightness: 100 });
    await core.until(
      () => core.latest(key, "light")?.brightness === 39,
      "said",
    );
    expect(core.firmware.filter((each) => each.key === key)).toHaveLength(1);
  });

  it("checks for an update for the core", async () => {
    const core = await running();
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 2, 2);
    await core.until(() => core.firmwareOf(key)?.state === "current", "known");
    await bridge.offerFirmware(name, 2, 3);
    await core.until(() => core.firmwareOf(key)?.state === "available", "news");

    await core.firmwareCall("check", key);

    expect(requests("check")).toEqual([
      {
        topic: "bridge/request/device/ota_update/check",
        payload: { id: key, transaction: expect.stringMatching(/^sanctum-/) },
      },
    ]);
    expect(core.firmwareOf(key)).toMatchObject({ state: "available" });
  });

  it("fails a check the device does not answer", async () => {
    const core = await running();
    const { key, name } = await added(core);
    await bridge.unplug(name);

    await expect(core.firmwareCall("check", key)).rejects.toThrow(
      /didn't respond/,
    );
  });

  it("refuses a device Zigbee2MQTT cannot update", async () => {
    const core = await running();
    const { key, name } = fresh("plug");
    await bridge.add(zigbeeDevice(key, name, [lightExpose()]), {});
    await core.until(() => core.registered.has(key), "registered");

    await expect(core.firmwareCall("update", key)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(requests("update")).toEqual([]);
  });

  it("updates a device, saying how far it has come and how it ended", async () => {
    const core = await running();
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 1, 2);
    await core.until(() => core.firmwareOf(key)?.state === "available", "news");

    await core.firmwareCall("update", key);
    expect(core.firmwareOf(key)).toMatchObject({
      state: "updating",
      progress: 0,
    });
    await core.until(() => requests("update").length === 1, "asked");
    await bridge.otaProgress(name, 34.5, 3000);
    await core.until(
      () => core.firmwareOf(key)?.progress === 34.5,
      "its progress",
    );
    expect(core.firmwareOf(key)).toMatchObject({ remainingSeconds: 3000 });
    await bridge.otaEnd(name, "ok", "1.130.4");

    await core.until(() => core.firmwareOf(key)?.state === "current", "done");
    // Zigbee2MQTT interviews it again, with what it runs now.
    await core.until(
      () => core.registered.get(key)?.firmware?.version === "1.130.4",
      "its new version",
    );
    expect(requests("update")).toEqual([
      {
        topic: "bridge/request/device/ota_update/update",
        payload: { id: key, transaction: expect.stringMatching(/^sanctum-/) },
      },
    ]);
  });

  it("tells the core an update is still under way while Zigbee2MQTT is online", async () => {
    const core = await running(20);
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 1, 2);
    await core.firmwareCall("update", key);
    await core.until(() => requests("update").length === 1, "asked");
    await bridge.otaProgress(name, 100, 0);
    const updating = () =>
      core.firmware.filter(
        (each) => each.key === key && each.state === "updating",
      ).length;
    const before = updating();

    // A device that checks its new firmware holds 100% for a while.
    await core.until(() => updating() >= before + 3, "heartbeats");
    expect(core.firmware.at(-1)).toMatchObject({
      key,
      state: "updating",
      progress: 100,
      remainingSeconds: 0,
    });

    // Gone, Zigbee2MQTT leaves the core's own deadline to end it.
    await bridge.setOnline(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const offline = updating();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(updating()).toBe(offline);
    await bridge.setOnline(true);
  });

  it("stops saying an update is under way once Zigbee2MQTT restarted without it", async () => {
    const core = await running(20);
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 1, 2);
    await core.firmwareCall("update", key);
    await core.until(() => requests("update").length === 1, "asked");
    await bridge.otaProgress(name, 30, 1000);
    await core.until(() => core.firmwareOf(key)?.progress === 30, "progress");

    // Zigbee2MQTT restarts while the driver is away from the broker.
    await bridge.disconnectDriver();
    bridge.restartDuringUpdates();

    // Back, the driver reads every device again, and the bulb's state says
    // the update is available, not under way.
    await core.until(
      () => core.firmwareOf(key)?.state === "available",
      "the update no longer under way",
      5_000,
    );
    const said = core.firmware.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(core.firmware.length).toBe(said);
  });

  it("says why an update failed", async () => {
    const core = await running();
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 1, 2);
    await core.firmwareCall("update", key);

    await core.until(() => requests("update").length === 1, "asked");
    await bridge.otaEnd(name, "error");

    // Zigbee2MQTT says the update is available again too, maybe after its
    // answer: the core keeps the failure while it is.
    const failed = () =>
      core.firmware.find((each) => each.key === key && each.state === "failed");
    await core.until(() => failed() !== undefined, "failed");
    expect(failed()).toMatchObject({ problem: "It stopped answering." });
  });

  it("stops an update, which is no failure", async () => {
    const core = await running();
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 1, 2);
    await core.firmwareCall("update", key);

    await core.firmwareCall("stop", key);

    expect(requests("update/abort")).toHaveLength(1);
    expect(core.firmwareOf(key)).toMatchObject({ state: "available" });
    await bridge.say(name, { brightness: 100 });
    await core.until(
      () => core.latest(key, "light")?.brightness === 39,
      "said",
    );
    expect(core.firmware.some((each) => each.state === "failed")).toBe(false);
  });

  it("ignores an aborted update's delayed reply after another update starts", async () => {
    const core = await running();
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 1, 2);
    await core.firmwareCall("update", key);
    const publish = bridge.publish.bind(bridge);
    let aborted: unknown;
    const held = vi
      .spyOn(bridge, "publish")
      .mockImplementation(async (topic, payload, retain) => {
        if (topic === "bridge/response/device/ota_update/update") {
          aborted = payload;
          return;
        }
        await publish(topic, payload, retain);
      });
    onTestFinished(() => held.mockRestore());
    await core.firmwareCall("stop", key);
    held.mockRestore();
    await core.firmwareCall("update", key);
    await publish("bridge/response/device/ota_update/update", aborted);
    await bridge.say(name, { brightness: 100 });
    await core.until(
      () => core.latest(key, "light")?.brightness === 39,
      "reply processed",
    );

    expect(core.firmware.some((each) => each.state === "failed")).toBe(false);
  });

  it("reports firmware again after a device is removed and rejoins", async () => {
    const core = await running();
    const { key, name } = await added(core);
    await bridge.offerFirmware(name, 1, 2);
    await core.until(
      () => core.firmwareOf(key)?.state === "available",
      "available",
    );
    const before = core.firmware.length;
    await core.remove(key);
    await bridge.add(hueBulb(key, name), { state: "ON" });
    await core.until(() => core.registered.has(key), "registered again");
    await bridge.offerFirmware(name, 1, 2);

    await core.until(
      () => core.firmware.length > before,
      "firmware reported again",
    );
    expect(core.firmwareOf(key)?.state).toBe("available");
  });

  it("unschedules a sleeping device after aborting its active update", async () => {
    const core = await running();
    const { key, name } = await added(core, false);
    await core.firmwareCall("update", key);
    await bridge.otaProgress(name, 30, 3000);
    await core.until(
      () => core.firmwareOf(key)?.state === "updating",
      "awake and updating",
    );

    await core.firmwareCall("stop", key);

    expect(requests("update/abort")).toHaveLength(1);
    expect(requests("unschedule")).toHaveLength(1);
    expect(core.firmwareOf(key)?.state).toBe("available");
  });

  it("has a sleeping device update when it wakes, until stopped", async () => {
    const core = await running();
    const { key } = await added(core, false);

    await core.firmwareCall("update", key);
    expect(requests("schedule")).toHaveLength(1);
    expect(requests("update")).toEqual([]);
    expect(core.firmwareOf(key)).toMatchObject({ state: "waiting" });

    await core.firmwareCall("stop", key);
    expect(requests("unschedule")).toHaveLength(1);
    expect(core.firmwareOf(key)).toMatchObject({ state: "available" });
  });
  it("unschedules a sleeping device's update after the driver restarts", async () => {
    const core = await running();
    const { key } = await added(core, false);
    await core.firmwareCall("update", key);
    // A new driver knows nothing of what it said before.
    await core.stop();
    core.registered.delete(key);
    await core.start();
    await core.until(() => core.registered.has(key), "registered again");

    await core.firmwareCall("stop", key);

    expect(requests("update/abort")).toHaveLength(1);
    expect(requests("unschedule")).toHaveLength(1);
    expect(core.firmwareOf(key)).toMatchObject({ state: "available" });
  });
});

describe("checking a device's connection", () => {
  it("asks the device for what it shows, and its state answers", async () => {
    const core = await running();
    const { key, name } = await added(core);
    const reads = () =>
      bridge.received.filter((each) => each.topic === `${name}/get`);
    await core.until(
      () => reads().length > 0 && core.latest(key, "light") !== undefined,
      "initial state",
    );
    const readCount = reads().length;
    const reports = core.reports.length;

    await core.probe(key);
    // Publishing at QoS 0 finishes before the pretend bridge receives it.
    await core.until(
      () => reads().length > readCount && core.reports.length > reports,
      "probe request and response",
    );

    expect(reads().at(-1)).toEqual({
      topic: `${name}/get`,
      payload: { state: "", brightness: "" },
    });
  });

  it("refuses a device that sleeps", async () => {
    const core = await running();
    const { key } = await added(core, false);

    await expect(core.probe(key)).rejects.toMatchObject({ code: "conflict" });
  });
});
