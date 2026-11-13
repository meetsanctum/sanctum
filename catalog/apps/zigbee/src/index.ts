import {
  defineAction,
  defineApp,
  isNotReady,
  NotReady,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { createBridge, type Bridge, type BridgeOptions } from "./bridge.js";

// The Zigbee driver app: brings the lights, switches, remotes and sensors
// Zigbee2MQTT knows into the core's Devices, through the Drivers contract,
// moves lights' brightness while a remote is held, lets new devices join
// while the core's pairing flow asks it to, removes the devices the core
// removes, changes motion sensors' settings, updates their firmware over the
// air and asks them how they are when someone asks. The manager runs
// Zigbee2MQTT and the broker as services for it (services:zigbee2mqtt); the
// app connects with the broker account the core hands it. Its UI is in ./ui,
// which the shell bundles.

export type { BridgeOptions } from "./bridge.js";

/** The app, with timings a test may shorten. */
export function createZigbeeApp(options: BridgeOptions = {}) {
  let bridge: Bridge | undefined;

  function running() {
    if (!bridge) {
      throw new Error("The Zigbee app is not running");
    }
    return bridge;
  }

  const status = defineAction({
    id: "zigbee.status",
    title: "Bridge status",
    tier: "read",
    input: z.object({}),
    output: z.object({
      broker: z.enum(["connecting", "connected", "disconnected"]),
      bridge: z.enum(["online", "offline", "unknown"]),
      joinUntil: z.string().nullable(),
    }),
    async run() {
      return running().status();
    },
  });

  return defineApp({
    id: "sanctum.zigbee",
    name: "Zigbee",
    // 0.2.0: letting devices join is the core's pairing flow, not an action.
    // 0.3.0: firmware updates over the air and Check connection.
    // 0.4.0: remotes' holds and releases, and moving lights while held.
    // 0.5.0: motion sensors, their light level and their settings.
    version: "0.5.0",
    core: "^1.0.0",
    summary:
      "Brings your Zigbee lights, plugs, remotes and sensors into your home.",
    icon: { glyph: "radio-tower", color: "graphite" },
    // The app overview opens main.
    pages: ["main"],
    permissions: [
      {
        id: "services:zigbee2mqtt",
        reason: "To reach your Zigbee devices through the stick.",
        needed: true,
      },
      {
        id: "devices.register",
        reason: "To add your Zigbee devices and keep their state.",
        needed: true,
      },
    ],
    actions: [status],
    events: [],
    // Returns once it has Zigbee2MQTT's device list, every device the core
    // will take registered and those here said, so a new version that can't
    // reach its devices isn't kept. Until then it says it's waiting for
    // Zigbee2MQTT, as the manager may still be starting it, and the core
    // tries again; it keeps nothing running from a start that didn't finish.
    async start(ctx) {
      const started = createBridge(ctx, options);
      bridge = started;
      try {
        await started.open().catch((error: unknown) => {
          ctx.log(
            `could not connect (${error instanceof Error ? error.message : String(error)})`,
          );
          throw new NotReady("Waiting for Zigbee2MQTT");
        });
        await started.listed();
      } catch (error) {
        if (bridge === started) bridge = undefined;
        await started.close();
        if (!isNotReady(error)) {
          ctx.log(
            `did not start (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        throw error;
      }
    },
    // Its broker session goes on; what the core missed meanwhile is said again.
    async resume() {
      await bridge?.resume();
    },
    async stop() {
      const stopping = bridge;
      bridge = undefined;
      await stopping?.close();
    },
    driver: {
      async command(_ctx, command) {
        await running().command(command);
      },
      async move(_ctx, move) {
        await running().move(move);
      },
      pairing: {
        async open(_ctx, { seconds }) {
          // Zigbee allows at most 254 seconds at a time.
          return running().permitJoin(Math.min(Math.max(seconds, 1), 254));
        },
        async close() {
          await running().permitJoin(0);
        },
      },
      async remove(_ctx, removal) {
        await running().remove(removal);
      },
      firmware: {
        check: async (_ctx, device) => running().checkFirmware(device),
        update: async (_ctx, device) => running().updateFirmware(device),
        stop: async (_ctx, device) => running().stopFirmware(device),
      },
      async probe(_ctx, device) {
        await running().probe(device);
      },
    },
  });
}

export default createZigbeeApp();
