import { z } from "zod";

import { deviceKey } from "./devices.js";

// Firmware updates and checking a device: the same whatever the radio. A
// driver says what each of its devices runs and whether it can be updated
// when it registers it, and what an update is doing as it learns it; the
// core keeps that with the device and hands the driver a client's check,
// update or stop. Nothing starts an update but a person or a shared client:
// never a workflow or an app.

/**
 * What a device's firmware is doing: `current` (no update is known),
 * `available`, `waiting` (to start once a sleeping device wakes),
 * `updating`, or `failed` (the last update did not finish; the device
 * runs what it ran before, and the update is still available).
 */
export const firmwareStates = [
  "current",
  "available",
  "waiting",
  "updating",
  "failed",
] as const;
export type FirmwareState = (typeof firmwareStates)[number];

/** What a driver says about one of its devices' firmware (ctx.devices.firmware). */
export const deviceFirmware = z
  .strictObject({
    key: deviceKey,
    state: z.enum(firmwareStates),
    // While it updates: how far it has come, in percent, and about how long
    // it has left.
    progress: z.number().min(0).max(100).nullable().default(null),
    remainingSeconds: z.number().int().min(0).nullable().default(null),
    // Why the last update failed, in words for people.
    problem: z.string().trim().min(1).max(300).nullable().default(null),
  })
  .refine(
    (report) =>
      report.state === "updating" ||
      (report.progress === null && report.remainingSeconds === null),
    "only an update under way has progress",
  );
export type DeviceFirmware = z.input<typeof deviceFirmware>;

/** A device's firmware as clients and apps see it (DeviceInfo.firmware). */
export type FirmwareInfo = {
  /** What it runs, as its maker numbers it, when its driver knows. */
  version: string | null;
  /** Whether its driver can update it. */
  updatable: boolean;
  /** Whether it sleeps, so an update waits for it to wake. */
  sleeps: boolean;
  /** What an update is doing, once its driver has said. */
  state: FirmwareState | null;
  progress: number | null;
  remainingSeconds: number | null;
  problem: string | null;
  /** When the core last learned whether an update is available. */
  checkedAt: string | null;
  /** When the update under way, or the last one, started and ended. */
  startedAt: string | null;
  endedAt: string | null;
};

/** One of a driver's devices, as the core names it in a firmware or probe call. */
export type DriverDevice = {
  /** The device, by the driver's own key. */
  key: string;
  /** The device's id in the core. */
  device: string;
};

/** What Check connection found: how long the device took to answer, or null when it did not. */
export type ProbeResult = { answeredInMs: number | null };

/** How long the core waits for a device to answer Check connection. */
export const probeWaitMs = 10_000;
