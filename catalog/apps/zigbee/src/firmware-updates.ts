import {
  ActionError,
  type AppContext,
  type DriverDevice,
} from "@meetsanctum/app-sdk";

import type { ZigbeeDeviceEntry } from "./devices.js";
import { isWorthSaying, problemOf, type FirmwareSaid } from "./firmware.js";
import type { BridgeResponse } from "./requests.js";

// Firmware updates over the air through Zigbee2MQTT, for the bridge: it
// tells the core what each device's firmware is doing when that is news, and
// checks for, starts and stops updates with Zigbee2MQTT's
// bridge/request/device/ota_update/* requests. A device that sleeps updates
// the next time it wakes and asks for an image.

/** The requests firmware updates make of Zigbee2MQTT's bridge. */
export const firmwareRequests = [
  "device/ota_update/check",
  "device/ota_update/update",
  "device/ota_update/update/abort",
  "device/ota_update/schedule",
  "device/ota_update/unschedule",
] as const;
type FirmwareRequest = (typeof firmwareRequests)[number];

type Send = (
  name: FirmwareRequest,
  payload: Record<string, unknown>,
  ms?: number,
) => Promise<{ answer: Promise<BridgeResponse> }>;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createFirmwareUpdates(options: {
  ctx: AppContext;
  // The devices the core has taken, by key.
  devices: ReadonlyMap<string, ZigbeeDeviceEntry>;
  send: Send;
  // Whether Zigbee2MQTT and the broker are there now, and whether the
  // bridge has closed.
  isOnline: () => boolean;
  isClosed: () => boolean;
  checkMs: number;
  updateMs: number;
  progressEveryMs?: number;
  heartbeatMs?: number;
}) {
  const { ctx, devices, checkMs, updateMs } = options;
  const request = async (
    name: FirmwareRequest,
    payload: Record<string, unknown>,
    ms?: number,
  ) => (await options.send(name, payload, ms)).answer;
  // What the driver last told the core of each device's firmware, and the
  // updates someone stopped, whose failure is no news.
  const firmwareSaid = new Map<string, FirmwareSaid & { at: number }>();
  const stopping = new Set<string>();
  const updates = new Map<string, symbol>();
  // While Zigbee2MQTT is online, an update it is carrying out is under way
  // until it says otherwise: a device may hold a percent, or check the new
  // firmware at the end, for minutes. Zigbee2MQTT itself ends an update
  // whose device stops asking for blocks (150 seconds) and says so with the
  // device's state, so only a driver or Zigbee2MQTT that is gone leaves the
  // core's ten minutes to end it.
  const heartbeat = setInterval(() => {
    if (options.isClosed() || !options.isOnline()) return;
    for (const [key, said] of firmwareSaid) {
      if (said.state !== "updating") continue;
      ctx.devices
        .firmware({
          key,
          state: "updating",
          progress: said.progress,
          remainingSeconds: said.remainingSeconds,
        })
        .catch((error: unknown) => {
          ctx.log(
            `could not say ${key} is still updating (${messageOf(error)})`,
          );
        });
    }
  }, options.heartbeatMs ?? 120_000);
  heartbeat.unref?.();

  // Tells the core what a device's firmware is doing, when that is news.
  async function say(
    device: ZigbeeDeviceEntry,
    said: FirmwareSaid,
    problem?: string,
  ) {
    if (!device.registration.firmware?.updatable || options.isClosed()) {
      return;
    }
    const at = Date.now();
    const last = firmwareSaid.get(device.key);
    if (!problem && !isWorthSaying(last, said, at, options.progressEveryMs)) {
      return;
    }
    const saying = { ...said, at };
    firmwareSaid.set(device.key, saying);
    try {
      await ctx.devices.firmware({
        key: device.key,
        ...said,
        ...(problem ? { problem } : {}),
      });
    } catch (error) {
      // What the core never heard is not said: the next status says it
      // again, unless a newer one has been said since.
      if (firmwareSaid.get(device.key) === saying) {
        if (last) firmwareSaid.set(device.key, last);
        else firmwareSaid.delete(device.key);
      }
      throw error;
    }
  }

  // One of the driver's devices that Zigbee2MQTT can update.
  function updatable(key: string) {
    const device = devices.get(key);
    if (!device) {
      throw new ActionError("not_found", `No Zigbee device ${key}`);
    }
    if (!device.registration.firmware?.updatable) {
      throw new ActionError(
        "conflict",
        `${device.friendlyName} cannot be updated over the air`,
      );
    }
    return device;
  }

  return {
    say,

    /** Forgets a device that left, so an update of it is no news. */
    forget(key: string) {
      firmwareSaid.delete(key);
      stopping.delete(key);
      updates.delete(key);
    },

    /**
     * Asks Zigbee2MQTT whether an update is out for a device, by its IEEE
     * address, and tells the core. The device has to answer, so a sleeping
     * one only answers when it is awake.
     */
    async check({ key }: DriverDevice) {
      const device = updatable(key);
      const { data } = await request(
        "device/ota_update/check",
        { id: key },
        checkMs,
      );
      if (typeof data.update_available === "boolean") {
        await say(device, {
          state: data.update_available ? "available" : "current",
          progress: null,
          remainingSeconds: null,
        });
      }
    },

    /**
     * Starts an update over the air, resolving once it is on its way. A
     * device that sleeps updates the next time it wakes and asks for an
     * image. Zigbee2MQTT answers an update only once it has ended; its
     * progress comes with the device's state meanwhile.
     */
    async update({ key }: DriverDevice) {
      const device = updatable(key);
      const waiting = { progress: null, remainingSeconds: null };
      if (device.battery) {
        await request("device/ota_update/schedule", { id: key });
        await say(device, { state: "waiting", ...waiting });
        return;
      }
      stopping.delete(key);
      const { answer } = await options.send(
        "device/ota_update/update",
        { id: key },
        updateMs,
      );
      const attempt = Symbol();
      updates.set(key, attempt);
      // How the update ends is followed even if saying it started fails.
      const saying = say(device, {
        state: "updating",
        ...waiting,
        progress: 0,
      });
      answer
        .then(
          async () => {
            if (updates.get(key) !== attempt || stopping.has(key)) return;
            await say(devices.get(key) ?? device, {
              state: "current",
              ...waiting,
            });
          },
          async (error: unknown) => {
            if (
              updates.get(key) !== attempt ||
              stopping.delete(key) ||
              options.isClosed()
            )
              return;
            ctx.log(
              `could not update ${device.friendlyName} (${messageOf(error)})`,
            );
            await say(
              devices.get(key) ?? device,
              { state: "failed", ...waiting },
              problemOf(messageOf(error)),
            );
          },
        )
        .finally(() => {
          if (updates.get(key) === attempt) updates.delete(key);
        })
        .catch((error: unknown) => {
          ctx.log(
            `could not say how ${device.friendlyName}'s update ended (${messageOf(error)})`,
          );
        });
      await saying;
    },

    /** Stops an update under way, or one waiting for the device to wake. */
    async stop({ key }: DriverDevice) {
      const device = updatable(key);
      const available = {
        state: "available",
        progress: null,
        remainingSeconds: null,
      } as const;
      if (firmwareSaid.get(key)?.state === "waiting") {
        await request("device/ota_update/unschedule", { id: key });
        await say(device, available);
        return;
      }
      stopping.add(key);
      try {
        await request("device/ota_update/update/abort", { id: key });
      } catch (error) {
        stopping.delete(key);
        // After a restart the driver may not know a sleeping device's update
        // is only scheduled: then nothing is under way, and it is unscheduled.
        if (!device.battery || !/no ota in progress/i.test(messageOf(error))) {
          throw error;
        }
      }
      // Aborting a scheduled OTA leaves its next-wake retry scheduled.
      if (device.battery) {
        await request("device/ota_update/unschedule", { id: key });
      }
      await say(device, available);
    },

    close() {
      clearInterval(heartbeat);
    },
  };
}
