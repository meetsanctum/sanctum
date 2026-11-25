import type { Actor, CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";

import { ActionCallError } from "../app-host/errors.js";
import type { Deliver } from "./devices.js";
import type { DeviceReads } from "./reads.js";

export function announcementCapability(device: DeviceInfo | null) {
  return device?.capabilities.find(
    (capability): capability is Extract<CapabilityInfo, { kind: "audio" }> =>
      capability.kind === "audio" && capability.features.announces,
  );
}

// Only the core dispatches an announcement URL to its speaker's driver.
export function createAnnouncementDelivery(options: {
  load: (device: string) => DeviceInfo | null;
  reads: Pick<DeviceReads, "address">;
  deliver: Deliver;
  stopping: () => boolean;
}) {
  return async (
    deviceId: string,
    url: string,
    actor: Actor,
    fetched = false,
  ) => {
    if (options.stopping()) throw new ActionCallError("unavailable");
    const device = options.load(deviceId);
    const capability = announcementCapability(device);
    const address = device && options.reads.address(device.id);
    if (!device || !capability || !address)
      throw new ActionCallError("not_found");
    // Drivers that identify their announcement player can distinguish its
    // ordinary playback from an announcement after the speaker fetches it.
    if (fetched && !capability.features.announcementPlayer) return;
    await options.deliver(
      address.driver,
      {
        key: address.key,
        device: device.id,
        capability: capability.id,
        kind: "audio",
        command: fetched
          ? { announcementFetched: { url } }
          : { announce: { url } },
      },
      actor,
    );
  };
}
