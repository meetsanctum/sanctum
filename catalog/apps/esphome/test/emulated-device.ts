import type { Sighting } from "@meetsanctum/app-sdk";
import {
  createESPHomeHandshake,
  ENTITY_SCHEMAS,
  MediaPlayerCommand,
  MediaPlayerState,
  type CipherState,
} from "esphome-client";
import { createServer, type Server, type Socket } from "node:net";

import {
  decode,
  field,
  nestedMessage,
  valueOf,
  varint,
  type FieldValue,
  type Spec,
} from "./emulated-protobuf.js";

// An ESPHome device on a real socket, as its firmware answers the native
// API: plaintext, or encrypted with Noise under its key, refusing the other.
// It greets, says who it is, lists its entities, sends their states, takes
// commands and answers pings, so the app's real client talks to it as to a
// device on the home's network.

export type EmulatedEntity = {
  type: keyof typeof ENTITY_SCHEMAS;
  key: number;
  objectId: string;
  name: string;
  /** Its list entry's other fields, by the library's names: deviceClass, supportedColorModes. */
  fields?: Record<string, FieldValue | readonly FieldValue[]>;
  /** Its list entry's repeated messages, such as a media player's supportedFormats. */
  messages?: Record<string, readonly Record<string, FieldValue>[]>;
};

export type EmulatedOptions = {
  name: string;
  friendlyName?: string;
  /** Its project's name, as ESPHome writes it: "maker.product". */
  project?: string;
  mac: string;
  /** Its encryption key, in base64, or null for a device built without one. */
  psk: string | null;
  /** How many API connections the firmware accepts at once. */
  maxConnections?: number;
  /** Built to be given its key later: with no key, it waits for one. */
  waiting?: boolean;
  /**
   * Firmware from before ESPHome 2026.7 built with encryption: with no key
   * it can't wait for one, so it greets only in the clear and takes a first
   * key that way, its record saying it supports encryption and no more.
   */
  older?: boolean;
  /**
   * Whether an empty key clears its own, as from ESPHome 2025.11; true
   * unless said.
   */
  clears?: boolean;
  /**
   * Its record says what held as it last booted, as ESPHome writes it once:
   * a key given or taken off since doesn't change it until it restarts.
   */
  recordAtBoot?: boolean;
  version?: string;
  sleeps?: boolean;
  /** It has a voice assistant, which asks whoever follows it to listen. */
  voiceAssistant?: boolean;
  entities: EmulatedEntity[];
  /** Each entity's state by its key, by the library's field names. */
  states?: Record<number, Record<string, FieldValue>>;
};

const message = {
  noiseSetKeyRequest: 124,
  noiseSetKeyResponse: 125,
  helloRequest: 1,
  helloResponse: 2,
  disconnectRequest: 5,
  disconnectResponse: 6,
  pingRequest: 7,
  pingResponse: 8,
  deviceInfoRequest: 9,
  deviceInfoResponse: 10,
  listEntitiesRequest: 11,
  listEntitiesDone: 19,
  subscribeStates: 20,
  subscribeVoiceAssistant: 89,
  voiceAssistantRequest: 90,
  voiceAssistantResponse: 91,
  voiceAssistantEvent: 92,
} as const;

