import { EventEmitter } from "node:events";

import {
  AppleTV,
  CompanionPairSetup,
  PairSetup,
  PowerState,
  type HAPCredentials,
} from "node-appletv-remote";

// The one module that speaks to Apple TVs: pairing with a code on the
// screen, over AirPlay and over Companion, and a Companion connection for
// power and volume. It goes through node-appletv-remote, whose errors are
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
  /** Something it says changed: its power or its volume. */
  on(event: "change", listener: () => void): this;
  /** It closed, by either side; the error says why where there is one. */
  on(event: "close", listener: (error?: Error) => void): this;
  wake(): Promise<void>;
  sleep(): Promise<void>;
  volumeUp(): Promise<void>;
  volumeDown(): Promise<void>;
  close(): void;
}

/** What pairs with and connects to boxes; tests stand a fake box in for it. */
export interface Boxes {
  /** Asks the box to show AirPlay's code, and holds the pairing open. */
  pairAirPlay(box: Endpoint): Promise<Pairing>;
  /** Asks the box to show Companion's code, naming Sanctum on it. */
  pairCompanion(box: Endpoint): Promise<Pairing>;
  connect(box: Endpoint, keys: Keys): Promise<Link>;
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

// What the box calls itself on the pairings it lists.
const pairingName = "Sanctum";

// HAP's TLV error 2, Authentication: a wrong code in pair-setup's M4, and
// keys the box doesn't know in pair-verify's M4.
const wrongCodeMessage = /M4 missing Proof \(error=2\)/;
const lostMessage = /pair-verify M4 error: 2\b/i;
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
    tv.on("companionError", (error: unknown) => {
      if (!this.closed) this.end(errorOf(error) as Error);
    });
    tv.on("companionClose", () => this.end());
  }

  async start() {
    this.tv.subscribePowerState();
    // tvOS 26 has no handler for this, and tells power only by its events,
    // if at all.
    const power = await this.tv.fetchPowerState().catch(() => null);
    if (power) this.power = powerOf(power);
    this.volume = volumeOf(this.tv);
  }

  private end(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    void this.tv.close();
    this.emit("close", error);
  }

  wake = () => translated(() => this.tv.wake());
  sleep = () => translated(() => this.tv.suspend());
  volumeUp = () => translated(() => this.tv.volumeUp());
  volumeDown = () => translated(() => this.tv.volumeDown());

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
  };
}
