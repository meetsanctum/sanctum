import { createDriverCore } from "@meetsanctum/app-testkit";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { createZigbeeApp } from "../src/index.js";
import {
  actionExpose,
  lightExpose,
  PretendBridge,
  zigbeeDevice,
} from "./pretend-bridge.js";

// Remotes against Zigbee2MQTT, played by the pretend bridge: the presses
// and holds a remote registers, each press handed on once, a hold once
// however often the remote repeats it and its release, and a light's
// brightness moved while a remote is held.

const bridge = await PretendBridge.start();
afterAll(() => bridge.stop());
beforeEach(() => bridge.reset());

let made = 0;
function fresh(name: string) {
  made += 1;
  return {
    key: `0x00178803000000${made.toString(16).padStart(2, "0")}`,
    name: `${name}_${made}`,
  };
}

async function running() {
  const app = createZigbeeApp({
    answerMs: 300,
    removeMs: 300,
    reconnectWaitMs: 300,
  });
  const core = createDriverCore(app, {
    services: { zigbee2mqtt: bridge.connection },
  });
  await core.start();
  onTestFinished(async () => {
    await core.stop();
    expect(core.refused).toEqual([]);
  });
  return { core };
}

const dimmable = (key: string, name: string) =>
  zigbeeDevice(key, name, [lightExpose()]);

describe("a remote", () => {
  // An office button: battery-powered, so it sleeps between presses.
  const miniSwitch = (key: string, name: string) =>
    zigbeeDevice(
      key,
      name,
      [actionExpose(["single", "double", "hold", "release"])],
      { power_source: "Battery" },
    );

  it("is registered with its presses, ready once it joins", async () => {
    const { core } = await running();
    const { key, name } = fresh("button");
    await core.openPairing(60);

    await bridge.join(miniSwitch(key, name), { battery: 100 });
    await core.until(() => core.stageOf(key) === "ready", "ready");

    expect(core.registered.get(key)?.capabilities).toEqual([
      {
        id: "button",
        kind: "button",
        features: { actions: ["single", "double", "hold"], holds: ["hold"] },
      },
    ]);
  });

  it("hands on each press once, as it happens, with the remote online", async () => {
    const { core } = await running();
    const { key, name } = fresh("button");
    await bridge.add(miniSwitch(key, name), { battery: 100 });
    // Its retained availability reaches the driver once it listens: a
    // press before that would be lost.
    await core.until(
      () => core.availability.get(key) === "online",
      "listening",
    );

    await bridge.press(name, "single");
    await bridge.press(name, "single");
    await bridge.press(name, "double");
    await core.until(() => core.presses.length === 3, "three presses");

    expect(core.presses).toEqual([
      { key, capability: "button", action: "single" },
      { key, capability: "button", action: "single" },
      { key, capability: "button", action: "double" },
    ]);
    expect(core.availability.get(key)).toBe("online");
  });

  it("hands on a release as the end of a hold, and no action it does not declare or retained press", async () => {
    const { key, name } = fresh("button");
    await bridge.add(miniSwitch(key, name), { battery: 100 });
    // A press kept on the broker, as when someone set retain on the
    // device, is from before the driver was there.
    await bridge.press(name, "single", true);
    onTestFinished(() => bridge.publish(name, "", true));
    const { core } = await running();
    await core.until(
      () => core.availability.get(key) === "online",
      "listening",
    );

    await bridge.press(name, "hold");
    await bridge.press(name, "release");
    await bridge.press(name, "triple");
    await bridge.say(name, { battery: 99 });
    // The driver handles them in order, so once it has the last, it has
    // all four.
    await core.until(
      () =>
        core.reports.some((each) => each.key === key && each.battery === 99),
      "the last message",
    );

    expect(core.presses).toEqual([
      { key, capability: "button", action: "hold" },
    ]);
    expect(core.releases).toEqual([{ key, capability: "button" }]);
  });

  it("hands on a Hue dimmer's tap at its release, and a hold without the tap it starts as", async () => {
    const { core } = await running();
    const { key, name } = fresh("dimmer");
    await bridge.add(
      zigbeeDevice(
        key,
        name,
        [
          actionExpose([
            "up_press",
            "up_press_release",
            "up_hold",
            "up_hold_release",
          ]),
        ],
        { power_source: "Battery" },
      ),
      { battery: 100 },
    );
    await core.until(
      () => core.availability.get(key) === "online",
      "listening",
    );

    await bridge.press(name, "up_press");
    await bridge.press(name, "up_press_release");
    await core.until(() => core.presses.length === 1, "the tap");
    for (const action of ["up_press", "up_hold", "up_hold", "up_hold"]) {
      await bridge.press(name, action);
    }
    await bridge.press(name, "up_hold_release");
    await core.until(() => core.releases.length === 1, "the release");

    expect(core.presses).toEqual([
      { key, capability: "button", action: "up_press" },
      { key, capability: "button", action: "up_hold" },
    ]);
    expect(core.releases).toEqual([{ key, capability: "button" }]);
  });
});

describe("a light held by a remote", () => {
  it("moves its brightness with brightness_move, and stops it", async () => {
    const { core } = await running();
    const { key, name } = fresh("bulb");
    await bridge.add(dimmable(key, name), { state: "ON", brightness: 100 });
    await core.until(() => core.registered.has(key), "registered");

    const sets = () =>
      bridge.received
        .filter((each) => each.topic === `${name}/set`)
        .map((each) => each.payload);
    await core.move(key, "light", { move: "up", percentPerSecond: 25 });
    await core.move(key, "light", { move: "stop" });
    await core.until(() => sets().length === 2, "two moves");

    expect(sets()).toEqual([
      { brightness_move: 64 },
      { brightness_move: "stop" },
    ]);
    await expect(
      core.move(key, "power", { move: "stop" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
