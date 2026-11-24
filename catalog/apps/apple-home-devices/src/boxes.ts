import { EventEmitter } from "node:events";

import { maxBlobBytes } from "@meetsanctum/app-sdk";
import {
  AppleTV,
  CompanionPairSetup,
  Credentials,
  MediaSubType,
  MediaType,
  PairSetup,
  PlaybackState,
  PowerState,
  type CompanionEvent,
  type FeatureAvailability,
  type HAPCredentials,
  type Message,
  type NowPlayingInfo,
} from "node-appletv-remote";

// The one module that speaks to Apple TVs: pairing with a code on the
// screen, over AirPlay and over Companion, a Companion connection for power
// and volume, and a player connection, MRP over AirPlay, for what plays. It goes through node-appletv-remote, whose errors are
// plain messages, and turns those it knows into errors of its own, so the
// rest of the app and its tests never see the library.

/** Where one box is reached, from what it announces. */
export type Endpoint = {
  /** Its AirPlay device id, its MAC address in capitals. */
  deviceId: string;
  /** Its name in tvOS. */
  name: string;
  /** Its model, as AirPlay announces it: "AppleTV14,1". */
  model: string;
  address: string;
  airplayPort: number;
  companionAddress: string;
  companionPort: number;
};

/** What a pairing leaves for later connections: long-term keys, in hex. */
export type Keys = {
  clientId: string;
  clientLTSK: string;
  clientLTPK: string;
  serverLTPK: string;
  serverId: string;
};

/** A pairing whose code is on the box's screen. */
export interface Pairing {
  /** Finishes it with the code, which closes it either way. */
  finish(code: string): Promise<Keys>;
  close(): void;
}

/** Whether the box says it's on, and whether it takes volume up and down. */
export type BoxPower = "on" | "off" | "unknown";
export type BoxVolume = "available" | "unavailable" | "unknown";

/** A connection to one box, for its power and volume. */
export interface Link {
  readonly power: BoxPower;
  readonly volume: BoxVolume;
  /**
   * Its media controls, as flags, or null before it says: they change as
   * something starts, pauses or stops playing, and stay for a paused item
   * while the box sleeps.
   */
  readonly controls: number | null;
  /** Something it says changed: its power, its volume or its controls. */
  on(event: "change", listener: () => void): this;
  /** Either side closed the connection. */
  on(event: "close", listener: () => void): this;
  wake(): Promise<void>;
  sleep(): Promise<void>;
  volumeUp(): Promise<void>;
  volumeDown(): Promise<void>;
  close(): void;
}

/** What the box says of its player's state, as it reports it. */
export type PlayerState =
  "playing" | "paused" | "stopped" | "seeking" | "unknown";

/** What the box says is playing, its words empty where it says none. */
export type Playing = {
  state: PlayerState;
  /** The app that plays: its bundle id and its name. */
  app: { id: string; name: string } | null;
  title: string;
  artist: string;
  album: string;
  series: string;
  season?: number;
  episode?: number;
  contentId?: string;
  uniqueId?: string;
  kind?: "music" | "audio" | "video";
  duration?: number;
  /** Where it was, in seconds, at `positionAt`, in ms since 1970. */
  position?: number;
  positionAt?: number;
  /** Whether it says the item has a picture, and the picture's id. */
  artwork?: boolean;
  artworkId?: string;
};

export type PlayerRequest =
  | [command: "play" | "pause" | "stop" | "next" | "previous"]
  | [command: "seek", position: number];

export type PlayerCommand = PlayerRequest[0];
export type PlayerClose = "closed" | "sleep";

export type Picture = {
  type: "image/jpeg" | "image/png" | "image/webp";
  data: Uint8Array;
};

/** A connection to one box's player: what plays, and playback. */
export interface Player {
  /** Whether it's on, as the box tells each session. */
  readonly power: BoxPower;
  readonly playing: Playing;
  /** Something it says changed. */
  on(event: "change", listener: () => void): this;
  /** Either side closed it, or the box ended it on going to sleep. */
  on(event: "close", listener: (reason: PlayerClose) => void): this;
  /** Whether the app that plays takes the command now, where it says. */
  can(command: PlayerCommand): "yes" | "no" | "unknown";
  send(...request: PlayerRequest): Promise<void>;
  /** The playing item's picture, about 600 px wide, or null. */
  picture(): Promise<Picture | null>;
  close(): void;
}

