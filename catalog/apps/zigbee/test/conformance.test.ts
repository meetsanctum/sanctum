import { describeDriver } from "@meetsanctum/app-testkit";
import { afterAll } from "vitest";

import { createZigbeeApp } from "../src/index.js";
import { aqaraMotionSensor } from "./motion-sensors.js";
import {
  actionExpose,
  climateExposes,
  lightExpose,
  PretendBridge,
  switchExpose,
  zigbeeDevice,
} from "./pretend-bridge.js";

// The capability test suite, with Zigbee2MQTT played by the pretend bridge
// over a real broker.

const bridge = await PretendBridge.start();
afterAll(() => bridge.stop());

let added = 0;
const names = new Map<string, string>();

describeDriver({
  app: createZigbeeApp({ answerMs: 500, reconnectWaitMs: 500 }),
  kinds: ["light", "switch", "button", "sensor", "occupancy"],
  services: { zigbee2mqtt: bridge.connection },
  setUp: () => bridge.reset(),
  async add(kind) {
    added += 1;
    const key = `0x00158d00000000${added.toString(16).padStart(2, "0")}`;
    const name = `${kind}_${added}`;
    names.set(key, name);
    if (kind === "light") {
      await bridge.add(
        zigbeeDevice(key, name, [
          lightExpose({ colorTemperature: [153, 454], color: "color_xy" }),
        ]),
        {
          state: "OFF",
          brightness: 254,
          color_temp: 370,
          color_mode: "color_temp",
        },
      );
    } else if (kind === "button") {
      // A wall switch's buttons, on mains power, so it goes offline when
      // it stops answering.
      await bridge.add(
        zigbeeDevice(key, name, [
          actionExpose(["single", "double", "hold", "release"]),
        ]),
        { linkquality: 120 },
      );
    } else if (kind === "sensor") {
      // A climate sensor on mains power whose readings can be read again,
      // so it is asked for them and goes offline when it stops answering.
      await bridge.add(
        zigbeeDevice(
          key,
          name,
          climateExposes().map((expose) => ({ ...expose, access: 5 })),
        ),
        { temperature: 21.5, humidity: 48, linkquality: 90 },
      );
    } else if (kind === "occupancy") {
      // An Aqara P1, whose sensitivity and blinking are its own and whose
      // wait is Zigbee2MQTT's option, on mains power for the suite, so it
      // is asked what it shows and goes offline when it stops answering.
      await bridge.add(
        {
          ...aqaraMotionSensor(key, name, "RTCGQ14LM"),
          type: "Router",
          power_source: "Mains (single phase)",
        },
        {
          occupancy: false,
          illuminance: 120,
          motion_sensitivity: "medium",
          detection_interval: 30,
          trigger_indicator: true,
        },
      );
    } else {
      await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
        state: "OFF",
      });
    }
    return key;
  },
  unplug: (key) => bridge.unplug(names.get(key)!),
  press: (key, action) => bridge.press(names.get(key)!, action),
});
