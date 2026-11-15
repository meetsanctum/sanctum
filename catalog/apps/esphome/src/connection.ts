import {
  EncryptionKeyInvalidError,
  EncryptionKeyMissingError,
  EncryptionRequiredError,
  EspHomeClient,
  type DeviceInfo,
  type Entity,
  type EspHomeLogging,
  type TelemetryEvent,
} from "esphome-client";

import { macOf } from "./sightings.js";

// One device's connection, kept open: a ping after 20 s of quiet, the
// device offline once 90 s pass without it, and connecting again after
// pauses growing to a minute, or at once when the device is seen again. A
// connection is used only once it's checked: encrypted wherever Sanctum has
// the device's key, from the MAC address the device was added by. A key
// that stops matching, or a device that answers without one, stops it until
// the device is repaired or announces itself anew, so it's never hammered.

/** How a connection is timed; a test shortens them. */
export type Timings = {
  pingMs: number;
  offlineMs: number;
  firstPauseMs: number;
  longestPauseMs: number;
  connectMs: number;
};

export const defaultTimings: Timings = {
  pingMs: 20_000,
  offlineMs: 90_000,
  firstPauseMs: 1_000,
  longestPauseMs: 60_000,
  connectMs: 10_000,
};

/** Where a device is, as its latest record says. */
export type Address = { host: string; port: number };

/** What a checked connection told about its device. */
export type Session = {
  client: EspHomeClient;
  info: DeviceInfo;
  entities: Entity[];
  encrypted: boolean;
  address: Address;
  /**
   * Who hears what the device says from now on, first what it said since
   * the check: its states, and each press once.
   */
  listen(listener: (event: TelemetryEvent) => void): void;
};

/** Why a connection stopped trying, until the device is repaired or announces itself anew. */
export type Halt = "keyMismatch" | "keyAdded";

export type ConnectionEvents = {
  /** A checked session, which the driver takes in before it hears its states. */
  connected(session: Session): Promise<void>;
  state(event: TelemetryEvent): void;
  /** Gone for longer than the device may be, or back. */
  reachable(reachable: boolean): void;
  halted(halt: Halt): void;
};

const quiet: EspHomeLogging = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// What a session holds of what its device said before anyone listens.
const heldEvents = 256;

// What a failed connection means: the device's key not matching, or the
// device having one that Sanctum doesn't, both of which wait for Repair;
// anything else, as a device out of reach, is tried again.
function haltOf(error: unknown, hasKey: boolean): Halt | null {
  if (
    hasKey &&
    (error instanceof EncryptionKeyInvalidError ||
      error instanceof EncryptionKeyMissingError)
  ) {
    return "keyMismatch";
  }
  if (!hasKey && error instanceof EncryptionRequiredError) return "keyAdded";
  return null;
}

/**
 * Connects once to a device at an address, with its key or none, and checks
 * it: the session, or the halt it calls for, or the error when it can't be
 * used now. A device Sanctum has a key for that answers without encryption
 * is dropped before anything is asked of it, as is one with another MAC.
 */
export async function connectOnce(options: {
  mac: string;
  key: string | null;
  address: Address;
  timings: Timings;
}): Promise<{ session: Session } | { halt: Halt } | { error: unknown }> {
  const { mac, key, address, timings } = options;
  let checked = false;
  let listener: ((event: TelemetryEvent) => void) | null = null;
  const held: TelemetryEvent[] = [];
  const client = new EspHomeClient({
    host: address.host,
    port: address.port,
    psk: key,
    clientId: "Sanctum",
    reconnect: false,
    keepAlive: {
      intervalMs: timings.pingMs,
      stallTimeoutMs: timings.offlineMs,
    },
    connectTimeoutMs: timings.connectMs,
    logger: quiet,
  });
  // Nothing it says counts before the check, and what it says after waits
  // for someone to listen.
  client.on("telemetry", (event) => {
    if (!checked) return;
    if (listener) listener(event);
    else if (held.length < heldEvents) held.push(event);
  });
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    const halt = haltOf(error, key !== null);
    return halt ? { halt } : { error };
  }
  const encrypted = client.health().encrypted;
  const info = client.deviceInfo();
  // The library falls back to no encryption when a device answers without
  // it, which a device with a key never does.
  if (key !== null && !encrypted) {
    client.disconnect();
    return { halt: "keyMismatch" };
  }
  if (!info || macOf(info.macAddress) !== mac) {
    client.disconnect();
    return { error: new Error("another device answers there") };
  }
  checked = true;
  // States it sent while it was checked, which the client kept, but not
  // presses, which happened then and are over.
  for (const event of client.snapshot().values()) {
    if (event.type !== "event") held.push(event);
  }
  return {
    session: {
      client,
      info,
      entities: client.entitiesByDevice(undefined),
      encrypted,
      address,
      listen(next) {
        listener = next;
        for (const event of held.splice(0)) next(event);
      },
    },
  };
}

