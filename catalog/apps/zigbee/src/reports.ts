import type { AppContext } from "@meetsanctum/app-sdk";

import type { ZigbeeDeviceEntry } from "./devices.js";
import { firmwareOf } from "./firmware.js";
import type { createFirmwareUpdates } from "./firmware-updates.js";
import type { createMotionTiming } from "./motion-timing.js";
import { occupancyState } from "./occupancy.js";
import type { createHolds, Heard } from "./presses.js";
import { batteryOf, sensorState } from "./sensors.js";
import { stateFromPayload } from "./states.js";
import { isRecord, parseJson } from "./values.js";

// What a device's live message tells the core: its state and availability,
// its button presses and releases, and its firmware.
export function createDeviceReporter({
  ctx,
  timing,
  holds,
  firmware,
}: {
  ctx: AppContext;
  timing: ReturnType<typeof createMotionTiming>;
  holds: ReturnType<typeof createHolds>;
  firmware: ReturnType<typeof createFirmwareUpdates>;
}) {
  return async (found: ZigbeeDeviceEntry, payload: Buffer) => {
    const raw = parseJson(payload);
    if (!isRecord(raw)) {
      return;
    }
    const device = await timing.said(found, raw);
    const states: Record<string, unknown> = {};
    const heard: { capability: string; heard: NonNullable<Heard> }[] = [];
    for (const capability of device.capabilities) {
      if (capability.kind === "button") {
        const said = holds.heard(device.key, capability, raw);
        if (said) heard.push({ capability: capability.id, heard: said });
        continue;
      }
      if (capability.kind === "occupancy") {
        const state = occupancyState(
          capability,
          raw,
          timing.timingOf(device.key),
        );
        if (state) {
          states[capability.id] = state;
          timing.reported(device.key, capability, state);
        }
        continue;
      }
      const state =
        capability.kind === "sensor"
          ? sensorState(capability, raw)
          : stateFromPayload(capability, raw);
      if (state) {
        states[capability.id] = state;
      }
    }
    // A message from the device means it answers. A battery-powered one
    // says its charge with its state.
    const battery = batteryOf(raw);
    await ctx.devices.report({
      key: device.key,
      availability: "online",
      states,
      ...(battery === undefined ? {} : { battery }),
    });
    // Each press is said once: Zigbee2MQTT never keeps a device's action
    // in the state it publishes again, and retained messages never get here.
    // A release says the button was let go.
    for (const { capability, heard: said } of heard) {
      await ("press" in said
        ? ctx.devices.press({ key: device.key, capability, action: said.press })
        : ctx.devices.release({ key: device.key, capability }));
    }
    // Zigbee2MQTT publishes what it knows of the firmware with every state.
    const said = firmwareOf(raw.update);
    if (said) {
      await firmware.say(device, said);
    }
  };
}
