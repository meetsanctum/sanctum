import { ConnectionClosedByPeerError } from "esphome-client";
import { randomBytes } from "node:crypto";

import {
  connectOnce,
  type Address,
  type Session,
  type Timings,
} from "./connection.js";

// Keys Sanctum gives. A device built to be given its key later waits for
// one, taking connections encrypted with a key of all zeros: that keeps
// listeners out, though it authenticates nobody. Sanctum gives it 32 random
// bytes of its own over such a connection, never in the clear, keeping the
// key before sending it, and only once the device is back under that key,
// which only it can pass, is its MAC trusted. Removing the device takes the
// key off again. A key a device was flashed with is never touched.

/** The key a device waiting for one takes connections under. */
export const zeroKey = Buffer.alloc(32).toString("base64");

/** The name of the secret that says a device's key is one Sanctum gave. */
export const givenOf = (mac: string) => `given:${mac}`;

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
export type Answer =
  | { says: "waits"; info: Session["info"]; session?: Session }
  | { says: "key" }
  | { says: "closed" }
  | { says: "clear"; info: Session["info"] }
  | { says: "unclear" };

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
}): Promise<Answer> {
  const { keepSession, ...target } = reach;
  const result = await connectOnce({ ...target, key: zeroKey });
  if ("session" in result) {
    const { session } = result;
    const { info } = session;
    if (info.apiEncryptionProvisionable !== true) {
      session.client.disconnect();
      return { says: "key" };
    }
    if (keepSession) return { says: "waits", info, session };
    session.client.disconnect();
    return { says: "waits", info };
  }
  if ("halt" in result) {
    return result.clear
      ? { says: "clear", info: result.clear }
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
 * Gives a device its key over the session that showed it was waiting for
 * one. `keep` saves the key first so a lost answer can be retried with it.
 * Returns a checked session under the new key.
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
 * for it, so it waits for a key again. A device already waiting, as after an
 * answer that was lost, has it off already.
 */
export async function takeKeyOff(
  reach: Reach & { key: string; session: Session | null },
) {
  let session = reach.session;
  const own = !session;
  if (!session) {
    const keyed = await connectOnce({
      mac: reach.mac,
      key: reach.key,
      address: addressOf(reach),
      timings: reach.timings,
    });
    if ("session" in keyed) session = keyed.session;
    else {
      const zero = await askUnderZeroKey({
        mac: reach.mac,
        address: addressOf(reach),
        timings: reach.timings,
      });
      if (zero.says === "waits" || zero.says === "closed") return zero.says;
      throw new Error("It isn't reachable");
    }
  }
  try {
    const took = await session.client.setNoiseEncryptionKey("", {
      timeoutMs: reach.timings.connectMs,
    });
    if (!took) throw new Error("It kept its key");
  } finally {
    if (own) session.client.disconnect();
  }
  return "waits";
}