/** What pairs with and connects to boxes; tests stand a fake box in for it. */
export interface Boxes {
  /** Asks the box to show AirPlay's code, and holds the pairing open. */
  pairAirPlay(box: Endpoint): Promise<Pairing>;
  /** Asks the box to show Companion's code, naming Sanctum on it. */
  pairCompanion(box: Endpoint): Promise<Pairing>;
  connect(box: Endpoint, keys: Keys): Promise<Link>;
  /** Opens the player with AirPlay's keys. */
  play(box: Endpoint, keys: Keys): Promise<Player>;
}

/** The code didn't match what the box showed. */
export class WrongCode extends Error {
  override name = "WrongCode";
}

/** The box took the code away before it was entered. */
export class CodeExpired extends Error {
  override name = "CodeExpired";
}

/** The box refused to pair at all, as its AirPlay access settings decide. */
export class NotAllowed extends Error {
  override name = "NotAllowed";
}

/** The box couldn't be reached. */
export class Unreachable extends Error {
  override name = "Unreachable";
}

/** The box no longer knows Sanctum's keys. */
export class PairingLost extends Error {
  override name = "PairingLost";
}

/** The box signalled sleep while the player was opening. */
export class PlayerSleeping extends Error {
  override name = "PlayerSleeping";
}

// What the box calls itself on the pairings it lists.
const pairingName = "Sanctum";

// HAP's TLV error 2, Authentication: a wrong code in pair-setup's M4, and
// keys the box doesn't know in pair-verify's M4, AirPlay's or Companion's,
// both of which Repair pairs again. A box whose identity was reset also
// fails the signature check in M2.
const wrongCodeMessage = /M4 missing Proof \(error=2\)/;
const lostMessage =
  /pair-verify M4 error: 2\b|^Companion server signature verification failed$/i;
const expiredMessage = /PIN expired/;
// /pair-pin-start refused: the box's AirPlay access setting allows no
// pairing from here.
const refusedMessage = /^HTTP (401|403|470) /;
const unreachableCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
]);

/** The library's error as one of ours, where it is one we know. */
export function errorOf(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { message } = error;
  if (wrongCodeMessage.test(message)) return new WrongCode(message);
  if (lostMessage.test(message)) return new PairingLost(message);
  if (expiredMessage.test(message)) return new CodeExpired(message);
  if (refusedMessage.test(message)) return new NotAllowed(message);
  const code = (error as NodeJS.ErrnoException).code;
  if (
    (code !== undefined && unreachableCodes.has(code)) ||
    /timed? ?out/i.test(message)
  ) {
    return new Unreachable(message);
  }
  return error;
}

async function translated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw errorOf(error);
  }
}

const hex = (keys: HAPCredentials): Keys => ({
  clientId: keys.clientId,
  clientLTSK: keys.clientLTSK.toString("hex"),
  clientLTPK: keys.clientLTPK.toString("hex"),
  serverLTPK: keys.serverLTPK.toString("hex"),
  serverId: keys.serverId,
});

const bytes = (keys: Keys): HAPCredentials => ({
  clientId: keys.clientId,
  clientLTSK: Buffer.from(keys.clientLTSK, "hex"),
  clientLTPK: Buffer.from(keys.clientLTPK, "hex"),
  serverLTPK: Buffer.from(keys.serverLTPK, "hex"),
  serverId: keys.serverId,
});

function pairing(setup: PairSetup | CompanionPairSetup): Pairing {
  return {
    finish: (code) => translated(async () => hex(await setup.finish(code))),
    close: () => setup.destroy(),
  };
}

// Volume up and down are known missing only where the box says what else
// its media controls offer: with nothing playing it may say nothing at all.
function volumeOf(tv: AppleTV): BoxVolume {
  const volume = tv.featureAvailability("volumeUp");
  if (volume === "supported") return "available";
  if (volume !== "unavailable") return "unknown";
  const others = ["play", "pause", "next", "previous"] as const;
  return others.some((each) => tv.featureAvailability(each) === "supported")
    ? "unavailable"
    : "unknown";
}

const powerOf = (state: PowerState): BoxPower =>
  state === PowerState.On ? "on" : state === PowerState.Off ? "off" : "unknown";

