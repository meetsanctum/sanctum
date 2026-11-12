import {
  createAppContext,
  type AppContext,
  type CoreCalls,
  type DeviceReport,
  type ServiceConnection,
} from "@meetsanctum/app-sdk";
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

import { createBridge } from "../src/bridge.js";
import { createZigbeeApp } from "../src/index.js";
import {
  climateExposes,
  lightExpose,
  PretendBridge,
  switchExpose,
  zigbeeDevice,
} from "./pretend-bridge.js";

// The driver against Zigbee2MQTT, played by the pretend bridge over a real
// broker: what it registers and reports, the commands it publishes,
// letting devices join and removing them. Remotes are driver-remotes'.

const bridge = await PretendBridge.start();
afterAll(() => bridge.stop());
beforeEach(() => bridge.reset());

// Each test's devices have names of their own, since what the broker
// retains for a name outlives a test.
let made = 0;
function fresh(name: string) {
  made += 1;
  return {
    key: `0x00178801000000${made.toString(16).padStart(2, "0")}`,
    name: `${name}_${made}`,
  };
}

async function running(
  services: Record<string, ServiceConnection> = {
    zigbee2mqtt: bridge.connection,
  },
) {
  const app = createZigbeeApp({
    answerMs: 300,
    removeMs: 300,
    reconnectWaitMs: 300,
  });
  const core = createDriverCore(app, { services });
  await core.start();
  onTestFinished(async () => {
    await core.stop();
    expect(core.refused).toEqual([]);
  });
  // The app's own actions, as the core runs them once the gate has let
  // the caller through.
  const action = (id: string, input: unknown) =>
    app.actions.find((each) => each.id === id)!.run({} as AppContext, input);
  return { app, core, action };
}

const dimmable = (key: string, name: string) =>
  zigbeeDevice(key, name, [lightExpose()]);

describe("letting devices join", () => {
  it("opens the network for the core's pairing, then registers a device once it has been interviewed", async () => {
    const { core, action } = await running();
    const { key, name } = fresh("bulb");

    const opened = await core.openPairing(60);
    await bridge.add(
      zigbeeDevice(key, name, [lightExpose()], {
        interview_completed: false,
        interviewing: true,
        interview_state: "IN_PROGRESS",
      }),
      { state: "ON", brightness: 200 },
    );
    await bridge.publish("bridge/event", {
      type: "device_joined",
      data: { friendly_name: name, ieee_address: key },
    });
    await core.until(() => core.stageOf(key) === "joined", "joined");
    // Nothing yet: its definition is not known until the interview ends.
    await core.until(() => core.reports.length === 0, "still waiting");
    expect(core.registered.has(key)).toBe(false);
    await bridge.change(name, dimmable(key, name));
    await core.until(() => core.registered.has(key), "registered");

    expect(bridge.received[0]).toEqual({
      topic: "bridge/request/permit_join",
      payload: { time: 60, transaction: expect.stringMatching(/^sanctum-/) },
    });
    expect(Date.parse(opened.until!) - Date.now()).toBeGreaterThan(55_000);
    expect(await action("zigbee.status", {})).toEqual({
      broker: "connected",
      bridge: "online",
      joinUntil: expect.any(String),
    });
    expect(core.registered.get(key)).toMatchObject({
      name,
      capabilities: [{ id: "light", kind: "light" }],
    });
    await core.until(() => core.stageOf(key) === "ready", "ready");
    // It asks the new device what it shows, and reports that.
    await core.until(
      () => core.latest(key, "light")?.brightness === 79,
      "its state reported",
    );
  });

  it("says how each device that joins is getting on", async () => {
    const { core } = await running();
    const bulb = fresh("bulb");
    const door = fresh("door");
    const broken = fresh("broken");
    await core.openPairing(60);

    // One at a time, as devices join a network.
    await bridge.join(dimmable(bulb.key, bulb.name), { state: "OFF" });
    await core.until(() => core.stageOf(bulb.key) === "ready", "ready");
    // A door sensor exposes nothing the core can use.
    await bridge.join(
      zigbeeDevice(door.key, door.name, [], {
        definition: {
          vendor: "Aqara",
          model: "MCCGQ11LM",
          description: "Door and window sensor",
          exposes: [{ type: "binary", property: "contact", access: 1 }],
        },
      }),
      {},
    );
    await core.until(
      () => core.stageOf(door.key) === "unsupported",
      "unsupported",
    );
    await bridge.join(dimmable(broken.key, broken.name), {}, "failed");
    await core.until(() => core.stageOf(broken.key) === "failed", "failed");

    expect(core.joining.filter((each) => each.key === bulb.key)).toEqual([
      { key: bulb.key, stage: "joined", description: null },
      { key: bulb.key, stage: "interviewing", description: null },
      { key: bulb.key, stage: "ready", description: "Test light" },
    ]);
    expect(core.joining.filter((each) => each.key === door.key).at(-1)).toEqual(
      {
        key: door.key,
        stage: "unsupported",
        description: "Door and window sensor",
      },
    );
    expect(core.registered.has(door.key)).toBe(false);
  });

  it("closes the network when the core stops pairing", async () => {
    const { core, action } = await running();

    await core.openPairing(60);
    await core.closePairing();

    expect(bridge.received.at(-1)).toMatchObject({
      topic: "bridge/request/permit_join",
      payload: { time: 0 },
    });
    expect(await action("zigbee.status", {})).toMatchObject({
      joinUntil: null,
    });
  });

  it("fails when Zigbee2MQTT refuses or does not answer", async () => {
    const { core } = await running();

    bridge.permitJoin = "error";
    await expect(core.openPairing(60)).rejects.toThrow(
      "Coordinator is not started",
    );
    bridge.permitJoin = "silent";
    await expect(core.openPairing(60)).rejects.toThrow(
      "Zigbee2MQTT did not answer: permit join",
    );
  });
});

