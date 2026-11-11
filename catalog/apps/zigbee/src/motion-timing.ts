import type { AppContext, OccupancyState } from "@meetsanctum/app-sdk";

import type { ZigbeeDeviceEntry } from "./devices.js";
import {
  detectionIntervalOf,
  isTimedByZigbee2mqtt,
  secondsOf,
  timedClearAfter,
  type OccupancyMapping,
  type TimedOccupancyMapping,
  type Timing,
} from "./occupancy.js";
import type { BridgeResponse } from "./requests.js";
import { isRecord } from "./values.js";

// How Zigbee2MQTT times the motion sensors it says no motion for, Aqara's
// (occupancy.ts), by key: each one's occupancy_timeout device option, from
// its configuration in bridge/info and the driver's requests to change it
// (bridge/request/device/options), and the detection_interval each says,
// for which it is blind after it sees motion. The option is Zigbee2MQTT's,
// not the sensor's, so no message of the sensor confirms it: the driver
// reports it with what the sensor last said, once the request succeeds or
// bridge/info has a new one.

/** What the timing needs of the bridge. */
export type TimingBridge = {
  ctx: AppContext;
  /** One of the devices the core has taken, by key. */
  device(key: string): ZigbeeDeviceEntry | undefined;
  request(
    name: "device/options",
    payload: Record<string, unknown>,
  ): Promise<BridgeResponse>;
  /**
   * Registers a device again now that its detection_interval is known,
   * resolving to the entry the driver has for it after.
   */
  registerAgain(key: string): Promise<ZigbeeDeviceEntry | undefined>;
};

// The occupancy of a sensor Zigbee2MQTT times.
function timedOccupancy(device: ZigbeeDeviceEntry | undefined) {
  return device?.capabilities.find(
    (each): each is TimedOccupancyMapping =>
      each.kind === "occupancy" && isTimedByZigbee2mqtt(each),
  );
}

export function createMotionTiming(bridge: TimingBridge) {
  const { ctx } = bridge;
  let timeouts = new Map<string, number>();
  const intervals = new Map<string, number>();
  // What the driver last reported of each one's occupancy, and the
  // sensors whose option it asked for and has yet to report.
  const occupancies = new Map<string, OccupancyState>();
  const asked = new Set<string>();

  const timingOf = (key: string): Timing => ({
    option: timeouts.get(key),
    detectionInterval: intervals.get(key),
  });

  // Reports how long Zigbee2MQTT now waits for a sensor, with the rest as
  // the sensor last said it, when that changed or `always`: the report
  // confirms an option asked for even when it changed nothing. Until the
  // sensor has said whether it sees motion there is nothing to report it
  // with, and its next message says it.
  async function report(key: string, always = false) {
    const capability = timedOccupancy(bridge.device(key));
    const last = occupancies.get(key);
    if (!capability || !last) {
      return;
    }
    const state: OccupancyState = { ...last };
    const clearAfter = timedClearAfter(capability.clearAfter, timingOf(key));
    if (clearAfter === undefined) {
      delete state.clearAfter;
    } else {
      state.clearAfter = clearAfter;
    }
    if (!always && state.clearAfter === last.clearAfter) {
      return;
    }
    occupancies.set(key, state);
    asked.delete(key);
    await ctx.devices.report({ key, states: { [capability.id]: state } });
  }

  return {
    /** Each sensor's detection_interval, for its registration. */
    intervals: intervals as ReadonlyMap<string, number>,

    /** How long Zigbee2MQTT waits for a sensor, as far as it is known. */
    timingOf,

    /**
     * A device's message: a sensor that says a new detection_interval is
     * blind for that long, so its shortest wait is registered anew.
     * Resolves to the entry the driver has for the device.
     */
    async said(device: ZigbeeDeviceEntry, payload: Record<string, unknown>) {
      const seconds = detectionIntervalOf(payload);
      if (
        !timedOccupancy(device) ||
        seconds === null ||
        intervals.get(device.key) === seconds
      ) {
        return device;
      }
      intervals.set(device.key, seconds);
      return (await bridge.registerAgain(device.key)) ?? device;
    },

    /** What the driver reported of a device's occupancy. */
    reported(key: string, capability: OccupancyMapping, state: OccupancyState) {
      if (isTimedByZigbee2mqtt(capability)) {
        occupancies.set(key, state);
      }
    },

    /**
     * Zigbee2MQTT's configuration from bridge/info, which names devices by
     * IEEE address: each one's option, and a sensor whose option changed
     * reports it. An info without it says nothing of the options.
     */
    async configured(config: unknown) {
      if (!isRecord(config) || !isRecord(config.devices)) {
        return;
      }
      const said = new Map<string, number>();
      for (const [key, options] of Object.entries(config.devices)) {
        const seconds = isRecord(options)
          ? secondsOf(options.occupancy_timeout)
          : null;
        if (seconds !== null) {
          said.set(key, seconds);
        }
      }
      const changed = [...new Set([...timeouts.keys(), ...said.keys()])].filter(
        (key) => timeouts.get(key) !== said.get(key),
      );
      timeouts = said;
      for (const key of changed) {
        await report(key);
      }
    },

    /**
     * Has Zigbee2MQTT wait `seconds` before it says no motion for a
     * sensor, and reports that once it has taken the option, unless its
     * configuration on bridge/info, which it publishes first, already has.
     */
    async set(device: ZigbeeDeviceEntry, seconds: number) {
      asked.add(device.key);
      try {
        const { data } = await bridge.request("device/options", {
          id: device.key,
          options: { occupancy_timeout: seconds },
        });
        const to = isRecord(data.to)
          ? secondsOf(data.to.occupancy_timeout)
          : null;
        timeouts.set(device.key, to ?? seconds);
        if (asked.has(device.key)) {
          await report(device.key, true);
        }
      } finally {
        asked.delete(device.key);
      }
    },

    /** Forgets a device Zigbee2MQTT no longer has, but not its option. */
    forget(key: string) {
      intervals.delete(key);
      occupancies.delete(key);
    },
  };
}