class CompanionLink extends EventEmitter implements Link {
  power: BoxPower = "unknown";
  volume: BoxVolume = "unknown";
  controls: number | null = null;
  private closed = false;

  constructor(private readonly tv: AppleTV) {
    super();
    tv.on("powerState", (state: PowerState) => {
      const power = powerOf(state);
      if (power === this.power || this.closed) return;
      this.power = power;
      this.emit("change");
    });
    tv.on("featureAvailability", () => {
      const volume = volumeOf(tv);
      if (volume === this.volume || this.closed) return;
      this.volume = volume;
      this.emit("change");
    });
    tv.on("companionEvent", (event: CompanionEvent) => {
      if (event.identifier !== "_iMC" || this.closed) return;
      const content = event.data.get("_c");
      const flags = content instanceof Map ? content.get("_mcF") : undefined;
      const controls = typeof flags === "number" ? flags : 0;
      if (controls === this.controls) return;
      this.controls = controls;
      this.emit("change");
    });
    tv.on("companionClose", () => this.end());
  }

  async start() {
    this.tv.subscribePowerState();
    // tvOS 26 has no handler for this, and tells power only by its events,
    // if at all.
    const power = await this.tv.fetchPowerState().catch(() => null);
    if (this.closed) throw new Unreachable("Companion closed during setup");
    if (power) this.power = powerOf(power);
    this.volume = volumeOf(this.tv);
  }

  private end() {
    if (this.closed) return;
    this.closed = true;
    void this.tv.close();
    this.emit("close");
  }

  wake = () => translated(() => this.tv.wake());
  sleep = () => translated(() => this.tv.suspend());
  volumeUp = () => translated(() => this.tv.volumeUp());
  volumeDown = () => translated(() => this.tv.volumeDown());

  close() {
    this.end();
  }
}

// MRP's timestamps count seconds from 2001, Apple's epoch.
const appleEpochMs = Date.UTC(2001, 0, 1);

const stateOf = (state: PlaybackState): PlayerState =>
  state === PlaybackState.Playing
    ? "playing"
    : state === PlaybackState.Paused || state === PlaybackState.Interrupted
      ? "paused"
      : state === PlaybackState.Stopped
        ? "stopped"
        : state === PlaybackState.Seeking
          ? "seeking"
          : "unknown";

function kindOf(info: NowPlayingInfo): Playing["kind"] {
  if (info.mediaType === MediaType.Video) return "video";
  if (info.mediaType !== MediaType.Audio) return undefined;
  return info.mediaSubType === MediaSubType.Music ? "music" : "audio";
}

const finite = (value: number) => (Number.isFinite(value) ? value : undefined);

function playingOf(info: NowPlayingInfo): Playing {
  // The TV app reports Playing at rate 0 after a seek. Other apps can
  // report the same combination when paused, so use the library's state.
  const state = stateOf(
    info.appBundleIdentifier === "com.apple.TVWatchList"
      ? info.reportedPlaybackState
      : info.playbackState,
  );
  const at =
    info.hasElapsedTime && info.timestamp > 0
      ? appleEpochMs + info.timestamp * 1000
      : undefined;
  return {
    state,
    app: info.appBundleIdentifier
      ? {
          id: info.appBundleIdentifier,
          name: info.appDisplayName || info.appBundleIdentifier,
        }
      : null,
    title: info.title,
    artist: info.artist,
    album: info.album,
    series: info.seriesName,
    season: info.seasonNumber,
    episode: info.episodeNumber,
    contentId: info.contentIdentifier,
    uniqueId: info.uniqueIdentifier,
    kind: kindOf(info),
    duration: info.hasDuration ? finite(info.duration) : undefined,
    position: info.hasElapsedTime ? finite(info.elapsedTime) : undefined,
    positionAt: at !== undefined && Number.isFinite(at) ? at : undefined,
    artwork: info.artworkAvailable,
    artworkId: info.artworkIdentifier,
  };
}

const nothingPlaying: Playing = {
  state: "unknown",
  app: null,
  title: "",
  artist: "",
  album: "",
  series: "",
};

// MRP's SetConnectionState: 3 is the box ending the session as it sleeps.
const setConnectionState = 38;
const disconnected = 3;

/** A picture's type from its first bytes, or null where it's none we send. */
export function pictureTypeOf(data: Uint8Array): Picture["type"] | null {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  const ascii = (at: number) =>
    String.fromCharCode(...data.subarray(at, at + 4));
  if (ascii(0) === "RIFF" && ascii(8) === "WEBP") return "image/webp";
  return null;
}