describe("removing a device", () => {
  async function withLight() {
    const app = await running();
    const { key, name } = fresh("bulb");
    await bridge.add(dimmable(key, name), { state: "OFF" });
    await app.core.until(() => app.core.registered.has(key), "registered");
    return { ...app, key, name };
  }

  it("asks Zigbee2MQTT to remove it by its address, then hears no more of it", async () => {
    const { core, key, name } = await withLight();
    const marked = vi.spyOn(core.availability, "set");

    await core.remove(key);

    expect(bridge.received.at(-1)).toEqual({
      topic: "bridge/request/device/remove",
      payload: {
        id: key,
        force: false,
        transaction: expect.stringMatching(/^sanctum-/),
      },
    });
    const reported = core.reports.length;
    await bridge.publish(name, { state: "ON" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(core.reports).toHaveLength(reported);
    // The core removed it, so it was never offline: it is gone.
    expect(marked).not.toHaveBeenCalledWith(key, "offline");
    expect(core.registered.has(key)).toBe(false);
    expect(core.availability.has(key)).toBe(false);
  });

  it("says a device that leaves by itself is offline, and brings it back as itself", async () => {
    const { core, key, name } = await withLight();

    await bridge.leave(name);
    await core.until(() => core.availability.get(key) === "offline", "offline");
    await expect(
      core.command(key, "light", "light", { on: true }),
    ).rejects.toMatchObject({ code: "not_found" });

    core.registered.delete(key);
    await core.openPairing(60);
    await bridge.join(dimmable(key, name), { state: "ON" });
    await core.until(() => core.registered.has(key), "registered again");
    await core.until(
      () => core.availability.get(key) === "online",
      "online again",
    );
  });

  it("says a device that left while it was not running is offline once it starts again", async () => {
    const { core } = await running();
    const stays = fresh("bulb");
    const leaves = fresh("bulb");
    for (const { key, name } of [stays, leaves]) {
      await bridge.add(dimmable(key, name), { state: "OFF" });
      await core.until(() => core.registered.has(key), "registered");
    }
    await core.until(
      () => core.availability.get(leaves.key) === "online",
      "online",
    );

    await core.stop();
    await bridge.leave(leaves.name);
    await core.start();

    await core.until(
      () => core.availability.get(leaves.key) === "offline",
      "offline after the restart",
    );
    expect(core.availability.get(stays.key)).toBe("online");
  });

  it("fails while the device does not answer, and removes it by force", async () => {
    const { core, key, name } = await withLight();
    await bridge.unplug(name);

    await expect(core.remove(key)).rejects.toThrow(
      /Failed to remove device .* \(Error: Timeout\)/,
    );
    await core.remove(key, true);

    expect(bridge.received.at(-1)).toMatchObject({
      topic: "bridge/request/device/remove",
      payload: { id: key, force: true },
    });
  });

  it("fails when Zigbee2MQTT does not answer", async () => {
    const { core, key } = await withLight();
    bridge.answersRemoval = false;

    await expect(core.remove(key)).rejects.toThrow(
      "Zigbee2MQTT did not answer: device remove",
    );
  });

  it("does not treat a malformed device list as proof that a device has gone", async () => {
    const { core, key } = await withLight();
    await bridge.publish("bridge/devices", null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await core.remove(key);
    expect(bridge.received.at(-1)).toMatchObject({
      topic: "bridge/request/device/remove",
      payload: { id: key, force: false },
    });
  });

  const removals = () =>
    bridge.received.filter(
      (each) => each.topic === "bridge/request/device/remove",
    );

  it("has gone already when Zigbee2MQTT's list does not have it", async () => {
    // Once the light is registered, the driver has read the list.
    const { core } = await withLight();

    await core.remove("0x00178801ffffffff");

    expect(removals()).toEqual([]);
  });

  it("has gone already when Zigbee2MQTT says it does not exist", async () => {
    const { core, key, name } = await withLight();
    // As when it went between two lists.
    bridge.forget(name);

    await core.remove(key);

    expect(removals()).toMatchObject([{ payload: { id: key } }]);
  });

  it("registers it afresh when it joins again", async () => {
    const { core, key, name } = await withLight();
    await core.remove(key);

    await core.openPairing(60);
    await bridge.join(dimmable(key, name), { state: "ON" });

    await core.until(() => core.registered.has(key), "registered again");
    await core.until(() => core.stageOf(key) === "ready", "ready");
  });
});

describe("a light's brightness", () => {
  it("is reported when off too, and confirms a command's percentage", async () => {
    const { core } = await running();
    const { key, name } = fresh("lamp");
    await bridge.add(dimmable(key, name), { state: "OFF", brightness: 1 });
    await core.until(() => !!core.latest(key, "light"), "reported");

    expect(core.latest(key, "light")).toEqual({ on: false, brightness: 1 });
    for (const brightness of [1, 33, 40, 99, 100]) {
      await core.command(key, "light", "light", { on: true, brightness });
      await core.until(
        () => core.latest(key, "light")?.brightness === brightness,
        `confirmed at ${brightness}%`,
      );
    }
    expect(bridge.stateOf(name)).toMatchObject({
      state: "ON",
      brightness: 254,
    });
  });

  it("is left out while a light says it is on at 0", async () => {
    const { core } = await running();
    const { key, name } = fresh("lamp");
    await bridge.add(dimmable(key, name), { state: "ON", brightness: 120 });
    await core.until(() => !!core.latest(key, "light"), "reported");
    expect(core.latest(key, "light")).toEqual({ on: true, brightness: 47 });

    await bridge.say(name, { brightness: 0 });

    // What it showed before, as it joined and as the driver read it, may be
    // reported after this, but not after what it says now.
    await expect.poll(() => core.latest(key, "light")).toEqual({ on: true });
  });
});

describe("what devices say", () => {
  it("refreshes devices discovered before the bridge is ready", async () => {
    const { key, name } = fresh("starting_plug");
    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "ON",
    });
    await bridge.setOnline(false);
    const { core, action } = await running();
    await core.until(
      () => bridge.received.some((each) => each.topic === `${name}/get`),
      "initial read sent",
    );
    await expect
      .poll(() => action("zigbee.status", {}))
      .toMatchObject({ bridge: "offline" });
    expect(core.latest(key, "switch")).toBeUndefined();

    await bridge.setOnline(true);

    await core.until(
      () => core.latest(key, "switch")?.on === true,
      "read once the bridge is ready",
    );
  });

  it("refreshes state missed while disconnected from the broker", async () => {
    const { core, action } = await running();
    const { key, name } = fresh("reconnected_plug");
    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "OFF",
    });
    await core.until(() => core.latest(key, "switch")?.on === false, "off");

    await bridge.disconnectDriver();
    await expect
      .poll(() => action("zigbee.status", {}))
      .toMatchObject({
        broker: "disconnected",
      });
    await bridge.say(name, { state: "ON" });

    await core.until(
      () => core.latest(key, "switch")?.on === true,
      "refreshed after reconnect",
      4_000,
    );
    expect(
      bridge.received.filter((each) => each.topic === `${name}/get`),
    ).toHaveLength(2);
  });

  it("is reported as it happens, with the device online", async () => {
    const { core } = await running();
    const { key, name } = fresh("plug");
    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "OFF",
    });
    await core.until(() => !!core.latest(key, "switch"), "reported");

    await bridge.say(name, { state: "ON", power: 4 });
    await core.until(() => core.latest(key, "switch")?.on === true, "on");

    expect(core.reports.at(-1)).toEqual({
      key,
      availability: "online",
      states: { switch: { on: true } },
    });
  });

  it("reports a climate sensor's readings in standard units, and its battery", async () => {
    const { core } = await running();
    const { key, name } = fresh("climate");
    await bridge.add(
      zigbeeDevice(key, name, climateExposes(), { power_source: "Battery" }),
      { temperature: 21.5, humidity: 48, battery: 87, linkquality: 90 },
    );
    // Its retained availability reaches the driver once it listens.
    await core.until(
      () => core.availability.get(key) === "online",
      "listening",
    );

    // It sleeps, so it is never asked: what it says comes when it wakes.
    await bridge.say(name, {
      temperature: 22.1,
      humidity: 51,
      pressure: 960,
      battery: 86,
      voltage: 3005,
    });
    await core.until(
      () => core.latest(key, "temperature")?.value === 22.1,
      "warmer",
    );
    expect(core.reports.at(-1)).toEqual({
      key,
      availability: "online",
      states: { temperature: { value: 22.1 }, humidity: { value: 51 } },
      battery: 86,
    });
  });

  it("leaves out a device's retained state, which may be older than the core's", async () => {
    const { key, name } = fresh("lamp");
    await bridge.add(dimmable(key, name), { state: "OFF", brightness: 50 });
    await bridge.publish(name, { state: "ON", brightness: 10 }, true);
    onTestFinished(() => bridge.publish(name, "", true));

    const { core } = await running();
    await core.until(() => !!core.latest(key, "light"), "reported");

    expect(
      core.reports.filter((report) => report.states.light?.on === true),
    ).toEqual([]);
  });

  it("reports a battery-powered device that is not heard from as unknown", async () => {
    const { core } = await running();
    const { key, name } = fresh("remote_plug");
    await bridge.add(
      zigbeeDevice(key, name, [switchExpose()], { power_source: "Battery" }),
      { state: "OFF" },
    );
    await core.until(() => core.registered.has(key), "registered");

    await bridge.unplug(name);
    await core.until(
      () => core.reports.some((report) => report.availability === "unknown"),
      "unknown",
    );
    expect(core.reports.map((report) => report.availability)).not.toContain(
      "offline",
    );
    // A sleeping device is not asked what it shows.
    expect(
      bridge.received.filter((each) => each.topic.endsWith("/get")),
    ).toEqual([]);
  });

  it("follows a device that is renamed, under the same key", async () => {
    const { core } = await running();
    const { key, name } = fresh("plug");
    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "OFF",
    });
    await core.until(() => !!core.latest(key, "switch"), "reported");

    await bridge.change(
      name,
      zigbeeDevice(key, `${name}_hall`, [switchExpose()]),
    );
    await core.until(
      () => core.registered.get(key)?.name === `${name}_hall`,
      "renamed",
    );
    await core.command(key, "switch", "switch", { on: true });
    await core.until(() => core.latest(key, "switch")?.on === true, "on");

    expect(bridge.received.at(-1)).toMatchObject({
      topic: `${name}_hall/set`,
      payload: { state: "ON" },
    });
  });
});

