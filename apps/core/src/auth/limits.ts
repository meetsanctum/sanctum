import { randomUUID } from "node:crypto";
import { isIPv6 } from "node:net";

import { AuthError } from "./errors.js";

// Auth's limits. They live in memory, keyed by the connection's own address:
// the core trusts no forwarded-for headers.

export const defaultLimits = {
  // Sign-ins that do not finish, per address, in the window.
  attempts: 20,
  attemptWindowMs: 15 * 60_000,
  // Addresses the attempt counter tracks at once.
  trackedAddresses: 1_024,
  // Open sign-ins and registrations, per address and across the host.
  openPerAddress: 10,
  openTotal: 64,
  openMs: 60_000,
  // OPAQUE operations the host does per second. Each is synchronous and
  // short (7 to 17 ms on a Pi 4), so they never run at once; the budget
  // bounds how much of the host they take.
  workPerSecond: 20,
  // Shared devices' open pairing requests, per address and across the host.
  // A device asks again each time its request expires, and after a restore
  // every shared device in the home asks at once.
  pairingPerAddress: 5,
  pairingTotal: 32,
};

export type Limits = typeof defaultLimits;

// The key an address is limited by. One host can use any address in its
// IPv6 /64, so that is what counts there.
export function addressKey(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) {
    return mapped[1]!;
  }
  if (!isIPv6(address)) {
    return address;
  }
  const [head = "", tail] = address.split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(gap).fill("0"), ...right];
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}

export function createLimiter(
  options: {
    limits?: Limits;
    now?: () => number;
    // The first refusal for an address in its window, for the activity log.
    onLimitReached?: (address: string) => void;
  } = {},
) {
  const limits = options.limits ?? defaultLimits;
  const now = options.now ?? Date.now;
  const attempts = new Map<string, { at: number[]; reported: boolean }>();
  let work: number[] = [];

  function recent(key: string, at: number) {
    const entry = attempts.get(key);
    if (!entry) {
      return undefined;
    }
    entry.at = entry.at.filter((time) => at - time < limits.attemptWindowMs);
    if (entry.at.length === 0) {
      attempts.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    // Counts a sign-in, or a first call that registers a password, before
    // it is answered: each answer is worth one password guess.
    attempt(address: string) {
      const key = addressKey(address);
      const at = now();
      let entry = recent(key, at);
      if (!entry) {
        if (attempts.size >= limits.trackedAddresses) {
          for (const tracked of attempts.keys()) {
            recent(tracked, at);
          }
        }
        if (attempts.size >= limits.trackedAddresses) {
          throw new AuthError("busy");
        }
        entry = { at: [], reported: false };
        attempts.set(key, entry);
      }
      if (entry.at.length >= limits.attempts) {
        if (!entry.reported) {
          entry.reported = true;
          options.onLimitReached?.(address);
        }
        throw new AuthError("too_many_attempts");
      }
      entry.at.push(at);
    },

    // A sign-in that finished takes its attempt back.
    succeeded(address: string) {
      const entry = recent(addressKey(address), now());
      entry?.at.pop();
      if (entry && entry.at.length < limits.attempts) {
        entry.reported = false;
      }
    },

    // Spends one OPAQUE operation from the host's budget.
    work() {
      const at = now();
      work = work.filter((time) => at - time < 1_000);
      if (work.length >= limits.workPerSecond) {
        throw new AuthError("busy");
      }
      work.push(at);
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;

// Open sign-ins and registrations: each expires after a minute and can be
// finished once, by the address that started it.
export function createPendingStore<T extends { address: string }>(
  options: { limits?: Limits; now?: () => number } = {},
) {
  const limits = options.limits ?? defaultLimits;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();

  function sweep() {
    const at = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= at) {
        entries.delete(id);
      }
    }
  }

  return {
    add(value: T) {
      sweep();
      const key = addressKey(value.address);
      let fromAddress = 0;
      for (const entry of entries.values()) {
        if (addressKey(entry.value.address) === key) {
          fromAddress += 1;
        }
      }
      if (
        entries.size >= limits.openTotal ||
        fromAddress >= limits.openPerAddress
      ) {
        throw new AuthError("busy");
      }
      const id = randomUUID();
      entries.set(id, { value, expiresAt: now() + limits.openMs });
      return id;
    },

    // Removes the entry, so it cannot be finished twice.
    take(id: string, address: string): T | undefined {
      const entry = entries.get(id);
      entries.delete(id);
      if (
        !entry ||
        entry.expiresAt <= now() ||
        addressKey(entry.value.address) !== addressKey(address)
      ) {
        return undefined;
      }
      return entry.value;
    },

    // Drops every entry a predicate matches, such as a removed login's.
    drop(matches: (value: T) => boolean) {
      for (const [id, entry] of entries) {
        if (matches(entry.value)) {
          entries.delete(id);
        }
      }
    },
  };
}
