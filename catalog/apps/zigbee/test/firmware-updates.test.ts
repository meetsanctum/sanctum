import type { AppContext, DeviceFirmware } from "@meetsanctum/app-sdk";
import { describe, expect, it, onTestFinished } from "vitest";

import type { ZigbeeDeviceEntry } from "../src/devices.js";
import { createFirmwareUpdates } from "../src/firmware-updates.js";
import type { BridgeResponse } from "../src/requests.js";

// Firmware updates on their own, with a core that can refuse what the
// driver says: how an update ends is followed whatever happened before.

const bulb = {
  key: "0x0017880104e45724",
  friendlyName: "Office light",
  battery: false,
  capabilities: [],
  registration: { firmware: { version: "1.126.9", updatable: true } },
} as unknown as ZigbeeDeviceEntry;

describe("an update over the air", () => {
  it("says how it ended even when the core missed that it started", async () => {
    const said: DeviceFirmware[] = [];
    let refuseNext = true;
    const ctx = {
      devices: {
        async firmware(firmware: DeviceFirmware) {
          if (refuseNext) {
            refuseNext = false;
            throw new Error("the core is restarting");
          }
          said.push(firmware);
        },
      },
      log() {},
    } as unknown as AppContext;
    let finish!: (response: BridgeResponse) => void;
    const answer = new Promise<BridgeResponse>((resolve) => {
      finish = resolve;
    });
    const updates = createFirmwareUpdates({
      ctx,
      devices: new Map([[bulb.key, bulb]]),
      send: async () => ({ answer }),
      isOnline: () => true,
      isClosed: () => false,
      checkMs: 1_000,
      updateMs: 1_000,
      progressEveryMs: 0,
    });
    onTestFinished(() => updates.close());

    await expect(
      updates.update({ key: bulb.key, device: "bulb" }),
    ).rejects.toThrow("the core is restarting");
    finish({ transaction: null, ok: true, error: "", data: {} });
    await new Promise((resolve) => setImmediate(resolve));

    expect(said).toEqual([
      expect.objectContaining({ key: bulb.key, state: "current" }),
    ]);
  });
});

describe("what a device's firmware is doing", () => {
  it("is said again when the core missed it, not taken as said", async () => {
    const said: DeviceFirmware[] = [];
    let refuseNext = true;
    const ctx = {
      devices: {
        async firmware(firmware: DeviceFirmware) {
          if (refuseNext) {
            refuseNext = false;
            throw new Error("the core is restarting");
          }
          said.push(firmware);
        },
      },
      log() {},
    } as unknown as AppContext;
    const updates = createFirmwareUpdates({
      ctx,
      devices: new Map([[bulb.key, bulb]]),
      send: async () => ({ answer: new Promise<BridgeResponse>(() => {}) }),
      isOnline: () => true,
      isClosed: () => false,
      checkMs: 1_000,
      updateMs: 1_000,
      progressEveryMs: 60_000,
    });
    onTestFinished(() => updates.close());
    const available = {
      state: "available",
      progress: null,
      remainingSeconds: null,
    } as const;

    await expect(updates.say(bulb, available)).rejects.toThrow(
      "the core is restarting",
    );
    await updates.say(bulb, available);
    // Said once it reached the core, the same news is not said again.
    await updates.say(bulb, available);

    expect(said).toEqual([
      expect.objectContaining({ key: bulb.key, state: "available" }),
    ]);
  });
});
