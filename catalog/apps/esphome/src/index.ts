import {
  defineApp,
  defineDevicePage,
  discoverPermission,
  lanPermission,
} from "@meetsanctum/app-sdk";
import { createDriver, type Driver, type DriverOptions } from "./driver.js";
import { deviceAction } from "./page.js";
import { esphomeService } from "./sightings.js";

// The ESPHome driver app: brings the lights, switches, sensors, motion and
// contact sensors and buttons of ESPHome's devices on the home's network
// into the core's Devices, over ESPHome's native API, one connection to
// each device. The manager finds them on mDNS and lets the app reach the
// devices it found, on the API's port, and nothing else. A device with an
// encryption key is added with it, and never talked to without it; one
// waiting for a key gets one of its own, which removing it takes off. Its
// UI, a page in each of its devices' detail, is in ./ui.

export type { DriverOptions } from "./driver.js";

/** The app, with timings a test may shorten. */
export function createEsphomeApp(options: DriverOptions = {}) {
  let driver: Driver | undefined;

  function running() {
    if (!driver) throw new Error("The ESPHome app is not running");
    return driver;
  }

  const device = deviceAction((deviceId) => running().page(deviceId));

  return defineApp({
    id: "sanctum.esphome",
    name: "ESPHome",
    // 0.2.0: a device waiting for a key gets one of its own, and removing
    // it takes the key off. 0.3.1: a device's maker and product come from
    // its project's name, and one waiting for a key is listed by its maker.
    version: "0.4.0",
    core: "^2.0.0",
    summary:
      "Brings your ESPHome lights, plugs, sensors and buttons into your home.",
    icon: { glyph: "cpu", color: "graphite" },
    permissions: [
      {
        id: "devices.register",
        reason: "To add your ESPHome devices and keep their state.",
        needed: true,
      },
      {
        id: discoverPermission(esphomeService),
        reason: "To find your ESPHome devices.",
        needed: true,
      },
      {
        id: lanPermission(6053),
        reason: "To talk to the ESPHome devices it found.",
        needed: true,
      },
    ],
    provides: {
      devicePages: [
        defineDevicePage({
          id: "esphome.device",
          title: "ESPHome",
          devices: "own",
        }),
      ],
    },
    migrations: "migrations",
    actions: [device],
    events: [],
    async start(ctx) {
      const started = createDriver(ctx, options);
      driver = started;
      try {
        await started.start();
      } catch (error) {
        if (driver === started) driver = undefined;
        await started.stop();
        throw error;
      }
    },
    async stop() {
      await driver?.stop();
      driver = undefined;
    },
    driver: {
      async command(_ctx, command) {
        await running().command(command);
      },
      async identify(_ctx, device) {
        await running().identify(device);
      },
      async discovered(_ctx, discovery) {
        await running().discovered(discovery);
      },
      async add(_ctx, add) {
        return running().add(add);
      },
      async repair(_ctx, repair) {
        return running().repair(repair);
      },
      async remove(_ctx, removal) {
        await running().remove(removal);
      },
      problems: {
        keyMismatch: {
          words: "Its encryption key doesn't match",
          repair: {
            help: "Its key changed, as when it's flashed with a new configuration. Enter the key from that configuration, under api: encryption: key.",
            asks: ["key"],
          },
        },
        keyAdded: {
          words: "It has an encryption key now",
          repair: {
            help: "It was flashed with a configuration that has one. Enter the key from that configuration, under api: encryption: key.",
            asks: ["key"],
          },
        },
      },
      questions: {
        key: {
          label: "Encryption key",
          kind: "secret",
          help: "From its configuration, under api: encryption: key.",
          refusals: {
            wrongKey:
              "That key doesn't match. Copy it again from its configuration, under api: encryption: key.",
          },
        },
      },
      refusals: {
        notWaiting:
          "It stopped waiting for a key. Turn it off and on again, then add it.",
        keyChanged:
          "It has another key now. Add it again with the key from its configuration, under api: encryption: key.",
      },
    },
  });
}

export default createEsphomeApp();
