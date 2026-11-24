import { EventEmitter } from "node:events";

import type { Sighting } from "@meetsanctum/app-sdk";

import {
  CodeExpired,
  NotAllowed,
  PairingLost,
  Unreachable,
  WrongCode,
  type BoxPower,
  type BoxVolume,
  type Boxes,
  type Endpoint,
  type Keys,
  type Link,
  type Pairing,
  type Picture,
  type Player,
  type PlayerClose,
  type PlayerCommand,
  type PlayerRequest,
  type Playing,
} from "../src/boxes.js";

// Apple TVs for the tests, standing in for node-appletv-remote: each shows a
// code for every pairing it opens, knows the keys it handed out, and keeps
// the connections made to it, Companion's and its players, which a test can
// drop, sleep or wake, and play something on.

type Protocol = "airplay" | "companion";

export type FakeBoxOptions = {
  deviceId: string;
  name: string;
  model?: string;
  host?: string;
  address?: string;
};

let codes = 1000;

export class FakeBox {
  readonly deviceId: string;
  readonly name: string;
  readonly model: string;
  readonly host: string;
  readonly address: string;
  /** The code on screen for each protocol's open pairing. */
  readonly showing = new Map<Protocol, string>();
  /** How many of its pairings are open now. */
  open = 0;
  /** The client ids it knows, by protocol. */
  readonly known = new Map<Protocol, Set<string>>([
    ["airplay", new Set()],
    ["companion", new Set()],
  ]);
  readonly links: FakeLink[] = [];
  /** What it was told, in order: "wake", "sleep", "up", "down". */
  readonly pressed: string[] = [];
  reachable = true;
  allowsPairing = true;
  /** Whether it tells its power, as tvOS 27 does and tvOS 26 doesn't. */
  tellsPower = true;
  on = true;
  volume: BoxVolume = "available";
  readonly endpoints: Endpoint[] = [];
  /** Its players, open now, and how many were opened in all. */
  readonly players: FakePlayer[] = [];
  playersOpened = 0;
  /** Whether its player can be reached, apart from Companion. */
  playerReachable = true;
  playerAttempts = 0;
  playerHold: Promise<void> | null = null;
  /** What plays, as its player says it. */
  playing: Playing = { ...nothing };
  /** What the app that plays takes, where not every command. */
  readonly takes = new Map<PlayerCommand, "yes" | "no" | "unknown">();
  /** What its players were told, in order: "play", "seek 30". */
  readonly sent: string[] = [];
  /** The picture of what plays, and a hold on handing it over. */
  picture: Picture | null = null;
  pictureHold: Promise<void> | null = null;
  pictures = 0;
  private clients = 0;

  constructor(options: FakeBoxOptions) {
    this.deviceId = options.deviceId;
    this.name = options.name;
    this.model = options.model ?? "AppleTV14,1";
    this.host = options.host ?? `${options.name.replace(/\W/g, "-")}.local`;
    this.address = options.address ?? "192.168.1.40";
  }

  get key() {
    return this.deviceId.toLowerCase();
  }

  get connects() {
    return this.endpoints.length;
  }

  /** What it announces, AirPlay and Companion. */
  sightings(): Sighting[] {
    return [
      {
        service: "_airplay._tcp",
        name: this.name,
        host: this.host,
        addresses: [this.address],
        port: 7000,
        txt: { deviceid: this.deviceId, model: this.model, features: "0x1" },
      },
      {
        service: "_companion-link._tcp",
        name: this.name,
        host: this.host,
        addresses: [this.address],
        port: 49153,
        txt: { rpMd: this.model },
      },
    ];
  }

  /** Its code on screen for a protocol, as the person reads it off the TV. */
  code(protocol: Protocol) {
    const code = this.showing.get(protocol);
    if (!code) throw new Error(`${this.name} shows no ${protocol} code`);
    return code;
  }

  /** A code that isn't the one on screen. */
  wrong(protocol: Protocol) {
    return this.code(protocol) === "0000" ? "1111" : "0000";
  }

  /** Takes Companion's code off the screen, as tvOS does after 35 s. */
  expire() {
    this.showing.delete("companion");
  }

  /** Forgets every key it gave, as after removing Sanctum on the TV. */
  forget() {
    for (const each of this.known.values()) each.clear();
    this.dropAll();
  }

  /** Drops every connection to it, as when the network goes. */
  dropAll() {
    for (const link of [...this.links]) link.drop();
  }

  /** Turns it on or off from its own remote. */
  setPower(on: boolean) {
    this.on = on;
    if (!on) this.playing = { ...nothing };
    for (const link of this.links) link.changed();
    for (const player of [...this.players]) player.changed();
  }

  /** Its media controls, as Companion's flags: pause, play, or none. */
  get controls() {
    const state = this.playing.state;
    return state === "playing" ? 2 : state === "paused" ? 1 : 0;
  }

  /** Plays something, as from its own remote. */
  play(playing: Partial<Playing>) {
    this.playing = { ...nothing, state: "playing", ...playing };
    for (const link of this.links) link.changed();
    for (const player of [...this.players]) player.changed();
  }

  /** Ends its player sessions with the given close reason. */
  endSessions(reason?: PlayerClose) {
    for (const player of [...this.players]) player.drop(reason);
  }

  setVolume(volume: BoxVolume) {
    this.volume = volume;
    for (const link of this.links) link.changed();
  }

  // An AirPlay code it no longer takes after a wrong one, which stays on
  // screen while any pairing is open, as tvOS 27 does: a pairing opened then
  // gets a code of its own that the screen doesn't show.
  private dead: string | null = null;

