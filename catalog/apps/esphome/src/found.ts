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
type Said = "waits" | "key" | "closed" | "clear";

type Observation = {
  sighting: string;
  learned?: { said: Said; maker: string | null };
  needsAsk: boolean;
  request?: object;
  retry?: ReturnType<typeof setTimeout>;
};

/** What a record says that sets one announcement of a device apart from the next. */
const sightingOf = (found: Announced) =>
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
  const observations = new Map<string, Observation>();
  const running = new Map<
    string,
    { controller: AbortController; work: Promise<unknown> }
  >();
  let stopped = false;
  // Found devices go to the core one list at a time, in order.
  let listing = Promise.resolve();

  function observationOf(found: Announced) {
    let observation = observations.get(found.mac);
    if (!observation) {
      observation = { sighting: sightingOf(found), needsAsk: true };
      observations.set(found.mac, observation);
    }
    return observation;
  }

  /** What a device's key is: what was learned, else what its record says. */
  function saidOf(found: Announced): Said {
    const known = observations.get(found.mac)?.learned;
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
                observations.get(each.mac)?.learned?.maker ??
                "Gets an encryption key of its own",
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
  function finishAsk(observation: Observation, shouldRetry: boolean) {
    clearTimeout(observation.retry);
    observation.needsAsk = false;
    observation.retry = shouldRetry
      ? setTimeout(() => {
          observation.retry = undefined;
          observation.needsAsk = true;
          schedule();
        }, timings.askAgainMs)
      : undefined;
  }

  /** Interprets a probe in light of the announcement under which it ran. */
  function answerOf(found: Announced, answer: Answer): Answer {
    // An answer in the clear from a device whose record says it takes a key
    // says only that it was busy or restarting as it was asked, as the
    // library greets one in the clear once it ends a zero-key handshake.
    return answer.says === "clear" && found.encryption !== "none"
      ? { says: "unclear" }
      : answer;
  }

  /**
   * Asks a device now, as Add does before it acts: what it says, kept
   * unless something learned since overrides it.
   */
  async function ask(
    mac: string,
    {
      signal,
      keepSession,
    }: { signal?: AbortSignal; keepSession?: boolean } = {},
  ): Promise<Answer> {
    const found = announced.get(mac);
    const address = found && addressOf(found);
    if (stopped || !found || !address) return { says: "unclear" };
    const observation = observationOf(found);
    const request = {};
    const isCurrent = () =>
      !stopped &&
      observations.get(mac) === observation &&
      observation.request === request;
    observation.request = request;
    if (!signal) running.get(mac)?.controller.abort();
    let session: Session | undefined;
    try {
      const answer = answerOf(
        found,
        await askUnderZeroKey({ mac, address, timings, signal, keepSession }),
      );
      if (answer.says === "waits") session = answer.session;
      if (!isCurrent()) return { says: "unclear" };
      finishAsk(
        observation,
        answer.says === "unclear" || answer.says === "closed",
      );
      if (answer.says !== "unclear") {
        observation.learned = {
          said: answer.says,
          maker: answer.says === "waits" ? options.makerOf(answer.info) : null,
        };
      }
      await list();
      if (!isCurrent()) return { says: "unclear" };
      session = undefined;
      return answer;
    } finally {
      session?.client.disconnect();
      if (observation.request === request) observation.request = undefined;
    }
  }

  /** What Sanctum's own connection showed of a device, as it added or removed it. */
  function learn(mac: string, said: Said) {
    const found = announced.get(mac);
    if (!found) return;
    const observation = observationOf(found);
    observation.request = undefined;
    running.get(mac)?.controller.abort();
    finishAsk(observation, said === "closed");
    const maker = observation.learned?.maker ?? null;
    observation.learned = { said, maker };
  }

  function discoveryChanged() {
    for (const [mac, observation] of observations) {
      const found = announced.get(mac);
      if (found && sightingOf(found) === observation.sighting) continue;
      clearTimeout(observation.retry);
      observations.delete(mac);
      running.get(mac)?.controller.abort();
    }
  }

  // Asks, two at a time, each found device whose record says it waits for a
  // key or has one and which hasn't said under its current announcement. A
  // record that says it takes none is asked only as someone adds it: under
  // the zero key, such a device is greeted in the clear, a whole session,
  // which can set off what the device does when someone connects.
  function schedule() {
    if (stopped) return;
    for (const found of announced.values()) {
      if (running.size >= asking) break;
      const mac = found.mac;
      if (
        found.encryption === "none" ||
        !addressOf(found) ||
        options.added(mac) ||
        running.has(mac)
      ) {
        continue;
      }
      const observation = observationOf(found);
      if (!observation.needsAsk || observation.request) continue;
      const controller = new AbortController();
      const work = ask(mac, { signal: controller.signal })
        .catch(() => undefined)
        .finally(() => {
          running.delete(mac);
          schedule();
        });
      running.set(mac, { controller, work });
    }
  }

  return {
    list,
    ask,
    learn,
    discoveryChanged,
    schedule,
    retry(mac: string) {
      const observation = observations.get(mac);
      if (!observation) return;
      clearTimeout(observation.retry);
      observation.retry = undefined;
      observation.needsAsk = true;
      schedule();
    },
    /** What a device's key is: what was learned, else its record's guess. */
    said(mac: string): Said | null {
      const found = announced.get(mac);
      return found ? saidOf(found) : null;
    },
    async stop() {
      stopped = true;
      for (const observation of observations.values())
        clearTimeout(observation.retry);
      observations.clear();
      const asks = [...running.values()];
      for (const each of asks) each.controller.abort();
      await Promise.all(asks.map((each) => each.work));
      await listing;
    },
  };
}
