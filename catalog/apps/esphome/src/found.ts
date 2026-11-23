import type { AppContext, FoundReport } from "@meetsanctum/app-sdk";

import type { Address, Session, Timings } from "./connection.js";
import { askUnderZeroKey, isOlderFirmware, type Answer } from "./keys.js";
import { beforeProvisioning, type Announced } from "./sightings.js";

// The devices ESPHome found and hasn't added, and what each says of its key.
// A device writes its record once, as it boots, so the record goes stale the
// moment a key is given to it or taken off it, by Sanctum or another app:
// it's only a first guess. A connection under the zero key says what holds,
// and so do Sanctum's own connections as it adds and removes devices. What
// was learned holds for the announcement it was learned under: a device that
// announces itself anew, as after a restart, is asked again.
//
// Firmware from before ESPHome 2026.7 gets a setup key in the clear, so it's
// told apart with care: only as someone adds it, every sign agreeing, and
// never a device once seen taking the zero key, which a busy one answered in
// the clear would otherwise look like.

/** What a found device's key is, as Sanctum last learned it. */
type Said = "waits" | "key" | "closed" | "clear" | "older";

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
  /** Whether Sanctum kept a key it gave to the device. */
  hasKeptKey: (mac: string) => Promise<boolean>;
  /** Who made a device, from what it says of itself. */
  makerOf: (
    info: Pick<Session["info"], "projectName" | "manufacturer" | "model">,
  ) => string | null;
}) {
  const { ctx, timings, announced } = options;
  const observations = new Map<string, Observation>();
  // Devices seen taking the zero key or saying they could, by MAC, kept
  // across announcements until one says a version from before 2026.7, as
  // after it's flashed with older firmware.
  const tookZeroKey = new Set<string>();
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
        : found.encryption === "older"
          ? "older"
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
          // Who made it, where adding asks nothing: how it gets its key is
          // Sanctum's business, not the household's.
          const maker =
            observations.get(each.mac)?.learned?.maker ??
            options.makerOf({
              projectName: each.projectName ?? undefined,
              manufacturer: "",
              model: "",
            });
          if (said === "closed") {
            found.push({
              ...row,
              description: "Turn it off and on again to add it",
              asks: [],
            });
          } else if (said === "clear") {
            found.push({ ...row, description: "Not encrypted", asks: [] });
          } else if (
            said === "waits" ||
            said === "older" ||
            (await options.hasKeptKey(each.mac))
          ) {
            // One removed with the key it was given still on it is added
            // with that key again.
            found.push({ ...row, description: maker, asks: [] });
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
  function answerOf(
    found: Announced,
    answer: Awaited<ReturnType<typeof askUnderZeroKey>>,
  ): Answer {
    if (
      answer.says === "waits" ||
      answer.says === "closed" ||
      (answer.says === "key" && answer.tookZeroKey) ||
      (answer.says === "clear" &&
        answer.info.apiEncryptionProvisionable === true)
    ) {
      tookZeroKey.add(found.mac);
    }
    if (answer.says !== "clear") return answer;
    if (found.encryption === "none")
      return { says: "clear", info: answer.info };
    // Older firmware only with every sign agreeing. Otherwise an answer in
    // the clear from a device whose record says it takes a key says only
    // that it was busy or restarting as it was asked, as the library greets
    // one in the clear once it ends a zero-key handshake.
    return isOlderFirmware(found, answer.info, tookZeroKey.has(found.mac))
      ? { says: "older", session: answer.session }
      : { says: "unclear" };
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
      keepClearSession,
    }: {
      signal?: AbortSignal;
      keepSession?: boolean;
      keepClearSession?: boolean;
    } = {},
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
      const probe = await askUnderZeroKey({
        mac,
        address,
        timings,
        signal,
        keepSession,
        keepClearSession,
      });
      if (probe.says === "waits" || probe.says === "clear") {
        session = probe.session;
      }
      // An answer to an announcement since replaced says nothing, not even
      // that the device once took the zero key.
      if (!isCurrent()) return { says: "unclear" };
      const answer = answerOf(found, probe);
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
      if (answer.says === "waits" || answer.says === "older") {
        session = undefined;
      }
      return answer;
    } finally {
      session?.client.disconnect();
      if (observation.request === request) observation.request = undefined;
    }
  }

  /**
   * What Sanctum's own connection showed of a device, as it added or
   * removed it, with who made it where that connection said.
   */
  function learn(mac: string, said: Said, maker?: string | null) {
    const found = announced.get(mac);
    if (!found) return;
    const observation = observationOf(found);
    observation.request = undefined;
    running.get(mac)?.controller.abort();
    if (said === "waits" || said === "closed") tookZeroKey.add(mac);
    finishAsk(observation, said === "closed");
    observation.learned = {
      said,
      maker: maker ?? observation.learned?.maker ?? null,
    };
  }

  function discoveryChanged() {
    for (const mac of tookZeroKey) {
      const found = announced.get(mac);
      if (found && beforeProvisioning(found.version) === true) {
        tookZeroKey.delete(mac);
      }
    }
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
  // which can set off what the device does when someone connects. Neither
  // is older firmware, which is asked as someone adds it.
  function schedule() {
    if (stopped) return;
    for (const found of announced.values()) {
      if (running.size >= asking) break;
      const mac = found.mac;
      if (
        found.encryption === "none" ||
        found.encryption === "older" ||
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
    /**
     * Whether a device is firmware from before ESPHome 2026.7, by what it
     * says of itself now, its record and whether it ever took the zero key.
     */
    isOlder(mac: string, info: Session["info"]) {
      if (info.apiEncryptionProvisionable === true) tookZeroKey.add(mac);
      const found = announced.get(mac);
      return (
        found !== undefined &&
        isOlderFirmware(found, info, tookZeroKey.has(mac))
      );
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

export type Found = ReturnType<typeof createFound>;
