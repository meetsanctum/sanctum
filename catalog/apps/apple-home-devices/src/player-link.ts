import {
  PairingLost,
  type Boxes,
  type Endpoint,
  type Keys,
  type Player,
} from "./boxes.js";
import { logText } from "./connection.js";

// One added box's player connection, MRP over AirPlay, for what it plays.
// It is kept open only while the box is awake: an MRP session goes silent
// once the box sleeps and stays silent after it wakes, so the driver rests
// it on sleep and wants it again on a wake, which opens a fresh one.
//
// While wanted, a drop is tried again at once, then after 15 s, doubling up
// to 5 minutes, each spread by up to a third. Wanted after a wake, it tries
// every few seconds for 30 s while the box comes up. One open runs at a
// time. Its failures never make the box offline: that is Companion's to say.

export type PlayerTimings = {
  firstRetryMs: number;
  lastRetryMs: number;
  /** How long a wake keeps trying, and how often. */
  wakeTriesMs: number;
  wakeRetryMs: number;
};

export const defaultPlayerTimings: PlayerTimings = {
  firstRetryMs: 15_000,
  lastRetryMs: 300_000,
  wakeTriesMs: 30_000,
  wakeRetryMs: 3_000,
};

export type PlayerNews = {
  /** It opened, closed, failed, or its player said something changed. */
  changed(): void;
  /** The box no longer knows AirPlay's keys. */
  lost(): void;
  log(message: string): void;
};

export type PlayerLinkOptions = {
  key: string;
  boxes: Boxes;
  news: PlayerNews;
  timings?: Partial<PlayerTimings>;
  random?: () => number;
  now?: () => number;
};

const sameAddress = (a: Endpoint | null, b: Endpoint | null) =>
  a?.address === b?.address && a?.airplayPort === b?.airplayPort;

export function createPlayerLink(options: PlayerLinkOptions) {
  const { boxes, news } = options;
  const timings = { ...defaultPlayerTimings, ...options.timings };
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  let endpoint: Endpoint | null = null;
  let keys: Keys | null = null;
  let player: Player | null = null;
  let opening = false;
  let generation = 0;
  let stopped = true;
  let lost = false;
  // Whether it is kept open: false while the box sleeps.
  let wanted = false;
  // Until when a wake tries every few seconds.
  let wakeUntil = 0;
  let failures = 0;
  // Whether the last open failed, so nothing is known of what plays.
  let failed = false;
  let retry: NodeJS.Timeout | null = null;

  function clear() {
    if (retry) clearTimeout(retry);
    retry = null;
  }

  function later(soon = false) {
    clear();
    if (stopped || lost || !wanted) return;
    let wait: number;
    if (now() < wakeUntil) {
      wait = timings.wakeRetryMs;
    } else if (soon) {
      wait = 0;
    } else {
      const base = Math.min(
        timings.firstRetryMs * 2 ** failures,
        timings.lastRetryMs,
      );
      wait = base * (1 + (random() * 2 - 1) / 3);
      failures += 1;
    }
    retry = setTimeout(() => {
      retry = null;
      void open();
    }, wait);
  }

  async function open() {
    if (stopped || lost || !wanted || opening || player || !endpoint || !keys)
      return;
    opening = true;
    const attempt = generation;
    const at = endpoint;
    const current = () => !stopped && !lost && attempt === generation;
    let opened: Player | undefined;
    try {
      opened = await boxes.play(at, keys);
    } catch (error) {
      opening = false;
      if (!current()) {
        void open();
        return;
      }
      news.log(
        "Couldn't reach the player of " +
          logText(at.name) +
          ": " +
          logText(error instanceof Error ? error.message : String(error)),
      );
      if (error instanceof PairingLost) {
        lost = true;
        news.lost();
        return;
      }
      failed = true;
      news.changed();
      later();
      return;
    }
    opening = false;
    if (!current() || !wanted) {
      opened.close();
      void open();
      return;
    }
    player = opened;
    failures = 0;
    failed = false;
    clear();
    opened.on("change", () => {
      if (player === opened) news.changed();
    });
    opened.on("close", () => {
      if (player !== opened) return;
      player = null;
      news.changed();
      later(true);
    });
    news.changed();
  }

  function drop() {
    const was = player;
    player = null;
    was?.close();
  }

  return {
    get player() {
      return player;
    },

    /** Whether its last try failed and it isn't open. */
    get failed() {
      return failed && !player;
    },

    /** Whether it's kept open, as while the box is awake. */
    get wanted() {
      return wanted;
    },

    /** Starts with these keys, wanted until the box says it sleeps. */
    start(withKeys: Keys | null, at: Endpoint | null = null) {
      stopped = false;
      keys = withKeys;
      if (at) endpoint = at;
      generation += 1;
      lost = keys === null;
      wanted = true;
      void open();
    },

    seen(at: Endpoint | null) {
      if (!at) return;
      const moved = !sameAddress(at, endpoint);
      endpoint = at;
      if (!moved || stopped) return;
      generation += 1;
      failures = 0;
      drop();
      clear();
      void open();
    },

    /** Takes new keys, as after a repair. */
    rekey(withKeys: Keys, at: Endpoint) {
      keys = withKeys;
      endpoint = at;
      generation += 1;
      lost = false;
      failures = 0;
      drop();
      clear();
      if (!stopped) void open();
    },

    /**
     * The box is on, or something plays: open it, after `afterMs`, and
     * keep trying every few seconds for a while if `waking`.
     */
    want({ afterMs = 0, waking = false } = {}) {
      if (stopped || lost) return;
      const was = wanted;
      wanted = true;
      if (waking) wakeUntil = now() + afterMs + timings.wakeTriesMs;
      if (player || opening) return;
      if (was && retry && !waking) return;
      failures = 0;
      clear();
      retry = setTimeout(() => {
        retry = null;
        void open();
      }, afterMs);
    },

    /** The box sleeps: closes it, and tries nothing until it's wanted. */
    rest() {
      if (!wanted) return;
      wanted = false;
      wakeUntil = 0;
      generation += 1;
      clear();
      drop();
      news.changed();
    },

    stop() {
      stopped = true;
      generation += 1;
      clear();
      drop();
    },
  };
}

export type PlayerLink = ReturnType<typeof createPlayerLink>;
