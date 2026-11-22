import { ConnectionClosedByPeerError } from "esphome-client";
import type { DeviceInfo } from "esphome-client";
import { randomBytes } from "node:crypto";

import {
  connectOnce,
  type Address,
  type Session,
  type Timings,
} from "./connection.js";
import { beforeProvisioning, type Announced } from "./sightings.js";

// Keys Sanctum gives. A device built to be given its key later waits for
// one, taking connections encrypted with a key of all zeros: that keeps
// listeners out, though it authenticates nobody. Sanctum gives it 32 random
// bytes of its own over such a connection, keeping the key before sending
// it, and adds the device once it's back under that key. Firmware from
// before ESPHome 2026.7 can't wait for a key: it takes a first one only in
// the clear, so it gets a throwaway setup key that way, then at once its own
// over the connection the setup key encrypts, so its own key never crosses
// the network in the clear. Nothing here proves a device is the household's:
// a MAC, or coming back under a key just sent, says only that whoever
// answers holds that key. Removing the device takes the key off again. A
// key a device was flashed with is never touched.

/** The key a device waiting for one takes connections under. */
export const zeroKey = Buffer.alloc(32).toString("base64");

/** A device's key's name among the app's secrets. */
export const secretOf = (mac: string) => `key:${mac}`;

/** The marker for a key Sanctum gave and whether it used a setup key. */
export const givenOf = (mac: string) => `given:${mac}`;

/**
 * The name of the secret that holds the setup key sent to older firmware in
 * the clear, kept only until the device has its own.
 */
export const setupOf = (mac: string) => `setup:${mac}`;

/** A key of a device's own, as ESPHome's dashboard makes one. */
export const newKey = () => randomBytes(32).toString("base64");

/**
 * That a device ended a connection under the zero key as its window to be
 * given a key closed, saying so (DISCONNECT_REASON_PROVISIONING_CLOSED). One
 * that parts for no reason, as while it applies a key or shuts down, may
 * still wait.
 */
function stoppedWaiting(error: unknown) {
  return (
    error instanceof ConnectionClosedByPeerError &&
    error.code === "PEER_DISCONNECT_PROVISIONING_CLOSED"
  );
}

/**
 * What a device says of its key under the zero key: it waits for one, with
 * what it says of itself; it has one; its window to be given one closed; it
 * answers only in the clear, with what it says of itself there; or nothing
 * that can be acted on, as when it's busy, restarting or out of reach.
 */
type ProbeAnswer =
  | { says: "waits"; info: Session["info"]; session?: Session }
  | { says: "key"; tookZeroKey?: true }
  | { says: "closed" }
  | { says: "clear"; info: Session["info"]; session?: Session }
  | { says: "unclear" };

export type Answer = ProbeAnswer | { says: "older"; session?: Session };

function reportsOlderFirmware(info: DeviceInfo) {
  return (
    info.apiEncryptionSupported === true &&
    info.apiEncryptionProvisionable !== true &&
    beforeProvisioning(info.esphomeVersion) === true
  );
}

/**
 * Whether a device is firmware from before ESPHome 2026.7 that takes a
 * first key only in the clear, every sign agreeing: its record says it
 * supports encryption with no way to wait for a key, and in the clear it
 * says the same, with a version from before 2026.7. A device that ever took
 * the zero key, or said it could, never is. Anything less is taken as a
 * device too busy to say, as a 2026.7 device with its connections full is
 * answered in the clear too: then nothing is sent.
 */
export function isOlderFirmware(
  record: Announced,
  info: DeviceInfo,
  tookZeroKey: boolean,
) {
  return (
    record.encryption === "older" &&
    !tookZeroKey &&
    reportsOlderFirmware(info) &&
    beforeProvisioning(record.version) !== false
  );
}

/**
 * Asks a device what it says of its key, over one connection under the zero
 * key, which carries nothing secret whatever answers. A device with a key
 * refuses the zero key's handshake. One built without Noise, or older
 * firmware, ends it, and the library then greets it in the clear; but so
 * does a device that is busy or restarting, so an answer in the clear says
 * only what the device said of itself there.
 */