/** A device's connection, as long as Sanctum has the device. */
export function createConnection(options: {
  mac: string;
  key: () => Promise<string | null>;
  address: () => Address | null;
  timings: Timings;
  events: ConnectionEvents;
}) {
  const { mac, timings, events } = options;
  let session: Session | null = null;
  let stopped = false;
  let halted = false;
  let attempt: Promise<void> | null = null;
  let pause = timings.firstPauseMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let gone: ReturnType<typeof setTimeout> | undefined;
  let reachable: boolean | null = null;
  let generation = 0;

  function say(now: boolean) {
    clearTimeout(gone);
    gone = undefined;
    if (reachable === now) return;
    reachable = now;
    events.reachable(now);
  }

  // Gone once the device has been out of reach for longer than it may be.
  function goneLater() {
    if (gone || reachable === false) return;
    gone = setTimeout(() => {
      gone = undefined;
      if (!session && !stopped) say(false);
    }, timings.offlineMs);
  }

  function later() {
    if (stopped || halted || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      start();
    }, pause);
    pause = Math.min(pause * 2, timings.longestPauseMs);
  }

  function use(next: Session) {
    session = next;
    pause = timings.firstPauseMs;
    next.client.on("disconnect", () => {
      if (session !== next) return;
      session = null;
      goneLater();
      later();
    });
    say(true);
    void events
      .connected(next)
      .catch(() => undefined)
      .then(() => {
        if (session === next) next.listen((event) => events.state(event));
      });
  }

  function start() {
    if (stopped || halted || session || attempt) return;
    const address = options.address();
    if (!address) {
      // Not announced: it's tried again once it is.
      goneLater();
      return;
    }
    const mine = ++generation;
    attempt = (async () => {
      const key = await options.key();
      const result = await connectOnce({ mac, key, address, timings });
      if (stopped || mine !== generation) {
        if ("session" in result) result.session.client.disconnect();
        return;
      }
      if ("halt" in result) {
        halted = true;
        goneLater();
        events.halted(result.halt);
        return;
      }
      if ("error" in result) {
        goneLater();
        later();
        return;
      }
      use(result.session);
    })().finally(() => {
      attempt = null;
    });
  }

  return {
    /** The checked connection, while there is one. */
    get session() {
      return session;
    },
    start,
    /** Takes over a session someone checked, as adding a device does. */
    adopt(next: Session) {
      if (stopped || session) {
        next.client.disconnect();
        return;
      }
      generation += 1;
      use(next);
    },
    /**
     * The device announced itself, perhaps anew: tried at once, and again
     * after a halt, as when it was reflashed.
     */
    seen(anew: boolean) {
      if (anew) halted = false;
      clearTimeout(retry);
      retry = undefined;
      pause = timings.firstPauseMs;
      start();
    },
    /** Its key changed, as after Repair: the old connection goes, and it connects again. */
    renew() {
      halted = false;
      generation += 1;
      const old = session;
      session = null;
      old?.client.disconnect();
      clearTimeout(retry);
      retry = undefined;
      pause = timings.firstPauseMs;
      start();
    },
    stop() {
      stopped = true;
      generation += 1;
      clearTimeout(retry);
      clearTimeout(gone);
      const old = session;
      session = null;
      old?.client.disconnect();
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;
