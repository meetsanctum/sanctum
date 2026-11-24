import {
  ActionError,
  mediaPlaybacks,
  type AppContext,
  type DeviceRegistration,
  type MediaActivity,
  type MediaCommand,
  type MediaState,
} from "@meetsanctum/app-sdk";

import type {
  BoxPower,
  BoxVolume,
  Boxes,
  Endpoint,
  Picture,
  Player,
  PlayerCommand,
} from "./boxes.js";
import { createConnection, logText, type Timings } from "./connection.js";
import type { BoxKeys } from "./pairing.js";
import {
  createPlayerLink,
  type PlayerLink,
  type PlayerTimings,
} from "./player-link.js";
import { activityOf, appOf, itemOf, mediaOf } from "./playing.js";

// One added Apple TV: its Companion connection for power and volume steps,
// its player connection for what plays and playback, and the one state the
// two make, reported whole and one report at a time.
//
// Power is the last word any of them said: the player's DeviceInfo, then
// Companion where tvOS 27 tells it, then what Sanctum last turned it to.
// Both boxes flap on, off, on in the seconds after a wake, so for 30 s after
// Sanctum wakes it the player's "off" isn't taken, nor its "on" for 10 s
// after Sanctum turns it off. Asleep, the player is rested; on, or once
// Companion's media controls change, it's wanted again.
//
// A player that drops while the box is awake isn't a stop: the last state
// holds for 30 s while it's tried again. On start, what it plays is unsaid
// until the player has opened or failed, so a restart fires no "stops
// playing".

/** The media capability's id on every box. */
export const mediaId = "media";

// Steps where the box passes them on over HDMI, or none.
export type Volume = "steps" | null;

export type TvTimings = Timings &
  PlayerTimings & {
    /** How long after a wake an "off" isn't taken. */
    wakeMs: number;
    /** How long after Sanctum turns it off an "on" isn't taken. */
    sleepMs: number;
    /** How long after a wake the player is first tried. */
    wakeOpenMs: number;
    /** How long the last state holds while the player is down. */
    holdMs: number;
    /** How long a start waits to hear from the player. */
    settleMs: number;
    /** How long a new item's report waits for its picture. */
    pictureWaitMs: number;
    /** How long changes gather before a report. */
    gatherMs: number;
    /** How long a command waits for the player to open. */
    commandWaitMs: number;
  };

export const defaultTvTimings = {
  wakeMs: 30_000,
  sleepMs: 10_000,
  wakeOpenMs: 2_000,
  holdMs: 30_000,
  settleMs: 10_000,
  pictureWaitMs: 1_500,
  gatherMs: 300,
  commandWaitMs: 5_000,
};

// The most pictures kept for items that may come back, as after Previous.
const keptPictures = 8;

export function registrationOf(box: {
  key: string;
  name: string;
  model: string;
  volume: Volume;
}): DeviceRegistration {
  return {
    key: box.key,
    name: box.name,
    manufacturer: "Apple",
    model: box.model,
    type: "media-player",
    capabilities: [
      {
        id: mediaId,
        kind: "media",
        features: {
          power: true,
          playback: [...mediaPlaybacks],
          volume: box.volume,
          mute: false,
        },
      },
    ],
  };
}

/** Whether a registered capability is the one this app gives now. */
export function isCurrent(features: { playback: readonly string[] }): boolean {
  return mediaPlaybacks.every((each) => features.playback.includes(each));
}

type Companion = {
  on: boolean | null;
  power: BoxPower;
  volume: BoxVolume;
  controls: number | null;
};

type Kept = { picture: Picture; hash: string | null };

export type TvOptions = {
  ctx: AppContext;
  key: string;
  name: string;
  model: string;
  volume: Volume;
  boxes: Boxes;
  timings?: Partial<TvTimings>;
  random?: () => number;
  now?: () => number;
};

