import {
  defineApp,
  defineDevicePage,
  discoverPermission,
  lanPermission,
} from "@meetsanctum/app-sdk";
import { createDriver, type Driver, type DriverOptions } from "./driver.js";
import type { SpeakerChange } from "./speaker.js";
import { changeRingAction, deviceAction, speakerAction } from "./page.js";
import { esphomeService } from "./sightings.js";

// The ESPHome driver app: brings the lights, switches, sensors, motion and
// contact sensors, buttons and media players of ESPHome's devices on the
// home's network
// into the core's Devices, over ESPHome's native API, one connection to
// each device. The manager finds them on mDNS and lets the app reach the
// devices it found, on the API's port, and nothing else. A device with an
// encryption key is added with it, and never talked to without it; one
// waiting for a key gets one of its own, and older firmware that takes a
// first key only in the clear gets a setup key that way, then its own
// encrypted. Removing a device takes a key Sanctum gave off it. Its UI, a
// page in each of its devices' detail, is in ./ui.

export type { DriverOptions } from "./driver.js";

/** The app, with timings a test may shorten. */
export function createEsphomeApp(options: DriverOptions = {}) {
  let driver: Driver | undefined;

  function running() {
    if (!driver) throw new Error("The ESPHome app is not running");
    return driver;
  }

  const device = deviceAction((deviceId) => running().page(deviceId));
  const speaker = speakerAction((deviceId) => running().speaker(deviceId));
  const changeSpeaker = (deviceId: string, change: SpeakerChange) =>
    running().changeSpeaker(deviceId, change);
  const changeRing = changeRingAction(changeSpeaker);

  return defineApp({
    id: "sanctum.esphome",
    name: "ESPHome",
    // 0.2.0: a device waiting for a key gets one of its own, and removing
    // it takes the key off. 0.3.1: a device's maker and product come from
    // its project's name, and one waiting for a key is listed by its maker.
    // 0.5.0: older firmware gets a setup key, then its own; a device left
    // without encryption, or that lost the key it was given, is repaired.
    // 0.6.0: media players, and smart speakers, whose voice requests are
    // followed and declined. 0.7.0: a smart speaker's microphones, ring and
    // wake word on its page. 0.8.0: an action for each change there, about
    // the speaker, so Activity names it. 0.8.1: a speaker announcing is
    // doing what it did before, not playing. 0.9.0: a smart speaker's
    // microphones are its `audio` part, which the shell shows, and leave
    // its page. 0.9.1: an unmute its side switch holds is refused at once.
    // 0.10.0: a smart speaker plays the core's announcements, and its
    // playing them isn't the player's own. 0.11.0: a smart speaker that
    // streams its microphone listens: its requests go to the core, which
    // takes or declines each, and the driver shows the core's steps on it.
    // 0.11.1: a run closes once the speaker's player has played its reply.
    version: "0.11.1",
    core: "^2.0.0",
    summary:
      "Brings your ESPHome lights, plugs, sensors, buttons and speakers into your home.",
    icon: { glyph: "cpu", color: "graphite" },
    // ESPHome's blue.
    backdrop: { from: "#0A5C7A", to: "#18BCF2" },
    permissions: [
      {
        id: "devices.register",
        reason: "To add your ESPHome devices and show what they're doing.",
        needed: true,
      },
      {
        id: discoverPermission(esphomeService),
        reason: "To find your ESPHome devices.",
        needed: true,
      },
      {
        id: lanPermission(6053),
        reason: "To control them and read their sensors.",
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
    actions: [device, speaker, changeRing],
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
        notEncrypted: {
          words: "It isn't encrypted",
          repair: {
            help: "Give it a setup key without encryption, then its own key encrypted.",
            asks: [],
          },
        },
        keyLost: {
          words: "It lost its key, as when it's reset",
          repair: {
            help: "Give it a new key, as when it was added.",
            asks: [],
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
        hasKey:
          "It has an encryption key already. Enter it, or remove it from the app that gave it one, then add it here.",
        changed:
          "It answered differently from before. Check what it says now, then add it.",
      },
    },
  });
}

export default createEsphomeApp();