describe("re-registering a device", () => {
  // The bridge on its own, with a core whose driver calls a test sets.
  async function bridgeWith(
    calls: Pick<CoreCalls, "register" | "report" | "present">,
  ) {
    const absent = async (): Promise<never> => {
      throw new Error("not in this test");
    };
    const zigbee = createBridge(
      createAppContext({
        appId: "sanctum.zigbee",
        actor: { kind: "app", id: "sanctum.zigbee" },
        core: {
          query: absent,
          settings: absent,
          permissions: absent,
          permissionsRevision: absent,
          people: absent,
          places: absent,
          devices: absent,
          device: absent,
          command: absent,
          location: absent,
          publish: absent,
          unpublish: absent,
          entities: absent,
          fetch: absent,
          joining: absent,
          press: absent,
          release: absent,
          firmware: absent,
          emit: absent,
          follow: absent,
          scheduleJob: absent,
          cancelJob: absent,
          jobs: absent,
          putWorkflow: absent,
          removeWorkflow: absent,
          workflows: absent,
          serviceConnection: async () => bridge.connection,
          ...calls,
          log() {},
        },
      }),
      { reconnectWaitMs: 300 },
    );
    await zigbee.open();
    onTestFinished(() => zigbee.close());
    return zigbee;
  }

  it("keeps a device the core has when the core does not take the change", async () => {
    const registered: string[] = [];
    const reports: DeviceReport[] = [];
    let refusing = false;
    const zigbee = await bridgeWith({
      async register(registration) {
        if (refusing) {
          throw new Error("the core is busy");
        }
        registered.push(registration.name);
        return { id: registration.key };
      },
      async report(report) {
        reports.push(report);
      },
      present: async () => {},
    });
    const { key, name } = fresh("plug");
    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "OFF",
    });
    await expect.poll(() => registered).toEqual([name]);

    refusing = true;
    await bridge.change(
      name,
      zigbeeDevice(key, `${name}_hall`, [switchExpose()]),
    );
    // Its new name's topics are followed: the driver asks it for its state.
    await expect
      .poll(() =>
        bridge.received.some((each) => each.topic === `${name}_hall/get`),
      )
      .toBe(true);
    await zigbee.command({
      key,
      device: key,
      capability: "switch",
      kind: "switch",
      command: { on: true },
    });

    await expect
      .poll(() =>
        reports.some(
          (report) =>
            (report.states?.switch as { on?: boolean } | undefined)?.on ===
            true,
        ),
      )
      .toBe(true);
    expect(bridge.received.at(-1)).toMatchObject({
      topic: `${name}_hall/set`,
      payload: { state: "ON" },
    });
    expect(registered).toEqual([name]);
  });

  it("still has a device the core does not take after a restart", async () => {
    const present: string[][] = [];
    await bridgeWith({
      register: async () => {
        throw new Error("the core is busy");
      },
      report: async () => {},
      async present({ keys }) {
        present.push([...keys]);
      },
    });
    const { key, name } = fresh("plug");

    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "OFF",
    });

    // It is on the network still, so it has not gone.
    await expect.poll(() => present.at(-1)).toContain(key);
  });
});

describe("commands", () => {
  it("go to the capability's own endpoint", async () => {
    const { core } = await running();
    const { key, name } = fresh("double_switch");
    await bridge.add(
      zigbeeDevice(key, name, [switchExpose("l1"), switchExpose("l2")]),
      { state_l1: "OFF", state_l2: "OFF" },
    );
    await core.until(() => !!core.latest(key, "l2"), "reported");

    await core.command(key, "l2", "switch", { on: true });
    await core.until(() => core.latest(key, "l2")?.on === true, "l2 on");

    expect(core.latest(key, "l1")).toEqual({ on: false });
    expect(bridge.received.at(-1)).toEqual({
      topic: `${name}/set`,
      payload: { state_l2: "ON" },
    });
  });

  it("are refused for a capability the device does not have", async () => {
    const { core } = await running();
    const { key, name } = fresh("plug");
    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "OFF",
    });
    await core.until(() => core.registered.has(key), "registered");

    await expect(
      core.command(key, "light", "light", { on: true }),
    ).rejects.toMatchObject({ name: "ActionError", code: "not_found" });
  });
});