export async function askUnderZeroKey(reach: {
  mac: string;
  address: Address;
  timings: Timings;
  signal?: AbortSignal;
  keepSession?: boolean;
  keepClearSession?: boolean;
}): Promise<ProbeAnswer> {
  const { keepSession, ...target } = reach;
  const result = await connectOnce({ ...target, key: zeroKey });
  if ("session" in result) {
    const { session } = result;
    const { info } = session;
    if (info.apiEncryptionProvisionable !== true) {
      session.client.disconnect();
      return { says: "key", tookZeroKey: true };
    }
    if (keepSession) return { says: "waits", info, session };
    session.client.disconnect();
    return { says: "waits", info };
  }
  if ("halt" in result) {
    return result.clear
      ? { says: "clear", info: result.clear, session: result.clearSession }
      : { says: "key" };
  }
  return stoppedWaiting(result.error)
    ? { says: "closed" }
    : { says: "unclear" };
}

type Reach = { mac: string; address: () => Address | null; timings: Timings };

function addressOf(reach: Reach) {
  const address = reach.address();
  if (!address) throw new Error("It isn't on the home's network");
  return address;
}

// Connects with a key until the device takes it, as it does once it has
// applied a key it was given, which ends its connections.
async function backWith(reach: Reach, key: string) {
  for (let tries = 0; tries < 10; tries += 1) {
    const result = await connectOnce({
      mac: reach.mac,
      key,
      address: addressOf(reach),
      timings: reach.timings,
    });
    if ("session" in result) return result.session;
    await new Promise((done) => setTimeout(done, reach.timings.firstPauseMs));
  }
  throw new Error("It didn't come back with its key");
}

/**
 * Gives a device a key over a session: its own over one under the zero key
 * or under its setup key, or older firmware its setup key over one in the
 * clear. `keep` saves the key first so a lost answer can be retried with
 * it. Returns a checked session under the new key.
 */
export async function giveKey(
  reach: Reach & {
    session: Session;
    key: string;
    keep: (key: string) => Promise<void>;
  },
): Promise<Session> {
  const { client } = reach.session;
  try {
    if (!client.capabilities().noiseKeyRotation) {
      throw new Error("Its firmware can't be given a key");
    }
    await reach.keep(reach.key);
    const took = await client.setNoiseEncryptionKey(reach.key, {
      timeoutMs: reach.timings.connectMs,
    });
    if (!took) throw new Error("It didn't take its key");
  } finally {
    client.disconnect();
  }
  return backWith(reach, reach.key);
}

/**
 * Takes the key Sanctum gave a device off it, over its session or one made
 * for it, so it waits for a key again, or, as older firmware, greets in the
 * clear again. A device already waiting, as after an answer that was lost,
 * has it off already.
 */
export async function takeKeyOff(
  reach: Reach & { keys: readonly string[]; session: Session | null },
) {
  let session = reach.session;
  const own = !session;
  for (const key of reach.keys) {
    if (session) break;
    const keyed = await connectOnce({
      mac: reach.mac,
      key,
      address: addressOf(reach),
      timings: reach.timings,
    });
    if ("session" in keyed) session = keyed.session;
    // Clearing a key need not update the boot-time record.
    else if (
      "halt" in keyed &&
      keyed.clear &&
      reportsOlderFirmware(keyed.clear)
    )
      return "older";
  }
  if (!session) {
    const zero = await askUnderZeroKey({
      mac: reach.mac,
      address: addressOf(reach),
      timings: reach.timings,
    });
    if (zero.says === "waits" || zero.says === "closed") return zero.says;
    // A successful clear need not update the boot-time record.
    if (zero.says === "clear" && reportsOlderFirmware(zero.info))
      return "older";
    throw new Error("It isn't reachable");
  }
  try {
    const took = await session.client.setNoiseEncryptionKey("", {
      timeoutMs: reach.timings.connectMs,
    });
    if (!took) throw new Error("It kept its key");
  } finally {
    if (own) session.client.disconnect();
  }
  // Firmware from 2026.7 waits for a key once its own is off.
  return beforeProvisioning(session.info.esphomeVersion) === true
    ? "older"
    : "waits";
}
