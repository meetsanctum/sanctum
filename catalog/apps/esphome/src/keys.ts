import { ConnectionClosedByPeerError } from "esphome-client";
import { randomBytes } from "node:crypto";

import {
  connectOnce,
  type Address,
  type Session,
  type Timings,
} from "./connection.js";
import type { Mapping } from "./entities.js";

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

/** That a device ended a connection under the zero key as it no longer waits for a key. */
export function stoppedWaiting(error: unknown) {
  return (
    error instanceof ConnectionClosedByPeerError &&
    error.code === "PEER_DISCONNECT_DURING_HANDSHAKE"
  );
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
 * Gives a device waiting for a key this one, which `keep` keeps first, and
 * connects again under it: the session, checked as any, or that the device
 * no longer waits for a key. Otherwise it throws, and the key it kept is
 * tried first next time, as after an answer that was lost.
 */
export async function giveKey(
  reach: Reach & { key: string; keep: (key: string) => Promise<void> },
): Promise<{ session: Session } | { notWaiting: true }> {
  const zero = await connectOnce({
    mac: reach.mac,
    key: zeroKey,
    address: addressOf(reach),
    timings: reach.timings,
  });
  if ("error" in zero && stoppedWaiting(zero.error)) {
    return { notWaiting: true };
  }
  // A device that answers in the clear is never sent a key.
  if (!("session" in zero)) throw new Error("It can't be given a key");
  const { client } = zero.session;
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
  return { session: await backWith(reach, reach.key) };
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
      const zero = await connectOnce({
        mac: reach.mac,
        key: zeroKey,
        address: addressOf(reach),
        timings: reach.timings,
      });
      if ("session" in zero) zero.session.client.disconnect();
      if (
        "session" in zero ||
        ("error" in zero && stoppedWaiting(zero.error))
      ) {
        return;
      }
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
}

const measureWords = {
  temperature: "temperature",
  humidity: "humidity",
  illuminance: "light level",
} as const;

const kindWords = {
  light: "light",
  switch: "switch",
  button: "buttons",
  motion: "motion",
  contact: "open or closed",
} as const;

/** What a device has, as its found row says: "temperature, humidity, motion". */
export function partsOf(mapping: Mapping): string | null {
  const words = new Set<string>();
  for (const { capability } of mapping.mapped) {
    if (capability.kind === "sensor") {
      const { measures } = capability.features as {
        measures: keyof typeof measureWords;
      };
      words.add(measureWords[measures]);
    } else {
      words.add(kindWords[capability.kind as keyof typeof kindWords]);
    }
  }
  const text = [...words].filter(Boolean).join(", ");
  return text ? text.slice(0, 120) : null;
}
