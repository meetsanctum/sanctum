import { z } from "zod";

import type {
  AttemptEnded,
  DeviceAsking,
  DriverAsked,
} from "./device-asking.js";
import {
  maxQuestions,
  problemId,
  type AddRefusal,
  type DeviceQuestion,
} from "./device-problems.js";
import { declaredTypes } from "./device-types.js";
import { deviceKey, type DeviceInfo } from "./devices.js";

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
  type: z.enum(declaredTypes).nullable().default(null),
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
  /**
   * What adding may ask once it has started, by id, in the order its driver
   * declares them (driver.addLater), so a client can show how far along
   * adding is before each step arrives.
   */
  later: string[];
  /** Why its driver may refuse adding it whatever it's asked, by id, in its words. */
  refusals: Record<string, string>;
};

/** What the core asks of a driver to add one of the devices it found (driver.add). */
export type DriverAdd = {
  /** The device, by the driver's own key. */
  key: string;
  /** An answer to each question adding it, or its last step, asks, by its id. */
  answers: Record<string, string>;
  /**
   * Which attempt this is, where adding may ask once it has started: a new
   * one means starting afresh, dropping whatever an earlier one left.
   */
  attempt?: string;
  /** The question whose time is up, when someone asks for it again, with no answers. */
  again?: string;
};

/**
 * Nothing once the driver has registered the device, the refusal it
 * declares: for the answer to one of the questions it asked, or for adding
 * it at all (driver.refusals), or what it asks next (device-asking.ts).
 */
export type DriverAddResult = void | { refused: AddRefusal } | DriverAsked;

/**
 * Where adding a found device got to (POST /api/devices/add): the device,
 * its driver's refusal, what it asks next, or why it ended without either.
 */
export type AddResult =
  { added: DeviceInfo } | { refused: AddRefusal } | DeviceAsking | AttemptEnded;
