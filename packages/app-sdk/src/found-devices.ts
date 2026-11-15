import { z } from "zod";

import {
  maxQuestions,
  problemId,
  type AddRefusal,
  type DeviceQuestion,
} from "./device-problems.js";
import { deviceKey, deviceTypeId, type DeviceInfo } from "./devices.js";

// Devices a driver could add, such as those it finds on the home's network
// (discovery.ts). It lists all of them at once (ctx.devices.found), each
// with which of its declared questions adding it asks, and Add devices shows
// them until someone adds one. Adding hands the answers to driver.add once,
// for one device at a time, and the driver registers the device as one that
// joins its network does. A device the home has is never listed, and adding
// it again gives that device back.

/** The most devices a driver lists as found. */
export const maxFound = 64;

/** One device a driver could add, as it lists it (ctx.devices.found). */
export const foundDevice = z.strictObject({
  /** The driver's own id for it, which it registers the device by once added. */
  key: deviceKey,
  /** What it calls itself, such as its name on the network. */
  name: z.string().trim().min(1).max(120),
  /**
   * What it has, or what adding it needs, in the driver's words, after the
   * app's name on its row: "temperature, humidity, motion".
   */
  description: z.string().trim().min(1).max(120).nullable().default(null),
  /** What it is, where the driver knows, by device type. */
  type: deviceTypeId.nullable().default(null),
  /** The questions adding it asks, by their ids among driver.questions. */
  asks: z
    .array(z.string().regex(problemId))
    .max(maxQuestions)
    .refine((asks) => new Set(asks).size === asks.length, "each question once")
    .default([]),
});
export type FoundReport = z.input<typeof foundDevice>;

/** Every device a driver could add, replacing what it listed before. */
export const foundDevices = z
  .array(foundDevice)
  .max(maxFound)
  .refine(
    (found) => new Set(found.map((each) => each.key)).size === found.length,
    "each device once",
  );

/** A device a driver could add, as clients see it in Add devices. */
export type FoundDevice = {
  /** The app that found it, and that app's own key for it. */
  driver: string;
  key: string;
  name: string;
  description: string | null;
  type: string | null;
  /** What adding it asks, in the words its driver declares. */
  asks: DeviceQuestion[];
  /** Why its driver may refuse adding it whatever it's asked, by id, in its words. */
  refusals: Record<string, string>;
};

/** What the core asks of a driver to add one of the devices it found (driver.add). */
export type DriverAdd = {
  /** The device, by the driver's own key. */
  key: string;
  /** An answer to each question adding it asks, by its id. */
  answers: Record<string, string>;
};

/**
 * Nothing once the driver has registered the device, or the refusal it
 * declares: for the answer to one of the questions it asked, or for adding
 * it at all (driver.refusals).
 */
export type DriverAddResult = void | { refused: AddRefusal };

/** How adding a found device ended (POST /api/devices/add): the device, or its driver's refusal. */
export type AddResult = { added: DeviceInfo } | { refused: AddRefusal };
