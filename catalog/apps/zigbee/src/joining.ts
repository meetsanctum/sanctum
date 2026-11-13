import type { JoiningStage } from "@meetsanctum/app-sdk";

import { descriptionOf, isInterviewed } from "./devices.js";
import type { ZigbeeDevice } from "./types.js";
import { isRecord, stringValue } from "./values.js";

// Devices joining the network, for the core's pairing flow: Zigbee2MQTT says
// on bridge/event that a device joined and how its interview goes, and its
// device list then has it. Once the list has a device whose interview
// succeeded, the driver has registered it (ready), with no capabilities
// when it exposes nothing the core has one for. A device the core would not
// take is said to be one it cannot use (unsupported).

export type SayJoining = (
  key: string,
  stage: JoiningStage,
  description: string | null,
) => Promise<void>;

export function createJoining(say: SayJoining) {
  // The devices being followed, by key, until they are ready, cannot be
  // used, fail or leave.
  const following = new Set<string>();
  let latest = new Map<string, { device: ZigbeeDevice; isTaken: boolean }>();

  async function finish(key: string) {
    const entry = latest.get(key);
    if (!entry || !following.has(key) || !isInterviewed(entry.device)) return;
    following.delete(key);
    await say(
      key,
      entry.isTaken ? "ready" : "unsupported",
      descriptionOf(entry.device),
    );
  }

  return {
    /** One of Zigbee2MQTT's bridge events. */
    async event(type: unknown, data: Record<string, unknown>) {
      const key = stringValue(data.ieee_address);
      if (!key) {
        return;
      }
      const description = isRecord(data.definition)
        ? descriptionOf({ definition: data.definition })
        : null;
      if (type === "device_joined") {
        following.add(key);
        await say(key, "joined", null);
        await finish(key);
      } else if (type === "device_leave") {
        following.delete(key);
      } else if (type === "device_interview") {
        const status = stringValue(data.status)?.toLowerCase();
        if (status === "started") {
          following.add(key);
          await say(key, "interviewing", description);
        } else if (status === "failed" && following.delete(key)) {
          await say(key, "failed", description);
        } else if (status === "successful") {
          await finish(key);
        }
        // Zigbee2MQTT publishes the list before the event. The queue may
        // also coalesce lists, so either arrival order must finish it.
      }
    },

    /**
     * Zigbee2MQTT's latest list, once the driver has taken what it can
     * from it: `taken` says whether it registered a device.
     */
    async listed(devices: ZigbeeDevice[], taken: (key: string) => boolean) {
      latest = new Map();
      for (const device of devices) {
        const key = stringValue(device.ieee_address);
        if (!key) continue;
        latest.set(key, { device, isTaken: taken(key) });
        await finish(key);
      }
    },
  };
}
