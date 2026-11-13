import { knownParts, type DeviceInfo } from "@meetsanctum/app-sdk";

import { coreJson, type CoreFetchInit } from "./core-fetch";

// Devices as the shell takes them from the core: each with the parts this
// build knows. A core newer than the client may serve capabilities of a kind
// it has no tile, words or history for, and those parts are skipped wherever
// a device arrives.

/** The home's devices. */
export const coreDevices = async () =>
  (await coreJson<DeviceInfo[]>("/api/devices")).map(knownParts);

/** The device a route answers with, such as the one it has just changed. */
export const coreDevice = async (path: string, init: CoreFetchInit) =>
  knownParts(await coreJson<DeviceInfo>(path, init));
