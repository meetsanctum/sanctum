import {
  defineApp,
  discoverPermission,
  lanPermission,
  lanRangePermission,
  lanRangePorts,
} from "@meetsanctum/app-sdk";

import { createDriver, type Driver, type DriverOptions } from "./driver.js";
import { airplayCode, companionCode } from "./pairing.js";
import { airplayService, companionService } from "./sightings.js";

// The Apple Home Devices driver app: brings Apple TVs into the core's
// Devices as media players, showing what they play and taking playback,
// power and volume. It finds them by what they announce, AirPlay and
// Companion, and adds one with the two codes the TV shows, one after the
// other: AirPlay's, then Companion's, which the TV keeps for about 35
// seconds. It keeps a Companion connection to each for power and volume
// steps, and while the TV is awake a player connection, MRP over AirPlay,
// for what plays. HomePods are listed, but can't be added, since they have
// no screen to show a code on.

export type { DriverOptions } from "./driver.js";

// AirPlay's port, where pairing starts; Companion's and the other
// connections a TV hands out lie in the range of ports for a session.
const airplayPort = 7000;

const code = (label: string) => ({
  label,
  kind: "code" as const,
  length: 4,
  refusals: { wrongCode: "That code didn't match." },
});

/** The app, with what a test may stand in. */
export function createAppleHomeDevicesApp(options: DriverOptions = {}) {
  let driver: Driver | undefined;

  function running() {
    if (!driver) throw new Error("The Apple Home Devices app is not running");
    return driver;
  }

  return defineApp({
    id: "sanctum.apple-home-devices",
    name: "Apple Home Devices",
    version: "0.2.1",
    core: "^2.0.0",
    summary: "Brings your Apple TVs into your home, with what they play.",
    icon: { glyph: "tv", color: "graphite" },
    // Amber, as Apple's Home app.
    backdrop: { from: "#B45309", to: "#FFB340" },
    permissions: [
      {
        id: "devices.register",
        reason: "To add your Apple TVs and show what they play.",
        needed: true,
      },
      {
        id: discoverPermission(airplayService),
        reason: "To find your Apple TVs and HomePods.",
        needed: true,
      },
      {
        id: discoverPermission(companionService),
        reason: "To find your Apple TVs and HomePods.",
        needed: true,
      },
      {
        id: lanPermission(airplayPort),
        reason:
          "To pair with your Apple TVs, control them and see what they play.",
        needed: true,
      },
      {
        id: lanRangePermission(lanRangePorts.from, lanRangePorts.to),
        reason:
          "To pair with your Apple TVs, control them and see what they play.",
        needed: true,
      },
    ],
    actions: [],
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
      async discovered(_ctx, discovery) {
        await running().discovered(discovery);
      },
      async add(_ctx, add) {
        return running().add(add);
      },
      async cancelAdd(_ctx, cancel) {
        await running().cancelAdd(cancel);
      },
      async repair(_ctx, repair) {
        return running().repair(repair);
      },
      async cancelRepair(_ctx, cancel) {
        await running().cancelRepair(cancel);
      },
      async remove(_ctx, removal) {
        await running().remove(removal);
      },
      questions: {
        [airplayCode]: {
          ...code("Code on the TV (1 of 2)"),
          help: "The TV shows a four-digit code.",
        },
        [companionCode]: {
          ...code("Code on the TV (2 of 2)"),
          help: "A new code is on the TV.",
          lasts: { seconds: 35, again: "Show a new code" },
          refusals: {
            wrongCode: "That code didn't match.",
            expired: "That code had expired. Enter the new one on the TV.",
          },
        },
      },
      addLater: [airplayCode, companionCode],
      refusals: {
        notAllowed:
          "The TV didn't let Sanctum pair. On the TV, open Settings, then AirPlay and HomeKit, and allow access to everyone on the same network.",
        unreachable:
          "Sanctum can't reach the TV. Check that it's plugged in and on the same network, then add it again.",
        homePod: "HomePods are not yet supported by Sanctum.",
      },
      problems: {
        pairingLost: {
          words: "It's no longer paired with Sanctum",
          repair: {
            help: "Pair it again. The TV shows two codes, one after the other.",
            asks: [],
            later: [airplayCode, companionCode],
          },
        },
      },
    },
  });
}

export default createAppleHomeDevicesApp();