export function createTv(options: TvOptions) {
  const { ctx, key, boxes } = options;
  const timings = { ...defaultTvTimings, ...options.timings };
  const now = options.now ?? Date.now;

  const tv = {
    name: options.name,
    model: options.model,
    // The last registered volume and playback.
    volume: options.volume,
    current: true,
  };

  let stopped = false;
  let startedAt = now();
  let companion: Companion = {
    on: null,
    power: "unknown",
    volume: "unknown",
    controls: null,
  };
  // The last word on its power, from whichever said it last.
  let power: boolean | null = null;
  let wokeAt = -Infinity;
  let sleptAt = -Infinity;
  let settled = false;
  let held: MediaState | null = null;
  let droppedAt: number | null = null;
  // What the last report said, and what its item was doing.
  let reported: string | null = null;
  let before: { item: string; activity: MediaActivity } | null = null;
  let named: string | null = null;
  // Pictures by item and picture id, newest last.
  const pictures = new Map<string, Kept>();
  const tried = new Set<string>();
  let fetching: string | null = null;
  let waitingFor: { art: string; until: number } | null = null;
  let gather: NodeJS.Timeout | null = null;
  let grace: NodeJS.Timeout | null = null;
  let timer: NodeJS.Timeout | null = null;
  let updates = Promise.resolve();

  const waking = () => now() - wokeAt < timings.wakeMs;
  // As it goes to sleep, its controls change and it still says it's on for
  // a moment, which would open the player and turn it back on.
  const sleeping = () => now() - sleptAt < timings.sleepMs;

  function schedule() {
    if (stopped || gather) return;
    gather = setTimeout(() => {
      gather = null;
      updates = updates.then(publish, publish);
    }, timings.gatherMs);
  }

  // Wakes the report at a moment a hold or a wait ends.
  function wakeAt(at: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        schedule();
      },
      Math.max(0, at - now()),
    );
  }

  // What the player's DeviceInfo says flaps after a wake, so its "off"
  // isn't taken then, nor its "on" just after Sanctum turned it off;
  // Companion's word always is.
  function heard(on: boolean, from: "player" | "companion" | "sanctum") {
    if (from === "player" && (on ? sleeping() : waking())) return;
    power = on;
    connection.assume(on);
  }

  // A word that it woke: the player is tried every few seconds for a while,
  // and once that while is over, what the player says then is taken.
  function woke(from: "companion" | "sanctum", afterMs = 0) {
    wokeAt = now();
    sleptAt = -Infinity;
    heard(true, from);
    player.want({ afterMs, waking: true });
    if (grace) clearTimeout(grace);
    grace = setTimeout(() => {
      grace = null;
      const open = player.player;
      if (open && open.power === "off") {
        heard(false, "player");
        powerChanged();
        schedule();
      }
    }, timings.wakeMs);
  }

  function powerChanged() {
    if (power === false) player.rest();
    else if (power === true && !player.wanted) player.want();
  }

  const connection = createConnection({
    key,
    boxes,
    timings: options.timings,
    random: options.random,
    news: {
      online(online) {
        void ctx.devices
          .report({ key, availability: online ? "online" : "offline" })
          .catch(() => {});
      },
      state(said) {
        const was = companion;
        const wasOn = power;
        companion = said;
        if (said.power !== "unknown" && said.power !== was.power) {
          if (said.power === "on" && was.power === "off") woke("companion");
          else heard(said.power === "on", "companion");
        } else if (power === null && said.on !== null) {
          power = said.on;
        }
        // Its media controls changed, as when something starts playing
        // after its own remote woke it: the player says whether it's on.
        if (
          said.controls !== was.controls &&
          was.controls !== null &&
          !sleeping()
        ) {
          player.want();
        }
        if (power !== wasOn) powerChanged();
        schedule();
      },
      lost() {
        void ctx.devices
          .problem({ key, problem: "pairingLost" })
          .catch(() => {});
      },
      log: (message) => ctx.log(message),
    },
  });

  let lastPower: BoxPower = "unknown";
  const player: PlayerLink = createPlayerLink({
    key,
    boxes,
    timings: options.timings,
    random: options.random,
    now,
    news: {
      changed() {
        const open = player.player;
        if (open || player.failed) settled = true;
        if (open) {
          droppedAt = null;
          if (open.power !== lastPower) {
            lastPower = open.power;
            if (open.power !== "unknown") {
              heard(open.power === "on", "player");
            }
            powerChanged();
          }
        } else {
          lastPower = "unknown";
          if (player.wanted && held && droppedAt === null) {
            droppedAt = now();
            wakeAt(droppedAt + timings.holdMs);
          }
        }
        schedule();
      },
      lost() {
        void ctx.devices
          .problem({ key, problem: "pairingLost" })
          .catch(() => {});
      },
      log: (message) => ctx.log(message),
    },
  });

  // Asleep or unknown, the last registered volume holds.
  function volumeNow(): Volume | undefined {
    if (power === false) return undefined;
    if (companion.volume === "available") return "steps";
    if (companion.volume === "unavailable") return null;
    return undefined;
  }

  // The picture to name for what plays, fetching it where it's new.
  async function pictureFor(open: Player, item: string) {
    const playing = open.playing;
    if (playing.artwork === false) return undefined;
    const art = item + "|" + (playing.artworkId ?? "");
    const kept = pictures.get(art);
    if (kept) {
      // Put again where the report doesn't name it now: the core lets a
      // picture go a minute after nothing names it.
      if (kept.hash === null || kept.hash !== named) {
        try {
          kept.hash = (await ctx.blobs.put(kept.picture)).hash;
        } catch (error) {
          pictures.delete(art);
          tried.add(art);
          ctx.log(
            `Couldn't hand over the picture for ${logText(tv.name)}: ` +
              logText(error instanceof Error ? error.message : String(error)),
          );
          return undefined;
        }
      }
      return kept.hash;
    }
    if (!tried.has(art) && fetching === null) void fetch(open, art);
    if (playing.artwork === true && fetching === art) {
      if (waitingFor?.art !== art) {
        waitingFor = { art, until: now() + timings.pictureWaitMs };
        wakeAt(waitingFor.until);
      }
      if (now() < waitingFor.until) return "wait";
    }
    return undefined;
  }

  async function fetch(open: Player, art: string) {
    fetching = art;
    let picture: Picture | null = null;
    try {
      picture = await open.picture();
    } catch (error) {
      ctx.log(
        `Couldn't fetch the picture for ${logText(tv.name)}: ` +
          logText(error instanceof Error ? error.message : String(error)),
      );
    }
    fetching = null;
    // The reply doesn't say which item it's for: kept only if the same
    // item still plays.
    const still =
      player.player === open &&
      itemOf(open.playing) + "|" + (open.playing.artworkId ?? "") === art;
    if (still) {
      if (tried.size >= 64) tried.clear();
      tried.add(art);
      if (picture) {
        pictures.set(art, { picture, hash: null });
        while (pictures.size > keptPictures) {
          pictures.delete(pictures.keys().next().value!);
        }
      }
    }
    schedule();
  }

  async function register(volume: Volume) {
    try {
      await ctx.devices.register(
        registrationOf({ key, name: tv.name, model: tv.model, volume }),
      );
      tv.volume = volume;
      tv.current = true;
      reported = null;
    } catch (error) {
      ctx.log(
        `Couldn't update ${logText(tv.name)}: ` +
          logText(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async function publish() {
    if (stopped) return;
    const open = player.player;
    const volume = volumeNow();
    if ((volume !== undefined && volume !== tv.volume) || !tv.current) {
      await register(volume === undefined ? tv.volume : volume);
      if (stopped) return;
    }
    const state = await compose(open);
    if (state === null || stopped) return;
    const text = JSON.stringify(state);
    if (text === reported) return;
    try {
      await ctx.devices.report({ key, states: { [mediaId]: state } });
      reported = text;
      named = state.media?.artwork ?? null;
    } catch (error) {
      ctx.log(
        `Couldn't pass on ${logText(tv.name)}: ` +
          logText(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async function compose(open: Player | null): Promise<MediaState | null> {
    const on = power === null ? {} : { on: power };
    if (power === false) {
      held = null;
      before = null;
      return { on: false, activity: "idle", app: null, media: null };
    }
    if (!open) {
      if (held && droppedAt !== null && now() - droppedAt < timings.holdMs) {
        return { ...held, ...on };
      }
      if (!settled) {
        wakeAt(startedAt + timings.settleMs);
        if (now() - startedAt < timings.settleMs) return null;
      }
      held = null;
      before = null;
      return { ...on, activity: "idle", app: null, media: null };
    }
    const playing = open.playing;
    const item = itemOf(playing);
    const activity = activityOf(playing, before);
    const app = activity === "idle" ? null : appOf(playing);
    const media = activity === "idle" ? null : mediaOf(playing, now());
    if (media) {
      const picture = await pictureFor(open, item);
      if (picture === "wait") return null;
      if (picture) media.artwork = picture;
    }
    const state: MediaState = { ...on, activity, app, media };
    before = { item, activity };
    held = state;
    return state;
  }

  // A command that comes as the player opens, as just after a wake, waits
  // for it a little.
  async function connected() {
    const until = now() + timings.commandWaitMs;
    while (!player.player && player.wanted && !stopped && now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const open = player.player;
    if (!open) {
      throw new ActionError("conflict", `${tv.name} isn't connected`);
    }
    return open;
  }

  function check(open: Player, command: PlayerCommand) {
    if (open.can(command) === "no") {
      const app = open.playing.app?.name ?? "The app on " + tv.name;
      throw new ActionError("conflict", `${app} doesn't take that now`);
    }
  }

  async function playback(command: PlayerCommand, position?: number) {
    const open = await connected();
    check(open, command);
    await open.send(command, position);
  }

  return {
    get name() {
      return tv.name;
    },
    get model() {
      return tv.model;
    },
    get volume() {
      return tv.volume;
    },

    /** Starts both connections, with the keys pairing left. */
    start(keys: BoxKeys | null, pairedAt: Endpoint | null = null) {
      startedAt = now();
      connection.start(keys?.companion ?? null, pairedAt);
      player.start(keys?.airplay ?? null, pairedAt);
    },

    /** Registers it again on start where its playback is out of date. */
    outdated() {
      tv.current = false;
    },

    seen(at: Endpoint | null, name?: string, model?: string) {
      if (name) tv.name = name;
      if (model) tv.model = model;
      connection.seen(at);
      player.seen(at);
    },

    rekey(keys: BoxKeys, at: Endpoint) {
      connection.rekey(keys.companion, at);
      player.rekey(keys.airplay, at);
    },

    async command(command: MediaCommand) {
      if ("on" in command) {
        await connection.power(command.on);
        if (command.on) {
          woke("sanctum", timings.wakeOpenMs);
        } else {
          wokeAt = -Infinity;
          sleptAt = now();
          if (grace) clearTimeout(grace);
          heard(false, "sanctum");
          player.rest();
        }
        schedule();
        return;
      }
      if ("volumeStep" in command) {
        await connection.volume(command.volumeStep);
        return;
      }
      if ("activity" in command) {
        const open = await connected();
        const playing = command.activity === "playing";
        // Already so: nothing to send.
        if (open.playing.state === (playing ? "playing" : "paused")) return;
        check(open, playing ? "play" : "pause");
        await open.send(playing ? "play" : "pause");
        return;
      }
      if ("playback" in command) return playback(command.playback);
      if ("position" in command) return playback("seek", command.position);
      throw new ActionError("not_found", "It takes no such command");
    },

    async stop() {
      stopped = true;
      if (gather) clearTimeout(gather);
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      connection.stop();
      player.stop();
      await updates;
    },
  };
}

export type Tv = ReturnType<typeof createTv>;
