import type { AppContext } from "@meetsanctum/app-sdk";

import type { Address, Halt, Session, Timings } from "./connection.js";
import type { Facts } from "./facts.js";
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

type Check = (
  mac: string,
  key: string | null,
) => Promise<
  | { session: Session }
  | { halt: Halt; clear?: Session["info"] }
  | { error: unknown }
>;

export function createKeying(options: {
  ctx: AppContext;
  timings: Timings;
  finds: Found;
  facts: Facts;
  addressOf: (mac: string) => Address | null;
  givenKey: (mac: string) => Promise<string | null>;
  check: Check;
}) {
  const { ctx, timings, finds, facts, addressOf, givenKey, check } = options;

  // Why a device's connection halted: a key Sanctum gave that the device
  // lost, as when it's reset, if it waits for a key again or is older
  // firmware with none; otherwise the halt as it is.
  async function problemOf(mac: string, halt: string) {
    const address = addressOf(mac);
    if (halt !== "keyMismatch" || !address || !(await givenKey(mac))) {
      return halt;
    }
    const answer = await askUnderZeroKey({ mac, address, timings }).catch(
      () => ({ says: "unclear" }) as const,
    );
    return answer.says === "waits" ||
      (answer.says === "clear" && finds.isOlder(mac, answer.info))
      ? "keyLost"
      : halt;
  }

  // Keeps a key Sanctum gives a device, marked as given, before it's sent.
  const keepGiven = (mac: string) => async (psk: string) => {
    await ctx.secrets.set(secretOf(mac), psk);
    await ctx.secrets.set(givenOf(mac), "yes");
  };

  /**
   * Gives older firmware its key: a setup key over a connection in the
   * clear, every sign checked again there, then its own key over the
   * connection the setup key encrypts. A key Sanctum kept is never sent in
   * the clear, and each setup key is a fresh one. Returns a session under
   * its own key, or what holds instead: it has a key, or isn't older
   * firmware after all.
   */
  async function giveOlderKey(
    mac: string,
    own: string,
  ): Promise<{ session: Session } | { has: "key" | "changed" }> {
    const plain = await check(mac, null);
    if ("halt" in plain) return { has: "key" };
    if ("error" in plain) throw new Error("It didn't answer");
    if (!finds.isOlder(mac, plain.session.info)) {
      plain.session.client.disconnect();
      return { has: "changed" };
    }
    const reach = { mac, address: () => addressOf(mac), timings };
    const setup = await giveKey({
      ...reach,
      session: plain.session,
      key: newKey(),
      keep: (psk) => ctx.secrets.set(setupOf(mac), psk),
    });
    const session = await giveKey({
      ...reach,
      session: setup,
      key: own,
      keep: keepGiven(mac),
    });
    await ctx.secrets.delete(setupOf(mac));
    return { session };
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
        const session = await giveKey({
          ...reach,
          key: newKey(),
          session: half.session,
          keep: keepGiven(mac),
        });
        session.client.disconnect();
        await ctx.secrets.delete(setupOf(mac));
        await facts.firstKey(mac, "setup");
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
    });
    if (answer.says === "waits" && answer.session) {
      const session = await giveKey({
        ...reach,
        key: newKey(),
        session: answer.session,
        keep: keepGiven(mac),
      });
      session.client.disconnect();
      await facts.firstKey(mac, null);
      return;
    }
    if (answer.says === "clear" && finds.isOlder(mac, answer.info)) {
      const result = await giveOlderKey(mac, newKey());
      if (!("session" in result)) throw new Error("It answered differently");
      result.session.client.disconnect();
      await facts.firstKey(mac, "setup");
      return;
    }
    throw new Error(
      answer.says === "unclear"
        ? "It didn't answer"
        : "It can't be given a key now",
    );
  }

  return { problemOf, keepGiven, giveOlderKey, keyAnew };
}