export class EmulatedDevice {
  readonly host = "127.0.0.1";
  port = 0;
  psk: string | null;
  /** Commands it took, as the library names their fields. */
  readonly commands: {
    type: string;
    key: number;
    fields: Record<string, FieldValue>;
  }[] = [];
  /** How many connections it has had, encrypted or not. */
  connections = 0;
  /** How many of them it greeted, as sessions: not those refused at the handshake. */
  greeted = 0;
  /** Whether it answers pings, so a test can model a silent connection. */
  answersPings = true;
  /** Whether it finishes a connection's greeting. */
  answersHello = true;
  /** Waiting for a key, which it takes over a connection under the zero key. */
  waiting: boolean;
  /** Its window for being given a key closed, as a device that waited too long. */
  windowClosed = false;
  /** Its window closes once it has greeted the next connection. */
  closesWindowAfterHello = false;
  /** The next connections it closes at once, as one whose connection slots are full does. */
  closesNext = 0;
  /** It asks the next greeting to part with no reason, as one applying a key or shutting down does. */
  partsWithoutReason = false;
  /** It takes the next key it's sent, or has its own cleared, but its answer is lost. */
  losesNextAnswer = false;
  /** It takes the key it's sent as this one in all (1 for the first), its answer lost. */
  losesAnswerToKey = 0;
  /** It refuses every key it's sent, as when it can't store one. */
  refusesKeys = false;
  /** How many sessions it greeted in the clear. */
  plainGreetings = 0;
  /**
   * States it holds whatever it's told, by entity key, as a Voice PE's side
   * switch holds its microphones muted.
   */
  readonly held = new Map<number, Record<string, FieldValue>>();
  /** Entities that receive commands without reporting a state in response. */
  readonly silent = new Set<number>();
  /** Responses and events the voice assistant received, in wire order. */
  readonly voiceMessages: (
    | { type: "response"; isDeclined: boolean }
    | { type: "event"; eventType: number }
  )[] = [];
  // Who follows its voice assistant's requests, as a session's send.
  private voiceFollower: ((type: number, payload: Buffer) => void) | null =
    null;
  /** Every key it was sent, "" to clear its own, and whether it came encrypted. */
  readonly keysSent: { key: string; encrypted: boolean }[] = [];
  // What held as it last booted, for a record kept from then.
  private booted: { psk: string | null; waiting: boolean };
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly subscribed = new Set<
    (type: number, payload: Buffer) => void
  >();
  readonly states: Record<number, Record<string, FieldValue>>;

  get activeConnections() {
    return this.sockets.size;
  }

  private constructor(readonly options: EmulatedOptions) {
    this.psk = options.psk;
    this.waiting = options.waiting === true && options.psk === null;
    this.booted = { psk: this.psk, waiting: this.waiting };
    this.states = structuredClone(options.states ?? {});
    this.server = createServer((socket) => this.serve(socket));
  }

  static async start(options: EmulatedOptions) {
    const device = new EmulatedDevice(options);
    await device.listen();
    return device;
  }

  /** Answers again, on its port, as after it's plugged back in. */
  async listen() {
    await new Promise<void>((done) => {
      this.server.listen(this.port, this.host, () => done());
    });
    const address = this.server.address();
    if (address && typeof address === "object") this.port = address.port;
  }

  /** Restarts, as after it's unplugged and plugged back in: its record says what holds now. */
  reboot() {
    for (const socket of this.sockets) socket.destroy();
    this.voiceFollower = null;
    this.booted = { psk: this.psk, waiting: this.waiting };
  }

  /** Stops answering, as when it's unplugged, closing every connection. */
  async unplug() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  stop() {
    return this.unplug().catch(() => undefined);
  }

  /** The record it announces on mDNS. */
  sighting(): Sighting {
    const txt: Record<string, string> = {
      mac: this.options.mac.replace(/:/g, "").toLowerCase(),
      version: this.options.version ?? "2026.10.2",
      platform: "ESP32",
      board: "esp32dev",
      network: "wifi",
    };
    if (this.options.friendlyName)
      txt.friendly_name = this.options.friendlyName;
    if (this.options.project) txt.project_name = this.options.project;
    const { psk, waiting } = this.options.recordAtBoot ? this.booted : this;
    if (psk) txt.api_encryption = "Noise_NNpsk0_25519_ChaChaPoly_SHA256";
    else if (waiting) {
      txt.api_encryption_supported = "Noise_NNpsk0_25519_ChaChaPoly_SHA256";
      txt.api_provisioning = "zero_psk";
    } else if (this.options.older) {
      txt.api_encryption_supported = "Noise_NNpsk0_25519_ChaChaPoly_SHA256";
    }
    return {
      service: "_esphomelib._tcp",
      name: this.options.name,
      host: `${this.options.name}.local`,
      addresses: [this.host],
      port: this.port,
      txt,
    };
  }

  /** Changes one of its entities' state, as the device would, telling every session. */
  setState(key: number, fields: Record<string, FieldValue>) {
    this.states[key] = { ...this.states[key], ...fields };
    const entity = this.options.entities.find((each) => each.key === key)!;
    for (const send of this.subscribed) this.sendState(send, entity);
  }

