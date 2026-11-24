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
} from "../src/boxes.js";

// Apple TVs for the tests, standing in for node-appletv-remote: each shows a
// code for every pairing it opens, knows the keys it handed out, and keeps
// the connections made to it, which a test can drop, sleep or wake.

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
    for (const link of [...this.links]) link.drop(new PairingLost("forgot"));
  }

  /** Drops every connection to it, as when the network goes. */
  dropAll() {
    for (const link of [...this.links]) link.drop();
  }

  /** Turns it on or off from its own remote. */
  setPower(on: boolean) {
    this.on = on;
    for (const link of this.links) link.changed();
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

  changed() {
    if (!this.closed) this.emit("change");
  }

  drop(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.box.links.splice(this.box.links.indexOf(this), 1);
    this.emit("close", error);
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
  };
  return { boxes, add: (box: FakeBox) => all.set(box.deviceId, box) };
}
