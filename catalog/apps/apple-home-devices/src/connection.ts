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
// either way so boxes that dropped together don't come back in step. A box
// seen at a new address is tried at once. Without a connection for 30 s it
// is offline. A box that no longer knows Sanctum's keys stops being tried
// until it's paired again.
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

export function createConnection(options: ConnectionOptions) {
  const { boxes, news } = options;
  const timings = { ...defaultTimings, ...options.timings };
  const random = options.random ?? Math.random;

  let endpoint: Endpoint | null = null;
  let keys: Keys | null = null;
  let link: Link | null = null;
  let connecting = false;
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
      void open();
    }, base * spread);
  }

  async function open() {
    if (stopped || lost || link || connecting || !endpoint || !keys) return;
    connecting = true;
    const at = endpoint;
    let opened: Link;
    try {
      opened = await boxes.connect(at, keys);
    } catch (error) {
      connecting = false;
      if (stopped) return;
      if (error instanceof PairingLost) {
        lost = true;
        news.lost();
        return;
      }
      news.log(`Couldn't reach ${at.name}: ${(error as Error).message}`);
      later();
      return;
    }
    connecting = false;
    if (stopped || lost) {
      opened.close();
      return;
    }
    link = opened;
    failures = 0;
    retry = clear(retry);
    offline = clear(offline);
    if (opened.power !== "unknown") assumed = null;
    opened.on("change", () => {
      if (link === opened) say();
    });
    opened.on("close", (error) => {
      if (link !== opened) return;
      link = null;
      if (stopped) return;
      if (error instanceof PairingLost) {
        lost = true;
        news.lost();
        return;
      }
      goingOffline();
      later();
    });
    news.online(true);
    say();
  }

  return {
    get connected() {
      return link !== null;
    },

    /** Starts keeping the connection open with these keys. */
    start(withKeys: Keys | null) {
      stopped = false;
      keys = withKeys;
      lost = keys === null;
      goingOffline();
      void open();
    },

    /** Where the box is now, or null once it's no longer announced. */
    seen(now: Endpoint | null) {
      const moved =
        now !== null &&
        (endpoint === null ||
          now.companionAddress !== endpoint.companionAddress ||
          now.companionPort !== endpoint.companionPort);
      endpoint = now ?? endpoint;
      if (!moved || stopped) return;
      // A new address is tried at once, dropping a link to the old one.
      if (link) {
        const was = link;
        link = null;
        was.close();
        goingOffline();
      }
      failures = 0;
      retry = clear(retry);
      void open();
    },

    /** Takes new keys, as after a repair, and connects with them. */
    rekey(withKeys: Keys) {
      keys = withKeys;
      lost = false;
      failures = 0;
      retry = clear(retry);
      if (link) {
        const was = link;
        link = null;
        was.close();
      }
      void open();
    },

    /** Turns the box on or off. */
    async power(on: boolean) {
      const now = connected();
      await (on ? now.wake() : now.sleep());
      if (now.power === "unknown") {
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
