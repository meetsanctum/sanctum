import type { Actor, AudioFeatures, DeviceInfo } from "@meetsanctum/app-sdk";

import { ActionCallError } from "../app-host/errors.js";
import type { Deliver } from "./devices.js";
import type { DeviceReads } from "./reads.js";

// Only the core dispatches an announcement URL to its speaker's driver.
export function createAnnouncementDelivery(options: {
  load: (device: string) => DeviceInfo | null;
  reads: Pick<DeviceReads, "address">;
  deliver: Deliver;
  stopping: () => boolean;
}) {
  return async (deviceId: string, url: string, actor: Actor) => {
    if (options.stopping()) throw new ActionCallError("unavailable");
    const device = options.load(deviceId);
    const capability = device?.capabilities.find(
      (each) =>
        each.kind === "audio" && (each.features as AudioFeatures).announces,
    );
    const address = device && options.reads.address(device.id);
    if (!device || !capability || !address)
      throw new ActionCallError("not_found");
    await options.deliver(
      address.driver,
      {
        key: address.key,
        device: device.id,
        capability: capability.id,
        kind: "audio",
        command: { announce: { url } },
      },
      actor,
    );
  };
}
