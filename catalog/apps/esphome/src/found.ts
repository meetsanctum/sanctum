import type { AppContext, FoundReport } from "@meetsanctum/app-sdk";

import type { Address, Session, Timings } from "./connection.js";
import { askUnderZeroKey, type Answer } from "./keys.js";
import type { Announced } from "./sightings.js";

// The devices ESPHome found and hasn't added, and what each says of its key.
// A device writes its record once, as it boots, so the record goes stale the
// moment a key is given to it or taken off it, by Sanctum or another app:
// it's only a first guess. A connection under the zero key says what holds,
// and so do Sanctum's own connections as it adds and removes devices. What
// was learned holds for the announcement it was learned under: a device that
// announces itself anew, as after a restart, is asked again.

/** What a found device's key is, as Sanctum last learned it. */
export type Said = "waits" | "key" | "closed" | "clear";

type Learned = { said: Said; maker: string | null; sighting: string };

/** What a record says that sets one announcement of a device apart from the next. */
export const sightingOf = (found: Announced) =>
  JSON.stringify([
    found.addresses[0],
    found.port,
    found.encryption,
    found.version,
    found.projectName,
  ]);

// The most devices asked at once, so a busy network isn't flooded.
const asking = 2;

export function createFound(options: {
  ctx: AppContext;
  timings: Timings;
  announced: ReadonlyMap<string, Announced>;
  /** Whether a device is one the core has, which isn't listed. */
  added: (mac: string) => boolean;
  /** The key Sanctum gave a device, if it gave one and kept it. */
  givenKey: (mac: string) => Promise<string | null>;
  /** Who made a device, from what it says of itself. */
  makerOf: (info: Session["info"]) => string | null;
}) {
  const { ctx, timings, announced } = options;
  const learned = new Map<string, Learned>();
  // Each device's latest learning, so an answer to an older ask never
  // overwrites what Add or Remove learned since.
  const epochs = new Map<string, number>();
  const queue: string[] = [];
  const running = new Map<
    string,
    { controller: AbortController; work: Promise<unknown> }
  >();
  const again = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  // Found devices go to the core one list at a time, in order.
  let listing = Promise.resolve();

  const epochOf = (mac: string) => epochs.get(mac) ?? 0;

  /** What Sanctum learned of a device under its current announcement. */
  function current(mac: string) {
    const found = announced.get(mac);
    const known = learned.get(mac);
    return found && known?.sighting === sightingOf(found) ? known : null;
  }

  /** What a device's key is: what was learned, else what its record says. */
  function saidOf(found: Announced): Said {
    const known = current(found.mac);
    if (known) return known.said;
    return found.encryption === "waiting"
      ? "waits"
      : found.encryption === "key"
        ? "key"
        : "clear";
  }

  function addressOf(found: Announced): Address | null {
    const host = found.addresses[0];
    return host ? { host, port: found.port } : null;
  }

  function list() {
    listing = listing
      .then(async () => {
        if (stopped) return;
        const shown = [...announced.values()]
          .filter((each) => !options.added(each.mac))
          .slice(0, 64);
        const found: FoundReport[] = [];
        for (const each of shown) {
          const row = { key: each.mac, name: each.name.slice(0, 120) };
          const said = saidOf(each);
          if (said === "waits") {
            found.push({
              ...row,
              description:
                current(each.mac)?.maker ?? "Gets an encryption key of its own",
              asks: [],
            });
          } else if (said === "closed") {
            found.push({
              ...row,
              description: "Turn it off and on again to add it",
              asks: [],
            });
          } else if (said === "clear") {
            found.push({ ...row, description: "Not encrypted", asks: [] });
          } else if (await options.givenKey(each.mac)) {
            // Removed with the key it was given still on it, it's added
            // with that key again.
            found.push({
              ...row,
              description: "Has the key it was given before",
              asks: [],
            });
          } else {
            found.push({
              ...row,
              description: "Needs its encryption key",
              asks: ["key"],
            });
          }
        }
        await ctx.devices.found(found);
      })
      .catch((error: unknown) => {
        ctx.log(`could not list found devices (${String(error)})`);
      });
    return listing;
  }

  // A device asked again in a while: turning one off and on again announces
  // the same record, and one that was busy may answer next time.
  function askAgainLater(mac: string) {
    clearTimeout(again.get(mac));
    again.set(
      mac,
      setTimeout(() => {
        again.delete(mac);
        learned.delete(mac);
        schedule();
      }, timings.askAgainMs),
    );
  }

  /** Keeps what a device said, under the announcement it said it under. */
  function keep(found: Announced, said: Answer) {
    // An answer in the clear from a device whose record says it takes a key
    // says only that it was busy or restarting as it was asked, as the
    // library greets one in the clear once it ends a zero-key handshake.
    const answer: Answer =
      said.says === "clear" && found.encryption !== "none"
        ? { says: "unclear" }
        : said;
    clearTimeout(again.get(found.mac));
    again.delete(found.mac);
    if (answer.says === "unclear" || answer.says === "closed") {
      askAgainLater(found.mac);
    }
    if (answer.says === "unclear") return;
    learned.set(found.mac, {
      said: answer.says,
      maker: answer.says === "waits" ? options.makerOf(answer.info) : null,
      sighting: sightingOf(found),
    });
  }

  /**
   * Asks a device now, as Add does before it acts: what it says, kept
   * unless something learned since overrides it.
   */
  async function ask(mac: string, signal?: AbortSignal): Promise<Answer> {
    const found = announced.get(mac);
    const address = found && addressOf(found);
    if (!found || !address) return { says: "unclear" };
    const epoch = epochOf(mac);
    const answer = await askUnderZeroKey({ mac, address, timings, signal });
    if (!stopped && epochOf(mac) === epoch && announced.get(mac) === found) {
      keep(found, answer);
      await list();
    }
    return answer;
  }

  /** What Sanctum's own connection showed of a device, as it added or removed it. */
  function learn(mac: string, said: Said) {
    epochs.set(mac, epochOf(mac) + 1);
    running.get(mac)?.controller.abort();
    const found = announced.get(mac);
    if (!found) return;
    clearTimeout(again.get(mac));
    again.delete(mac);
    learned.set(mac, {
      said,
      maker: current(mac)?.maker ?? null,
      sighting: sightingOf(found),
    });
  }

  // Asks, two at a time, each found device whose record says it waits for a
  // key or has one and which hasn't said under its current announcement. A
  // record that says it takes none is asked only as someone adds it: under
  // the zero key, such a device is greeted in the clear, a whole session,
  // which can set off what the device does when someone connects.
  function schedule() {
    if (stopped) return;
    for (const found of announced.values()) {
      const mac = found.mac;
      if (
        found.encryption === "none" ||
        options.added(mac) ||
        current(mac) ||
        again.has(mac) ||
        running.has(mac) ||
        queue.includes(mac)
      ) {
        continue;
      }
      queue.push(mac);
    }
    while (running.size < asking && queue.length > 0) {
      const mac = queue.shift()!;
      if (!announced.has(mac) || options.added(mac) || current(mac)) continue;
      const controller = new AbortController();
      const work = ask(mac, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (running.get(mac)?.controller === controller) running.delete(mac);
          schedule();
        });
      running.set(mac, { controller, work });
    }
  }

  return {
    list,
    ask,
    learn,
    schedule,
    /** What a device's key is: what was learned, else its record's guess. */
    said(mac: string): Said | null {
      const found = announced.get(mac);
      return found ? saidOf(found) : null;
    },
    async stop() {
      stopped = true;
      for (const timer of again.values()) clearTimeout(timer);
      again.clear();
      queue.length = 0;
      const asks = [...running.values()];
      for (const each of asks) each.controller.abort();
      await Promise.all(asks.map((each) => each.work));
      await listing;
    },
  };
}

export type Found = ReturnType<typeof createFound>;