  /** Waits until a session follows its states, as one does just after it connects. */
  async followed() {
    while (this.subscribed.size === 0) {
      await new Promise((done) => setTimeout(done, 5));
    }
  }

  /** Whether a session follows its voice assistant's requests. */
  get voiceFollowed() {
    return this.voiceFollower !== null;
  }

  /** Hears its wake word, asking whoever follows it to listen. */
  wake(phrase: string | null = "Okay Nabu") {
    if (!this.voiceFollower)
      throw new Error("nobody follows its voice requests");
    this.voiceFollower(
      message.voiceAssistantRequest,
      Buffer.concat([
        field({ fieldNumber: 1, valueType: "varint" }, 1),
        ...(phrase
          ? [field({ fieldNumber: 5, valueType: "string" }, phrase)]
          : []),
      ]),
    );
  }

  /** One of its event entities firing, as a button's press does. */
  fire(key: number, eventType: string) {
    const entity = this.options.entities.find((each) => each.key === key)!;
    const schema = ENTITY_SCHEMAS[entity.type].state as unknown as StateSpec;
    const payload = Buffer.concat([
      field({ fieldNumber: schema.keyFieldNumber, valueType: "fixed32" }, key),
      field({ fieldNumber: 2, valueType: "string" }, eventType),
    ]);
    for (const send of this.subscribed) send(schema.messageType, payload);
  }

  private sendState(
    send: (type: number, payload: Buffer) => void,
    entity: EmulatedEntity,
  ) {
    const state = this.states[entity.key];
    if (!state) return;
    const schema = ENTITY_SCHEMAS[entity.type].state as unknown as StateSpec;
    const parts = [
      field(
        { fieldNumber: schema.keyFieldNumber, valueType: "fixed32" },
        entity.key,
      ),
    ];
    for (const [name, value] of Object.entries(state)) {
      const spec = schema.fields[name];
      if (spec && value !== false) parts.push(field(spec, value));
    }
    send(schema.messageType, Buffer.concat(parts));
  }

