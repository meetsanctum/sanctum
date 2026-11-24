import {
  PairingLost,
  type BoxVolume,
  type Boxes,
  type Endpoint,
  type Keys,
  type Link,
} from "./boxes.js";

// One added box's Companion connection, kept open while the app runs: it
// opens once the box is seen, and after a drop it tries again after 15 s,
// then after doubling waits up to 5 minutes, each spread by up to a third
// either way so boxes that dropped together don't come back in step. A new
// address is tried at once, keeping the current link until it verifies.
// Without a connection for 30 s the box is offline. A box that no longer
// knows Sanctum's keys stops being tried until it's paired again.
//
// Power comes from the box where it tells it (tvOS 27 answers; tvOS 26
// doesn't). Where it doesn't, the box is taken to be what Sanctum last
// turned it to, and nothing is said of it before that.

export type Timings = {
  /** How long without a connection before the box is offline. */
  offlineMs: number;
  /** The first wait before trying again, and the longest. */
  firstRetryMs: number;
  lastRetryMs: number;
};

export const defaultTimings: Timings = {
  offlineMs: 30_000,
  firstRetryMs: 15_000,
  lastRetryMs: 300_000,
};

/** What the connection says of the box, for the driver to pass on. */
export type BoxNews = {
  online(online: boolean): void;
  /** Its power, or null where it's not known, and whether it takes volume steps. */
  state(state: { on: boolean | null; volume: BoxVolume }): void;
  /** It no longer knows Sanctum's keys. */
  lost(): void;
  log(message: string): void;
};

export type ConnectionOptions = {
  key: string;
  boxes: Boxes;
  news: BoxNews;
  timings?: Partial<Timings>;
  /** A number in [0, 1), for spreading the waits. */
  random?: () => number;
};

function sameAddress(a: Endpoint | null, b: Endpoint | null) {
  return (
    a?.companionAddress === b?.companionAddress &&
    a?.companionPort === b?.companionPort
  );
}

export function logText(text: string) {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => "\\u{" + character.codePointAt(0)!.toString(16) + "}",
  );
}

export function createConnection(options: ConnectionOptions) {
  const { boxes, news } = options;
  const timings = { ...defaultTimings, ...options.timings };
  const random = options.random ?? Math.random;

  let endpoint: Endpoint | null = null;
  let verified: Endpoint | null = null;
  let keys: Keys | null = null;
  let link: Link | null = null;
  let connecting = false;
  let generation = 0;
  let stopped = true;
  let lost = false;
  let failures = 0;
  let retry: NodeJS.Timeout | null = null;
  let offline: NodeJS.Timeout | null = null;
  // What Sanctum last turned it to, for a box that doesn't say.
  let assumed: boolean | null = null;

  function clear(timer: NodeJS.Timeout | null) {
    if (timer) clearTimeout(timer);
    return null;
  }

  function goingOffline() {
    if (offline || stopped) return;
    offline = setTimeout(() => {
      offline = null;
      if (!link && !stopped) news.online(false);
    }, timings.offlineMs);
  }

  function say() {
    if (!link) return;
    const on =
      link.power === "on" ? true : link.power === "off" ? false : assumed;
    news.state({ on, volume: link.volume });
  }

  function later() {
    retry = clear(retry);
    if (stopped || lost) return;
    const base = Math.min(
      timings.firstRetryMs * 2 ** failures,
      timings.lastRetryMs,
    );
    const spread = 1 + (random() * 2 - 1) / 3;
    failures += 1;
    retry = setTimeout(() => {
      retry = null;
      void open(verified ?? endpoint);
    }, base * spread);
  }

  async function open(at: Endpoint | null) {
    if (
      stopped ||
      lost ||
      connecting ||
      !at ||
      !keys ||
      (link && sameAddress(at, verified))
    ) {
      return;
    }
    connecting = true;
    const attempt = generation;
    const withKeys = keys;
    const current = () => !stopped && !lost && attempt === generation;
    let opened: Link | undefined;
    let pairingRejected = false;
    // If the first address fails, try the other one before reporting a
    // lost pairing. Only a rejection at the known address counts once
    // an address has been verified.
    const other = sameAddress(at, verified) ? endpoint : verified;
    for (const address of [at, sameAddress(at, other) ? null : other]) {
      if (!current() || !address) break;
      if (link && sameAddress(address, verified)) break;
      try {
        opened = await boxes.connect(address, withKeys);
      } catch (error) {
        if (!current()) break;
        if (
          error instanceof PairingLost &&
          (!verified || sameAddress(address, verified))
        ) {
          pairingRejected = true;
        }
        news.log(
          "Couldn't reach " +
            logText(address.name) +
            ": " +
            logText(error instanceof Error ? error.message : String(error)),
        );
        continue;
      }
      if (current()) verified = address;
      break;
    }
    connecting = false;
    if (!current()) {
      opened?.close();
      void open(endpoint);
      return;
    }
    if (!opened) {
      if (link) return;
      if (pairingRejected) {
        lost = true;
        news.lost();
      } else {
        later();
      }
      return;
    }
    const was = link;
    link = opened;
    was?.close();
    failures = 0;
    retry = clear(retry);
    offline = clear(offline);
    if (opened.power !== "unknown") assumed = null;
    opened.on("change", () => {
      if (link === opened) say();
    });
    opened.on("close", () => {
      if (link !== opened) return;
      link = null;
      if (stopped) return;
      later();
      goingOffline();
    });
    news.online(true);
    say();
  }

  return {
    get connected() {
      return link !== null;
    },

    /** Starts keeping the connection open with these keys. */
    start(withKeys: Keys | null, pairedAt: Endpoint | null = null) {
      stopped = false;
      keys = withKeys;
      verified = pairedAt;
      generation += 1;
      lost = keys === null;
      goingOffline();
      void open(verified ?? endpoint);
    },

    /** Where the box is now, or null once it's no longer announced. */
    seen(now: Endpoint | null) {
      if (!now) return;
      const moved = !sameAddress(now, endpoint);
      endpoint = now;
      if (!moved || stopped) return;
      generation += 1;
      failures = 0;
      retry = clear(retry);
      void open(endpoint);
    },

    /** Takes new keys, as after a repair, and connects with them. */
    rekey(withKeys: Keys, pairedAt: Endpoint) {
      keys = withKeys;
      endpoint = pairedAt;
      verified = pairedAt;
      generation += 1;
      lost = false;
      failures = 0;
      retry = clear(retry);
      if (link) {
        const was = link;
        link = null;
        was.close();
      }
      goingOffline();
      void open(endpoint);
    },

    /** Turns the box on or off. */
    async power(on: boolean) {
      const now = connected();
      await (on ? now.wake() : now.sleep());
      if (link === now && now.power === "unknown") {
        assumed = on;
        say();
      }
    },

    async volume(step: "up" | "down") {
      const now = connected();
      await (step === "up" ? now.volumeUp() : now.volumeDown());
    },

    stop() {
      stopped = true;
      generation += 1;
      retry = clear(retry);
      offline = clear(offline);
      const was = link;
      link = null;
      was?.close();
    },
  };

  function connected() {
    if (!link)
      throw new Error(`${endpoint?.name ?? options.key} isn't connected`);
    return link;
  }
}

export type Connection = ReturnType<typeof createConnection>;
