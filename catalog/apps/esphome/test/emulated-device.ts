import type { Sighting } from "@meetsanctum/app-sdk";
import {
  createESPHomeHandshake,
  ENTITY_SCHEMAS,
  type CipherState,
} from "esphome-client";
import { createServer, type Server, type Socket } from "node:net";

// An ESPHome device on a real socket, as its firmware answers the native
// API: plaintext, or encrypted with Noise under its key, refusing the other.
// It greets, says who it is, lists its entities, sends their states, takes
// commands and answers pings, so the app's real client talks to it as to a
// device on the home's network.

type FieldValue = number | boolean | string;

export type EmulatedEntity = {
  type: keyof typeof ENTITY_SCHEMAS;
  key: number;
  objectId: string;
  name: string;
  /** Its list entry's other fields, by the library's names: deviceClass, supportedColorModes. */
  fields?: Record<string, FieldValue | readonly FieldValue[]>;
};

export type EmulatedOptions = {
  name: string;
  friendlyName?: string;
  /** Its project's name, as ESPHome writes it: "maker.product". */
  project?: string;
  mac: string;
  /** Its encryption key, in base64, or null for a device built without one. */
  psk: string | null;
  /** Built to be given its key later: with no key, it waits for one. */
  waiting?: boolean;
  version?: string;
  sleeps?: boolean;
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
} as const;

// Protocol buffers, as far as the API needs them.
function varint(value: number) {
  const bytes: number[] = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

type Spec = { fieldNumber: number; valueType: string };

// As ESPHome does, a field at its default (zero, false, empty) is left out.
function field(spec: Spec, value: FieldValue): Buffer {
  if (value === 0 || value === false || value === "") return Buffer.alloc(0);
  const tag = (wire: number) => varint((spec.fieldNumber << 3) | wire);
  if (spec.valueType === "float") {
    const out = Buffer.alloc(4);
    out.writeFloatLE(Number(value));
    return Buffer.concat([tag(5), out]);
  }
  if (spec.valueType === "fixed32") {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(Number(value) >>> 0);
    return Buffer.concat([tag(5), out]);
  }
  if (spec.valueType === "string" || spec.valueType === "bytes") {
    const text = Buffer.from(String(value));
    return Buffer.concat([tag(2), varint(text.length), text]);
  }
  return Buffer.concat([tag(0), varint(Number(value))]);
}

function decode(payload: Buffer) {
  const fields = new Map<number, (number | Buffer)[]>();
  let at = 0;
  const read = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = payload[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  while (at < payload.length) {
    const tag = read();
    const number = Math.floor(tag / 8);
    const wire = tag & 7;
    let value: number | Buffer;
    if (wire === 0) value = read();
    else if (wire === 5) {
      value = payload.subarray(at, at + 4);
      at += 4;
    } else if (wire === 2) {
      const length = read();
      value = payload.subarray(at, at + length);
      at += length;
    } else throw new Error(`wire type ${wire}`);
    fields.set(number, [...(fields.get(number) ?? []), value]);
  }
  return fields;
}

function valueOf(
  raw: number | Buffer | undefined,
  valueType: string,
): FieldValue | undefined {
  if (raw === undefined) return undefined;
  if (valueType === "float") return (raw as Buffer).readFloatLE(0);
  if (valueType === "string") return (raw as Buffer).toString();
  if (valueType === "bool") return raw === 1;
  return raw as number;
}

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
  /** It takes the next key it's sent, or has its own cleared, but its answer is lost. */
  losesNextAnswer = false;
  /** Every key it was sent, "" to clear its own, and whether it came encrypted. */
  readonly keysSent: { key: string; encrypted: boolean }[] = [];
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
    if (this.psk) txt.api_encryption = "Noise_NNpsk0_25519_ChaChaPoly_SHA256";
    else if (this.waiting) {
      txt.api_encryption_supported = "Noise_NNpsk0_25519_ChaChaPoly_SHA256";
      txt.api_provisioning = "zero_psk";
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
      if (spec) parts.push(field(spec, value));
    }
    send(schema.messageType, Buffer.concat(parts));
  }

  private serve(socket: Socket) {
    this.sockets.add(socket);
    this.connections += 1;
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
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
    if (type === message.helloRequest && this.waiting && this.windowClosed) {
      // Too late to be given a key: it says who it is, then asks to part.
      send(
        message.helloResponse,
        Buffer.concat([flag(1, 1), flag(2, 14), text(4, this.options.name)]),
      );
      send(message.disconnectRequest, Buffer.alloc(0));
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
        !(this.waiting && this.windowClosed) &&
        (text === "" ||
          (/^[A-Za-z0-9+/]{43}=$/.test(text) &&
            key.length === 32 &&
            key.some(Boolean)));
      const apply = () => {
        // An empty key clears its own, so it waits for one again.
        this.psk = text === "" ? null : text;
        this.waiting = this.psk === null;
        for (const each of this.sockets) each.destroy();
      };
      if (this.losesNextAnswer) {
        this.losesNextAnswer = false;
        if (valid) apply();
        else socket.destroy();
        return;
      }
      send(message.noiseSetKeyResponse, flag(1, valid));
      // It applies its key by ending every connection, as ESPHome does.
      if (valid) setTimeout(apply, 10);
    } else if (type === message.helloRequest) {
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
          flag(19, this.psk !== null || this.waiting),
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
        send(schema.messageType, Buffer.concat(parts));
      }
      send(message.listEntitiesDone, Buffer.alloc(0));
    } else if (type === message.subscribeStates) {
      this.subscribed.add(send);
      socket.on("close", () => this.subscribed.delete(send));
      for (const entity of this.options.entities) this.sendState(send, entity);
    } else if (type === message.pingRequest) {
      if (this.answersPings) send(message.pingResponse, Buffer.alloc(0));
    } else if (type === message.disconnectRequest) {
      send(message.disconnectResponse, Buffer.alloc(0));
      socket.end();
    } else {
      this.command(type, payload);
    }
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
