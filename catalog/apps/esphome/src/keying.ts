import type { AppContext } from "@meetsanctum/app-sdk";

import type {
  Address,
  connectOnce,
  Halt,
  Session,
  Timings,
} from "./connection.js";
import type { Found } from "./found.js";
import {
  askUnderZeroKey,
  giveKey,
  givenOf,
  newKey,
  secretOf,
  setupOf,
} from "./keys.js";

// Giving a device a key of Sanctum's beyond the zero key's way: older
// firmware a setup key in the clear, then its own encrypted; a key given
// anew by Repair to a device that lost its own or never had one; and what a
// halt means when the key that stopped matching is one Sanctum gave.

export function createKeying(options: {
  ctx: AppContext;
  timings: Timings;
  finds: Found;
  addressOf: (mac: string) => Address | null;
  givenKey: (mac: string) => Promise<string | null>;
  check: (mac: string, key: string) => ReturnType<typeof connectOnce>;
}) {
  const { ctx, timings, finds, addressOf, givenKey, check } = options;

  // Why a device's connection halted: a key Sanctum gave that the device
  // lost, as when it's reset, if it waits for a key again or is older
  // firmware with none; otherwise the halt as it is.
  async function problemOf(mac: string, halt: Halt) {
    const address = addressOf(mac);
    if (!address) return halt;
    const given = await givenKey(mac);
    const setup = await ctx.secrets.get(setupOf(mac));
    if (setup) {
      const half = await check(mac, setup);
      if ("session" in half) {
        half.session.client.disconnect();
        return given ? "keyLost" : "notEncrypted";
      }
    }
    if (halt !== "keyMismatch" || !given) return halt;
    const answer = await askUnderZeroKey({ mac, address, timings }).catch(
      () => ({ says: "unclear" }) as const,
    );
    if (answer.says === "waits" || answer.says === "closed") {
      finds.learn(mac, answer.says);
      return "keyLost";
    }
    return answer.says === "clear" && finds.isOlder(mac, answer.info)
      ? "keyLost"
      : halt;
  }

  // Keeps a key Sanctum gives a device, marked as given, before it's sent.
  const keepGiven = (mac: string) => async (psk: string) => {
    await ctx.secrets.set(secretOf(mac), psk);
    await ctx.secrets.set(givenOf(mac), "yes");
  };

  // A device waiting under the zero key no longer has a setup key.
  const keepZero = (mac: string) => async (psk: string) => {
    await ctx.secrets.delete(setupOf(mac));
    await keepGiven(mac)(psk);
  };

  // Finishes older firmware's setup on the connection its setup key opens.
  function giveOwnKey(mac: string, session: Session, key: string) {
    return giveKey({
      mac,
      session,
      key,
      address: () => addressOf(mac),
      timings,
      keep: keepGiven(mac),
    });
  }

  /**
   * Gives older firmware its key: a setup key over a connection in the
   * clear, every sign checked again there, then its own key over the
   * connection the setup key encrypts. A key Sanctum kept is never sent in
   * the clear, and each setup key is a fresh one. Returns a session under
   * its own key.
   */
  async function giveOlderKey(
    mac: string,
    plain: Session,
    own: string,
  ): Promise<Session> {
    const address = addressOf(mac);
    if (
      plain.encrypted ||
      address?.host !== plain.address.host ||
      address.port !== plain.address.port ||
      !finds.isOlder(mac, plain.info)
    ) {
      plain.client.disconnect();
      throw new Error("It answered differently");
    }
    const reach = { mac, address: () => addressOf(mac), timings };
    const setup = await giveKey({
      ...reach,
      session: plain,
      key: newKey(),
      keep: (psk) => ctx.secrets.set(setupOf(mac), psk),
    });
    return giveOwnKey(mac, setup, own);
  }

  // A key of Sanctum's for a device: one a Repair whose answer was lost left
  // on it, its own or older firmware's setup key, each tried encrypted
  // first; else a new one, over the zero key where it waits for one, or
  // older firmware a setup key first.
  async function keyAnew(mac: string) {
    const reach = { mac, address: () => addressOf(mac), timings };
    const given = await givenKey(mac);
    if (given) {
      const kept = await check(mac, given);
      if ("session" in kept) {
        kept.session.client.disconnect();
        return;
      }
    }
    const setup = await ctx.secrets.get(setupOf(mac));
    if (setup) {
      const half = await check(mac, setup);
      if ("session" in half) {
        const session = await giveOwnKey(mac, half.session, newKey());
        session.client.disconnect();
        return;
      }
    }
    const address = addressOf(mac);
    if (!address) throw new Error("It isn't on the home's network");
    const answer = await askUnderZeroKey({
      mac,
      address,
      timings,
      keepSession: true,
      keepClearSession: true,
    });
    if (answer.says === "waits" && answer.session) {
      finds.learn(mac, "waits");
      const session = await giveKey({
        ...reach,
        key: newKey(),
        session: answer.session,
        keep: keepZero(mac),
      });
      session.client.disconnect();
      return;
    }
    if (answer.says === "clear" && answer.session) {
      const session = await giveOlderKey(mac, answer.session, newKey());
      session.client.disconnect();
      return;
    }
    throw new Error(
      answer.says === "unclear"
        ? "It didn't answer"
        : "It can't be given a key now",
    );
  }

  return { problemOf, keepZero, giveOlderKey, giveOwnKey, keyAnew };
}
