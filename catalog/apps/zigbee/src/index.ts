import { defineAction, defineApp } from "@meetsanctum/app-sdk";
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
    // Connects in the background: the manager may take a while to run the
    // services, and start should not wait for it.
    async start(ctx) {
      const started = createBridge(ctx, options);
      bridge = started;
      started.open().catch((error: unknown) => {
        ctx.log(
          `could not connect (${error instanceof Error ? error.message : String(error)})`,
        );
      });
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