  private serve(socket: Socket) {
    this.sockets.add(socket);
    this.connections += 1;
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    if (this.sockets.size > (this.options.maxConnections ?? Infinity)) {
      socket.destroy();
      return;
    }
    if (this.closesNext > 0) {
      this.closesNext -= 1;
      socket.destroy();
      return;
    }
    let buffer = Buffer.alloc(0);
    let noise: ReturnType<typeof createESPHomeHandshake> | null = null;
    let stage: "first" | "plain" | "hello" | "handshake" | "data" = "first";
    let send: (type: number, payload: Buffer) => void = () => undefined;
    let ciphers: { send: CipherState; receive: CipherState } | null = null;

    const noiseFrame = (body: Buffer) => {
      const header = Buffer.from([1, 0, 0]);
      header.writeUInt16BE(body.length, 1);
      socket.write(Buffer.concat([header, body]));
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length === 0) return;
        if (stage === "first") {
          if (buffer[0] === 0) {
            if (this.psk) {
              // Encryption is needed: it answers in Noise, which the client takes as that.
              noiseFrame(Buffer.from([1]));
              socket.end();
              return;
            }
            stage = "plain";
            send = (type, payload) => {
              socket.write(
                Buffer.concat([
                  Buffer.from([0]),
                  varint(payload.length),
                  varint(type),
                  payload,
                ]),
              );
            };
          } else {
            if (!this.psk && !this.waiting) {
              // Built without encryption: a Noise hello ends the connection.
              socket.destroy();
              return;
            }
            stage = "hello";
          }
        }
        if (stage === "plain") {
          let at = 1;
          const read = () => {
            let value = 0;
            let shift = 0;
            for (;;) {
              if (at >= buffer.length) return null;
              const byte = buffer[at++]!;
              value += (byte & 0x7f) * 2 ** shift;
              if ((byte & 0x80) === 0) return value;
              shift += 7;
            }
          };
          const length = read();
          const type = read();
          if (length === null || type === null || buffer.length < at + length)
            return;
          const payload = buffer.subarray(at, at + length);
          buffer = buffer.subarray(at + length);
          this.answer(socket, send, type, payload, false);
          continue;
        }
        if (buffer.length < 3) return;
        const size = buffer.readUInt16BE(1);
        if (buffer.length < 3 + size) return;
        const body = buffer.subarray(3, 3 + size);
        buffer = buffer.subarray(3 + size);
        if (stage === "hello") {
          // One waiting for a key takes the zero key, which keeps listeners
          // out but authenticates nobody.
          noise = createESPHomeHandshake({
            role: "responder",
            psk: this.psk ? Buffer.from(this.psk, "base64") : Buffer.alloc(32),
          });
          const name = this.options.name;
          noiseFrame(
            Buffer.concat([
              Buffer.from([1]),
              Buffer.from(`${name}\0${this.options.mac}\0`),
            ]),
          );
          stage = "handshake";
        } else if (stage === "handshake") {
          try {
            noise!.readMessage(body.subarray(1));
            const reply = noise!.writeMessage();
            noiseFrame(Buffer.concat([Buffer.from([0]), reply]));
          } catch {
            noiseFrame(
              Buffer.concat([
                Buffer.from([1]),
                Buffer.from("Handshake MAC failure"),
              ]),
            );
            socket.end();
            return;
          }
          ciphers = {
            send: noise!.sendCipher!,
            receive: noise!.receiveCipher!,
          };
          stage = "data";
          send = (type, payload) => {
            const inner = Buffer.alloc(4);
            inner.writeUInt16BE(type, 0);
            inner.writeUInt16BE(payload.length, 2);
            noiseFrame(
              ciphers!.send.EncryptWithAd(
                Buffer.alloc(0),
                Buffer.concat([inner, payload]),
              ),
            );
          };
        } else {
          const plain = ciphers!.receive.DecryptWithAd(Buffer.alloc(0), body);
          const type = plain.readUInt16BE(0);
          const length = plain.readUInt16BE(2);
          this.answer(socket, send, type, plain.subarray(4, 4 + length), true);
        }
      }
    });
  }

  private answer(
    socket: Socket,
    send: (type: number, payload: Buffer) => void,
    type: number,
    payload: Buffer,
    encrypted: boolean,
  ) {
    const text = (fieldNumber: number, value: string) =>
      field({ fieldNumber, valueType: "string" }, value);
    const flag = (fieldNumber: number, value: number | boolean) =>
      field({ fieldNumber, valueType: "varint" }, Number(value));
    if (type === message.helloRequest && !this.answersHello) return;
    if (type === message.helloRequest && this.partsWithoutReason) {
      this.partsWithoutReason = false;
      send(message.disconnectRequest, Buffer.alloc(0));
      socket.end();
      return;
    }
    if (type === message.helloRequest && this.windowClosed) {
      // Too late to be given a key: it says who it is, then asks to part,
      // saying why (DISCONNECT_REASON_PROVISIONING_CLOSED).
      send(
        message.helloResponse,
        Buffer.concat([flag(1, 1), flag(2, 14), text(4, this.options.name)]),
      );
      send(message.disconnectRequest, flag(1, 1));
      socket.end();
    } else if (type === message.noiseSetKeyRequest) {
      const raw = decode(payload).get(1)?.[0];
      // The bytes field carries base64 text, which the firmware decodes.
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
      const key = Buffer.from(text, "base64");
      this.keysSent.push({ key: text, encrypted });
      // A window that closed since its greeting refuses the key too, as
      // the firmware checks it again here.
      const valid =
        !this.refusesKeys &&
        !(this.waiting && this.windowClosed) &&
        ((text === "" && this.options.clears !== false) ||
          (/^[A-Za-z0-9+/]{43}=$/.test(text) &&
            key.length === 32 &&
            key.some(Boolean)));
      const apply = () => {
        // An empty key clears its own, so it waits for one again, or older
        // firmware greets in the clear again.
        this.psk = text === "" ? null : text;
        this.waiting = this.psk === null && this.options.older !== true;
        for (const each of this.sockets) each.destroy();
      };
      if (
        this.losesNextAnswer ||
        this.losesAnswerToKey === this.keysSent.length
      ) {
        this.losesNextAnswer = false;
        if (valid) apply();
        else socket.destroy();
        return;
      }
      send(message.noiseSetKeyResponse, flag(1, valid));
      // It applies its key by ending every connection, as ESPHome does.
      if (valid) setTimeout(apply, 10);
    } else if (type === message.helloRequest) {
      this.greeted += 1;
      if (!encrypted) this.plainGreetings += 1;
      if (this.closesWindowAfterHello) {
        this.closesWindowAfterHello = false;
        this.windowClosed = true;
      }
      send(
        message.helloResponse,
        Buffer.concat([
          flag(1, 1),
          flag(2, 14),
          text(3, "emulated"),
          text(4, this.options.name),
        ]),
      );
    } else if (type === message.deviceInfoRequest) {
      send(
        message.deviceInfoResponse,
        Buffer.concat([
          text(2, this.options.name),
          text(3, this.options.mac),
          text(4, this.options.version ?? "2026.10.2"),
          text(6, "esp32dev"),
          flag(7, this.options.sleeps === true),
          ...(this.options.project ? [text(8, this.options.project)] : []),
          text(12, "Espressif"),
          ...(this.options.friendlyName
            ? [text(13, this.options.friendlyName)]
            : []),
          ...(this.options.voiceAssistant ? [flag(17, 1)] : []),
          flag(
            19,
            this.psk !== null || this.waiting || this.options.older === true,
          ),
          // Whether it can be given a key under the zero key, as firmware from
          // 2026.7 says.
          ...(this.waiting ? [flag(26, true)] : []),
        ]),
      );
    } else if (type === message.listEntitiesRequest) {
      for (const entity of this.options.entities) {
        const schema = ENTITY_SCHEMAS[entity.type]
          .listEntities as unknown as ListSpec;
        const parts = [
          field(
            { fieldNumber: schema.objectIdFieldNumber, valueType: "string" },
            entity.objectId,
          ),
          field(
            { fieldNumber: schema.keyFieldNumber, valueType: "fixed32" },
            entity.key,
          ),
          field(
            { fieldNumber: schema.nameFieldNumber, valueType: "string" },
            entity.name,
          ),
        ];
        for (const [name, value] of Object.entries(entity.fields ?? {})) {
          const spec = schema.fields[name] ?? schema.repeatedFields?.[name];
          if (!spec) throw new Error(`${entity.type} has no field ${name}`);
          for (const each of Array.isArray(value) ? value : [value])
            parts.push(field(spec, each));
        }
        for (const [name, list] of Object.entries(entity.messages ?? {})) {
          const spec = schema.repeatedMessageFields?.[name];
          if (!spec) throw new Error(`${entity.type} has no messages ${name}`);
          for (const each of list) {
            parts.push(nestedMessage(name, spec, each));
          }
        }
        send(schema.messageType, Buffer.concat(parts));
      }
      send(message.listEntitiesDone, Buffer.alloc(0));
    } else if (type === message.subscribeStates) {
      this.subscribed.add(send);
      socket.on("close", () => this.subscribed.delete(send));
      for (const entity of this.options.entities) this.sendState(send, entity);
    } else if (type === message.subscribeVoiceAssistant) {
      if (decode(payload).get(1)?.[0] === 1) {
        this.voiceFollower = send;
        socket.on("close", () => {
          if (this.voiceFollower === send) this.voiceFollower = null;
        });
      } else if (this.voiceFollower === send) this.voiceFollower = null;
    } else if (type === message.voiceAssistantResponse) {
      this.voiceMessages.push({
        type: "response",
        isDeclined: decode(payload).get(2)?.[0] === 1,
      });
    } else if (type === message.voiceAssistantEvent) {
      this.voiceMessages.push({
        type: "event",
        eventType: Number(decode(payload).get(1)?.[0] ?? 0),
      });
    } else if (type === message.pingRequest) {
      if (this.answersPings) send(message.pingResponse, Buffer.alloc(0));
    } else if (type === message.disconnectRequest) {
      send(message.disconnectResponse, Buffer.alloc(0));
      socket.end();
    } else {
      this.command(type, payload);
    }
  }

  // A media player's state after a command, as ESPHome's speaker player has
  // it: a volume in steps of 0.05.
  private playerAfter(key: number, said: Record<string, FieldValue>) {
    const now: Record<string, FieldValue> = {
      state: MediaPlayerState.IDLE,
      volume: 0,
      muted: false,
      ...this.states[key],
    };
    if (typeof said.volume === "number") now.volume = said.volume;
    // An announcement it was asked to play shows as playing, as the Voice
    // PE's firmware of 2026.6 shows it; the test says when it ends.
    if (said.announcement === true && typeof said.mediaUrl === "string") {
      now.state = MediaPlayerState.PLAYING;
    }
    switch (said.command) {
      case MediaPlayerCommand.PLAY:
        now.state = MediaPlayerState.PLAYING;
        break;
      case MediaPlayerCommand.PAUSE:
        now.state = MediaPlayerState.PAUSED;
        break;
      case MediaPlayerCommand.STOP:
        now.state = MediaPlayerState.IDLE;
        break;
      case MediaPlayerCommand.MUTE:
        now.muted = true;
        break;
      case MediaPlayerCommand.UNMUTE:
        now.muted = false;
        break;
      case MediaPlayerCommand.TURN_ON:
        now.state = MediaPlayerState.ON;
        break;
      case MediaPlayerCommand.TURN_OFF:
        now.state = MediaPlayerState.OFF;
        break;
      case MediaPlayerCommand.VOLUME_UP:
        now.volume = Math.min(1, Number(now.volume) + 0.05);
        break;
      case MediaPlayerCommand.VOLUME_DOWN:
        now.volume = Math.max(0, Number(now.volume) - 0.05);
        break;
    }
    return now;
  }

  // A command for one of its entities, which it carries out and reports.
  private command(type: number, payload: Buffer) {
    const entry = Object.values(ENTITY_SCHEMAS).find(
      (schema) =>
        (schema as { command?: { messageType: number } }).command
          ?.messageType === type,
    ) as { type: string; command: CommandSpec } | undefined;
    if (!entry) return;
    const fields = decode(payload);
    const spec = entry.command;
    const key = (fields.get(spec.keyFieldNumber)?.[0] as Buffer).readUInt32LE(
      0,
    );
    const said: Record<string, FieldValue> = {};
    for (const [name, each] of Object.entries(spec.fields)) {
      const value = valueOf(fields.get(each.fieldNumber)?.[0], each.valueType);
      if (value !== undefined) said[name] = value;
    }
    for (const [name, each] of Object.entries(spec.hasPatternFields ?? {})) {
      if (fields.get(each.hasFieldNumber)?.[0] !== 1) continue;
      const value = valueOf(
        fields.get(each.valueFieldNumber)?.[0],
        each.valueType,
      );
      if (value !== undefined) said[name] = value;
    }
    this.commands.push({ type: entry.type, key, fields: said });
    if (this.silent.has(key)) return;
    const held = this.held.get(key);
    if (held) {
      this.setState(key, held);
      return;
    }
    if (entry.type === "media_player") {
      this.setState(key, this.playerAfter(key, said));
      return;
    }
    const next: Record<string, FieldValue> = { ...said };
    if (said.hasRgb !== true) {
      delete next.red;
      delete next.green;
      delete next.blue;
    }
    delete next.hasRgb;
    delete next.transitionLength;
    this.setState(key, next);
  }
}

type StateSpec = {
  keyFieldNumber: number;
  messageType: number;
  fields: Record<string, Spec>;
};
type ListSpec = {
  keyFieldNumber: number;
  nameFieldNumber: number;
  objectIdFieldNumber: number;
  messageType: number;
  fields: Record<string, Spec>;
  repeatedFields?: Record<string, Spec>;
  repeatedMessageFields?: Record<
    string,
    { fieldNumber: number; fields: Record<string, Spec> }
  >;
};
type CommandSpec = {
  keyFieldNumber: number;
  fields: Record<string, Spec>;
  hasPatternFields?: Record<
    string,
    { hasFieldNumber: number; valueFieldNumber: number; valueType: string }
  >;
};

/** A fresh encryption key, as ESPHome's dashboard makes one. */
export function newKey() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64",
  );
}