  pair(protocol: Protocol): Pairing {
    if (!this.reachable) throw new Unreachable("connect ECONNREFUSED");
    if (!this.allowsPairing)
      throw new NotAllowed("HTTP 470 from /pair-pin-start");
    codes = codes >= 9998 ? 1000 : codes + 1;
    const code = String(codes);
    if (protocol !== "airplay" || this.dead === null) {
      this.showing.set(protocol, code);
    }
    this.open += 1;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.open -= 1;
      if (this.showing.get(protocol) === code) this.showing.delete(protocol);
      if (this.open === 0 && this.dead !== null) {
        this.showing.delete("airplay");
        this.dead = null;
      }
    };
    return {
      finish: async (given) => {
        if (closed) throw new Error("The pairing is closed");
        const expired = this.showing.get(protocol) !== code;
        if (expired) {
          close();
          throw new CodeExpired("the PIN expired");
        }
        if (given !== code) {
          if (protocol === "airplay") this.dead = code;
          close();
          throw new WrongCode("M4 missing Proof (error=2)");
        }
        close();
        this.clients += 1;
        const clientId = `${protocol}-client-${this.clients}`;
        this.known.get(protocol)!.add(clientId);
        return {
          clientId,
          clientLTSK: "aa".repeat(32),
          clientLTPK: "bb".repeat(32),
          serverLTPK: "cc".repeat(32),
          serverId: this.deviceId,
        };
      },
      close,
    };
  }
}

export class FakeLink extends EventEmitter implements Link {
  closed = false;

  constructor(private readonly box: FakeBox) {
    super();
  }

  get power(): BoxPower {
    if (!this.box.tellsPower) return "unknown";
    return this.box.on ? "on" : "off";
  }

  get volume() {
    return this.box.volume;
  }

  get controls() {
    return this.box.controls;
  }

  changed() {
    if (!this.closed) this.emit("change");
  }

  drop() {
    if (this.closed) return;
    this.closed = true;
    this.box.links.splice(this.box.links.indexOf(this), 1);
    this.emit("close");
  }

  private async press(what: string) {
    if (this.closed) throw new Error("closed");
    this.box.pressed.push(what);
  }

  wake = async () => {
    await this.press("wake");
    this.box.setPower(true);
  };

  sleep = async () => {
    await this.press("sleep");
    this.box.setPower(false);
  };

  volumeUp = () => this.press("up");
  volumeDown = () => this.press("down");

  close() {
    this.drop();
  }
}

const nothing: Playing = {
  state: "unknown",
  app: null,
  title: "",
  artist: "",
  album: "",
  series: "",
};

export class FakePlayer extends EventEmitter implements Player {
  closed = false;

  constructor(private readonly box: FakeBox) {
    super();
  }

  get power(): BoxPower {
    return this.box.on ? "on" : "off";
  }

  get playing() {
    return this.box.playing;
  }

  changed() {
    if (!this.closed) this.emit("change");
  }

  drop(reason: PlayerClose = "closed") {
    if (this.closed) return;
    this.closed = true;
    this.box.players.splice(this.box.players.indexOf(this), 1);
    this.emit("close", reason);
  }

  can(command: PlayerCommand) {
    return this.box.takes.get(command) ?? "yes";
  }

  async send(...[command, position]: PlayerRequest) {
    if (this.closed) throw new Error("closed");
    this.box.sent.push(command === "seek" ? `seek ${position}` : command);
    const state =
      command === "play" ? "playing" : command === "pause" ? "paused" : null;
    if (state) this.box.play({ ...this.box.playing, state });
  }

  async picture() {
    this.box.pictures += 1;
    const picture = this.box.picture;
    await this.box.pictureHold;
    return picture;
  }

  close() {
    this.drop();
  }
}

/** The fake boxes on the network, as the app's Boxes. */
export function createFakeBoxes(...list: FakeBox[]) {
  const all = new Map(list.map((box) => [box.deviceId, box]));
  const boxOf = (endpoint: Endpoint) => {
    const box = all.get(endpoint.deviceId);
    if (!box) throw new Unreachable("connect EHOSTUNREACH");
    return box;
  };

  const boxes: Boxes = {
    async pairAirPlay(endpoint) {
      return boxOf(endpoint).pair("airplay");
    },
    async pairCompanion(endpoint) {
      return boxOf(endpoint).pair("companion");
    },
    async connect(endpoint, keys: Keys) {
      const box = boxOf(endpoint);
      box.endpoints.push(endpoint);
      if (!box.reachable) throw new Unreachable("connect ETIMEDOUT");
      if (!box.known.get("companion")!.has(keys.clientId)) {
        throw new PairingLost("Companion pair-verify M4 error: 2");
      }
      const link = new FakeLink(box);
      box.links.push(link);
      return link;
    },
    async play(endpoint, keys: Keys) {
      const box = boxOf(endpoint);
      box.playerAttempts += 1;
      if (box.playerHold) await box.playerHold;
      if (!box.reachable || !box.playerReachable) {
        throw new Unreachable("connect ETIMEDOUT");
      }
      if (!box.known.get("airplay")!.has(keys.clientId)) {
        throw new PairingLost("The player no longer knows these keys");
      }
      const player = new FakePlayer(box);
      box.players.push(player);
      box.playersOpened += 1;
      return player;
    },
  };
  return { boxes, add: (box: FakeBox) => all.set(box.deviceId, box) };
}