const features = {
  play: "play",
  pause: "pause",
  stop: "stop",
  next: "next",
  previous: "previous",
  seek: "setPosition",
} as const;

class MrpPlayer extends EventEmitter implements Player {
  power: BoxPower = "unknown";
  playing: Playing = nothingPlaying;
  private closed: PlayerClose | null = null;

  constructor(private readonly tv: AppleTV) {
    super();
    const changed = () => {
      if (!this.closed) this.emit("change");
    };
    tv.on("powerState", (state: PowerState) => {
      this.power = powerOf(state);
      changed();
    });
    tv.on("message", (message: Message) => {
      if (message.type !== setConnectionState) return;
      const payload = message.payload as {
        ".setConnectionStateMessage"?: { state?: number };
      };
      if (payload[".setConnectionStateMessage"]?.state === disconnected) {
        this.end("sleep");
      }
    });
    tv.on("nowPlaying", (info: NowPlayingInfo) => {
      this.playing = playingOf(info);
      changed();
    });
    tv.on("featureAvailability", changed);
    tv.on("close", () => this.end());
  }

  async start() {
    this.playing = playingOf(await this.tv.getNowPlaying());
    if (this.closed) throw new Unreachable("The player closed during setup");
  }

  get sleeping() {
    return this.closed === "sleep";
  }

  can(command: PlayerCommand) {
    const said: FeatureAvailability = this.tv.featureAvailability(
      features[command],
    );
    return said === "supported" ? "yes" : said === "unknown" ? "unknown" : "no";
  }

  send(...[command, position]: PlayerRequest) {
    return translated(() => {
      switch (command) {
        case "play":
          return this.tv.play();
        case "pause":
          return this.tv.pause();
        case "stop":
          return this.tv.stop();
        case "next":
          return this.tv.next();
        case "previous":
          return this.tv.previous();
        case "seek":
          return this.tv.setPosition(position);
      }
    });
  }

  picture() {
    return translated(async () => {
      const bytes = await this.tv.requestArtwork(600, 600);
      if (!bytes || bytes.byteLength > maxBlobBytes) return null;
      const data = new Uint8Array(bytes);
      const type = pictureTypeOf(data);
      return type ? { type, data } : null;
    });
  }

  private end(reason: PlayerClose = "closed") {
    if (this.closed) return;
    this.closed = reason;
    this.emit("close", reason);
    void this.tv.close();
  }

  close() {
    this.end();
  }
}

/** Boxes on the home's network, through node-appletv-remote. */
export function createBoxes(): Boxes {
  const tvOf = (box: Endpoint) =>
    new AppleTV({
      name: box.name,
      deviceId: box.deviceId,
      model: box.model,
      address: box.address,
      port: box.airplayPort,
      companionAddress: box.companionAddress,
      companionPort: box.companionPort,
    });

  return {
    pairAirPlay: (box) =>
      translated(async () => {
        const setup = new PairSetup(box.address, box.airplayPort);
        try {
          await setup.start();
        } catch (error) {
          setup.destroy();
          throw error;
        }
        return pairing(setup);
      }),

    pairCompanion: (box) =>
      translated(async () => {
        const setup = new CompanionPairSetup(
          box.companionAddress,
          box.companionPort,
          { name: pairingName },
        );
        try {
          await setup.start();
        } catch (error) {
          setup.destroy();
          throw error;
        }
        return pairing(setup);
      }),

    connect: (box, keys) =>
      translated(async () => {
        const tv = tvOf(box);
        const link = new CompanionLink(tv);
        try {
          await tv.connectCompanion(bytes(keys), box.companionPort);
          await link.start();
        } catch (error) {
          void tv.close();
          throw error;
        }
        return link;
      }),
    play: (box, keys) =>
      translated(async () => {
        const tv = tvOf(box);
        const player = new MrpPlayer(tv);
        const credentials = bytes(keys);
        try {
          // MRP over AirPlay only; Companion stays on its own connection.
          await tv.connect(new Credentials(credentials, credentials));
          await player.start();
        } catch (error) {
          void tv.close();
          if (player.sleeping) {
            throw new PlayerSleeping("The TV slept during player setup");
          }
          throw error;
        }
        return player;
      }),
  };
}
