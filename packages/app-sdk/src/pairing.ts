import { z } from "zod";

import { deviceKey } from "./devices.js";

// Adding and removing devices. Pairing is the core's flow, whatever the
// radio: someone lets new devices join for a while, the core asks every
// driver app that can pair to open its network, and each driver says how
// every device that joins is getting on until it is ready, which the shell
// shows as it happens. Removing a device goes through its driver too, which
// takes it off its network.

/**
 * How far a device that joins has come: it `joined`, its driver is
 * `interviewing` it to learn what it is, and then it is `ready` (the
 * driver has registered it), `unsupported` (the core has no capability for
 * what it does yet) or `failed` (it did not finish joining).
 */
export const joiningStages = [
  "joined",
  "interviewing",
  "ready",
  "unsupported",
  "failed",
] as const;
export type JoiningStage = (typeof joiningStages)[number];

/** What a driver says about a device joining its network (ctx.devices.joining). */
export const deviceJoining = z.strictObject({
  key: deviceKey,
  stage: z.enum(joiningStages),
  // What it is, once the driver knows, such as its model's name.
  description: z.string().trim().min(1).max(120).nullable().default(null),
});
export type DeviceJoining = z.input<typeof deviceJoining>;

/** A device that joined while new devices could, as clients see it. */
export type JoinedDevice = {
  /** The app that brings it, and that app's own key for it. */
  driver: string;
  key: string;
  stage: JoiningStage;
  description: string | null;
  /** The device in the core: from the start for one it had, else once it is ready. */
  deviceId: string | null;
  /** Whether the core had it before it joined, as when a device is reset and joins again, and still has it. */
  known: boolean;
  joinedAt: string;
};

/** Adding devices as clients see it (GET /api/devices/pairing). */
export type PairingInfo = {
  /** Until when new devices may join, while they may. */
  until: string | null;
  /** The devices that joined lately, in the order they joined. */
  joined: JoinedDevice[];
};

/** What the core asks of a driver app to remove one of its devices (driver.remove). */
export type DriverRemoval = {
  /** The device, by the driver's own key. */
  key: string;
  /** The device's id in the core. */
  device: string;
  /** Drop it from the driver's own records even if the device does not answer. */
  force: boolean;
};
