import type { ServiceConnection } from "@meetsanctum/app-sdk";
import { Aedes, type Client } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { createServer, type AddressInfo, type Server } from "node:net";

import type { ZigbeeDevice, ZigbeeExpose } from "../src/types.js";

// Zigbee2MQTT as the driver meets it: a broker in this process with an
// account for the app, as the manager's Mosquitto has, and a client playing
// the bridge. It keeps its device list on bridge/devices, answers <device>/set
// and /get with the device's whole state as Zigbee2MQTT does, says when a
// device stops answering, tells of devices joining on bridge/event, passes on
// a remote's presses, and answers permit-join and remove requests. It keeps
// each device's options, such as how long it waits before it says an Aqara
// motion sensor sees no motion, in its configuration on bridge/info, and
// changes them when asked. It updates firmware over the air as Zigbee2MQTT
// 2.14 does: a device's state carries what is known of its firmware as
// `update`, a check and the requests to schedule or abort an update answer
// at once, and an update answers only once a test ends it, its progress
// coming with the state.

export const account = { username: "sanctum.zigbee", password: "secret" };
const base = "zigbee2mqtt";

type Device = {
  definition: ZigbeeDevice;
  state: Record<string, unknown>;
  answers: boolean;
  /** Its options in Zigbee2MQTT's configuration, such as occupancy_timeout. */
  options: Record<string, unknown>;
  // The firmware it runs and the newest out for it, and the transaction of
  // the update under way.
  ota?: { installed: number; latest: number; updating?: unknown };
};

const otaRequest = "bridge/request/device/ota_update/";

// A feature Zigbee2MQTT publishes, sets and reads.
const all = 7;

export function lightExpose(
  options: {
    brightness?: boolean;
    colorTemperature?: [number, number];
    color?: "color_xy" | "color_hs";
    endpoint?: string;
  } = {},
): ZigbeeExpose {
  const suffix = options.endpoint ? `_${options.endpoint}` : "";
  const features: ZigbeeExpose[] = [
    {
      type: "binary",
      name: "state",
      property: `state${suffix}`,
      value_on: "ON",
      value_off: "OFF",
      access: all,
    },
  ];
  if (options.brightness !== false) {
    features.push({
      type: "numeric",
      name: "brightness",
      property: `brightness${suffix}`,
      value_min: 0,
      value_max: 254,
      access: all,
    });
  }
  if (options.colorTemperature) {
    features.push({
      type: "numeric",
      name: "color_temp",
      property: `color_temp${suffix}`,
      unit: "mired",
      value_min: options.colorTemperature[0],
      value_max: options.colorTemperature[1],
      access: all,
    });
  }
  if (options.color) {
    features.push({
      type: "composite",
      name: options.color,
      property: `color${suffix}`,
      access: all,
    });
  }
  return {
    type: "light",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    features,
  };
}

export function switchExpose(endpoint?: string): ZigbeeExpose {
  return {
    type: "switch",
    ...(endpoint ? { endpoint } : {}),
    features: [
      {
        type: "binary",
        name: "state",
        property: endpoint ? `state_${endpoint}` : "state",
        value_on: "ON",
        value_off: "OFF",
        access: all,
      },
    ],
  };
}

/** A remote's buttons, as Zigbee2MQTT lists the actions it sends. */
export function actionExpose(values: unknown[]): ZigbeeExpose {
  return {
    type: "enum",
    name: "action",
    property: "action",
    access: 1,
    values,
  };
}

/**
 * A climate sensor's exposes, as Zigbee2MQTT lists an Aqara WSDCGQ11LM's:
 * its readings, and its battery, voltage and link quality as diagnostics.
 */
export function climateExposes(): ZigbeeExpose[] {
  const reading = (property: string, unit: string): ZigbeeExpose => ({
    type: "numeric",
    name: property,
    property,
    unit,
    access: 1,
  });
  return [
    reading("battery", "%"),
    reading("temperature", "°C"),
    reading("humidity", "%"),
    reading("pressure", "hPa"),
    reading("voltage", "mV"),
    reading("linkquality", "lqi"),
  ];
}

export function zigbeeDevice(
  ieee: string,
  friendlyName: string,
  exposes: ZigbeeExpose[],
  extra: Partial<ZigbeeDevice> = {},
): ZigbeeDevice {
  return {
    ieee_address: ieee,
    friendly_name: friendlyName,
    type: "Router",
    supported: true,
    interview_completed: true,
    interview_state: "SUCCESSFUL",
    power_source: "Mains (single phase)",
    manufacturer: "Test",
    definition: {
      vendor: "Test Vendor",
      model: "TL-1",
      description: "Test light",
      exposes,
    },
    ...extra,
  };
}

const coordinator: ZigbeeDevice = {
  ieee_address: "0x00124b0000000000",
  friendly_name: "Coordinator",
  type: "Coordinator",
  interview_completed: true,
};

// What a device says once it has carried out a command, as Zigbee2MQTT
// publishes it: its whole state.
function apply(state: Record<string, unknown>, set: Record<string, unknown>) {
  for (const [property, value] of Object.entries(set)) {
    if (property === "transition") {
      continue;
    }
    state[property] = value;
    if (property.startsWith("color_temp")) {
      state[`color_mode${property.slice("color_temp".length)}`] = "color_temp";
    } else if (property.startsWith("color")) {
      state[`color_mode${property.slice("color".length)}`] = "hs";
    }
  }
}

export class PretendBridge {
  private readonly devices = new Map<string, Device>();
  private driverClient: Client | undefined;
  private isOnline = true;
  /** Everything the driver asked of it: sets, gets and bridge requests. */
  readonly received: { topic: string; payload: Record<string, unknown> }[] = [];
  /** How it answers a permit-join request. */
  permitJoin: "ok" | "error" | "silent" = "ok";
  /** Whether it answers a request to remove a device. */
  answersRemoval = true;
  /** Whether it takes a request to change a device's options. */
  takesOptions = true;
  // Until when devices may join, while they may.
  private joinEnd: number | null = null;

  private constructor(
    private readonly broker: Aedes,
    private readonly server: Server,
    private readonly client: MqttClient,
    readonly url: string,
  ) {
    client.on("message", (topic, payload) => void this.receive(topic, payload));
    broker.on("clientReady", (connected) => {
      if (connected.id.startsWith("sanctum-zigbee-")) {
        this.driverClient = connected;
      }
    });
  }

  static async start() {
    const broker = await Aedes.createBroker({
      authenticate(_client, username, password, done) {
        const ok =
          (username === account.username &&
            password?.toString() === account.password) ||
          username === "zigbee2mqtt";
        done(null, ok);
      },
    });
    const server = createServer(broker.handle);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = await mqtt.connectAsync(url, { username: "zigbee2mqtt" });
    await client.subscribeAsync(`${base}/#`);
    const bridge = new PretendBridge(broker, server, client, url);
    await bridge.publish("bridge/state", { state: "online" }, true);
    await bridge.reset();
    return bridge;
  }

  /** What the core hands the driver for the zigbee2mqtt service. */
  get connection(): ServiceConnection {
    return {
      mqtt: { url: this.url, ...account, topics: [`${base}/#`] },
      baseTopic: base,
    };
  }

  /** Forgets every device and what it was asked. */
  async reset() {
    this.devices.clear();
    this.received.length = 0;
    this.permitJoin = "ok";
    this.answersRemoval = true;
    this.takesOptions = true;
    this.joinEnd = null;
    await this.setOnline(true);
    await this.list();
  }

  /** A device joins and is interviewed, then says what it shows. */
  async add(definition: ZigbeeDevice, state: Record<string, unknown>) {
    const name = definition.friendly_name!;
    this.devices.set(name, {
      definition,
      state: { ...state },
      answers: true,
      options: {},
    });
    await this.list();
    await this.publish(`${name}/availability`, { state: "online" }, true);
    await this.publish(name, state);
  }

  /**
   * A device joins, as Zigbee2MQTT tells of it on bridge/event, and is
   * interviewed: once that succeeds it is in the list.
   */
  async join(
    definition: ZigbeeDevice,
    state: Record<string, unknown>,
    interview: "successful" | "failed" = "successful",
  ) {
    const data = {
      friendly_name: definition.friendly_name,
      ieee_address: definition.ieee_address,
    };
    await this.add(
      {
        ...definition,
        interview_completed: false,
        interview_state: "IN_PROGRESS",
      },
      state,
    );
    await this.publish("bridge/event", { type: "device_joined", data });
    await this.publish("bridge/event", {
      type: "device_interview",
      data: { ...data, status: "started" },
    });
    // Zigbee2MQTT publishes its updated list before the interview event.
    if (interview === "successful") {
      await this.add(definition, state);
    }
    await this.publish("bridge/event", {
      type: "device_interview",
      data:
        interview === "failed"
          ? { ...data, status: "failed" }
          : {
              ...data,
              status: "successful",
              supported: true,
              definition: definition.definition,
            },
    });
  }

  /** Changes a device in the list, as an interview or a rename does. */
  async change(name: string, definition: ZigbeeDevice) {
    const device = this.devices.get(name)!;
    this.devices.delete(name);
    this.devices.set(definition.friendly_name!, { ...device, definition });
    await this.list();
  }

  /** The device leaves the network by itself, as one does after a reset. */
  async leave(name: string) {
    const { definition } = this.devices.get(name)!;
    this.devices.delete(name);
    await this.publish("bridge/event", {
      type: "device_leave",
      data: { friendly_name: name, ieee_address: definition.ieee_address },
    });
    await this.list();
  }

  /** Drops a device without saying so, as between two device lists. */
  forget(name: string) {
    this.devices.delete(name);
  }

  /** The device stops answering; Zigbee2MQTT says it is offline. */
  async unplug(name: string) {
    this.devices.get(name)!.answers = false;
    await this.publish(`${name}/availability`, { state: "offline" }, true);
  }

  /** The device says something of its own, as when its wall switch is used. */
  async say(name: string, state: Record<string, unknown>) {
    const device = this.devices.get(name)!;
    Object.assign(device.state, state);
    await this.publish(name, device.state);
  }

  /**
   * A remote's button is pressed: Zigbee2MQTT publishes the action with the
   * rest of the device's state, and never keeps the action in it.
   */
  async press(name: string, action: string, retain = false) {
    const device = this.devices.get(name)!;
    await this.publish(name, { ...device.state, action }, retain);
  }

  stateOf(name: string) {
    return this.devices.get(name)!.state;
  }

  /** Someone changes a device's options in Zigbee2MQTT's frontend. */
  async configure(name: string, options: Record<string, unknown>) {
    Object.assign(this.devices.get(name)!.options, options);
    await this.info();
  }

  /**
   * What firmware a device runs and the newest out for it, as Zigbee2MQTT
   * learns when the device asks for an image; it says so with the state.
   */
  async offerFirmware(name: string, installed: number, latest: number) {
    const device = this.devices.get(name)!;
    device.ota = { installed, latest };
    this.setUpdate(device, latest > installed ? "available" : "idle");
    await this.publish(name, device.state);
  }

  /**
   * Zigbee2MQTT restarts: as it starts, an update under way is forgotten
   * and its device's update state is idle again, with no answer for it.
   */
  restartDuringUpdates() {
    for (const device of this.devices.values()) {
      if (device.ota?.updating === undefined) continue;
      device.ota.updating = undefined;
      this.setUpdate(device, "idle");
    }
  }

  /** An update under way says how far it has come, with the device's state. */
  async otaProgress(name: string, progress: number, remaining: number) {
    const device = this.devices.get(name)!;
    if (device.ota) device.ota.updating ??= null;
    this.setUpdate(device, "updating", { progress, remaining });
    await this.publish(name, device.state);
  }

  /**
   * The update under way ends: it succeeded, and the device is interviewed
   * again with what it runs now, or it failed and is still available.
   */
  async otaEnd(name: string, outcome: "ok" | "error", newVersion = "2.0.0") {
    const device = this.devices.get(name)!;
    const ota = device.ota!;
    const transaction = ota.updating;
    ota.updating = undefined;
    if (outcome === "error") {
      this.setUpdate(device, "available");
      await this.publish(name, device.state);
      await this.publish("bridge/response/device/ota_update/update", {
        data: {},
        status: "error",
        error: `OTA update of '${name}' failed (Device didn't respond to OTA request)`,
        transaction,
      });
      return;
    }
    const from = ota.installed;
    ota.installed = ota.latest;
    this.setUpdate(device, "idle");
    await this.publish(name, device.state);
    await this.publish("bridge/response/device/ota_update/update", {
      data: {
        id: device.definition.ieee_address,
        from: { file_version: from },
        to: { file_version: ota.latest, software_build_id: newVersion },
      },
      status: "ok",
      transaction,
    });
    device.definition = {
      ...device.definition,
      software_build_id: newVersion,
    };
    await this.list();
  }

  /** The bridge stops answering, or comes back, while the broker stays up. */
  async setOnline(isOnline: boolean) {
    this.isOnline = isOnline;
    await this.publish(
      "bridge/state",
      { state: isOnline ? "online" : "offline" },
      true,
    );
  }

  /** Drops the driver's connection while the bridge keeps running. */
  async disconnectDriver() {
    const client = this.driverClient;
    if (!client) {
      throw new Error("No driver is connected");
    }
    await new Promise<void>((resolve) => client.close(resolve));
  }

  async publish(topic: string, payload: unknown, retain = false) {
    await this.client.publishAsync(
      `${base}/${topic}`,
      typeof payload === "string" ? payload : JSON.stringify(payload),
      { retain, qos: 1 },
    );
  }

  async stop() {
    await this.client.endAsync(true);
    await new Promise<void>((resolve) => this.broker.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async list() {
    await this.publish(
      "bridge/devices",
      [
        coordinator,
        ...[...this.devices.values()].map((each) => each.definition),
      ],
      true,
    );
  }

  private async receive(topic: string, raw: Buffer) {
    const name = topic.slice(base.length + 1);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (name === "bridge/request/permit_join") {
      this.received.push({ topic: name, payload });
      await this.answerPermitJoin(payload);
      return;
    }
    if (name === "bridge/request/device/remove") {
      this.received.push({ topic: name, payload });
      await this.answerRemove(payload);
      return;
    }
    if (name === "bridge/request/device/options") {
      this.received.push({ topic: name, payload });
      await this.answerOptions(payload);
      return;
    }
    if (name.startsWith(otaRequest)) {
      this.received.push({ topic: name, payload });
      await this.answerOta(name.slice(otaRequest.length), payload);
      return;
    }
    for (const action of ["set", "get"] as const) {
      const device = this.devices.get(name.slice(0, -`/${action}`.length));
      if (!name.endsWith(`/${action}`) || !device) {
        continue;
      }
      this.received.push({ topic: name, payload });
      if (!this.isOnline || !device.answers) {
        return;
      }
      if (action === "set") {
        apply(device.state, payload);
      }
      await this.publish(device.definition.friendly_name!, device.state);
    }
  }

  // As Zigbee2MQTT does: a device that does not answer stays unless it is
  // removed by force.
  private async answerRemove(request: Record<string, unknown>) {
    const { id, force, transaction } = request;
    if (!this.answersRemoval) {
      return;
    }
    const found = [...this.devices.entries()].find(
      ([name, device]) => device.definition.ieee_address === id || name === id,
    );
    if (!found || (!found[1].answers && force !== true)) {
      await this.publish("bridge/response/device/remove", {
        data: {},
        status: "error",
        error: found
          ? `Failed to remove device '${String(id)}' (block: false, force: false) (Error: Timeout)`
          : `Device '${String(id)}' does not exist`,
        transaction,
      });
      return;
    }
    this.devices.delete(found[0]);
    await this.list();
    await this.publish("bridge/response/device/remove", {
      data: { id, block: false, force: force === true },
      status: "ok",
      transaction,
    });
  }

  // As Zigbee2MQTT 2 does: the configuration it publishes on bridge/info
  // changes, then it answers with the options before and after.
  private async answerOptions(request: Record<string, unknown>) {
    const { id, options, transaction } = request;
    const found = [...this.devices.values()].find(
      (device) =>
        device.definition.ieee_address === id ||
        device.definition.friendly_name === id,
    );
    if (!found || !this.takesOptions) {
      await this.publish("bridge/response/device/options", {
        data: {},
        status: "error",
        error: found
          ? "Failed to change options"
          : `Device '${String(id)}' does not exist`,
        transaction,
      });
      return;
    }
    const from = { ...found.options };
    Object.assign(found.options, options);
    await this.info();
    await this.publish("bridge/response/device/options", {
      data: { id, from, to: { ...found.options }, restart_required: false },
      status: "ok",
      transaction,
    });
  }

  // What Zigbee2MQTT says of itself, with its configuration: whether
  // devices may join, and each device's options by IEEE address.
  private async info() {
    const devices = Object.fromEntries(
      [...this.devices.values()].map((device) => [
        device.definition.ieee_address,
        { friendly_name: device.definition.friendly_name, ...device.options },
      ]),
    );
    await this.publish(
      "bridge/info",
      {
        permit_join: this.joinEnd !== null && this.joinEnd > Date.now(),
        permit_join_end: this.joinEnd,
        config: { devices },
      },
      true,
    );
  }

  private setUpdate(
    device: Device,
    state: string,
    progress: { progress?: number; remaining?: number } = {},
  ) {
    device.state.update = {
      state,
      installed_version: device.ota?.installed,
      latest_version: device.ota?.latest,
      ...progress,
    };
  }

  // As Zigbee2MQTT's OTA extension answers each request: one at a time per
  // device, and only for a device it can update.
  private async answerOta(kind: string, request: Record<string, unknown>) {
    const { id, transaction } = request;
    const respond = (data: Record<string, unknown>, error?: string) =>
      this.publish(
        `bridge/response/device/ota_update/${kind}`,
        error
          ? { data: {}, status: "error", error, transaction }
          : { data, status: "ok", transaction },
      );
    const found = [...this.devices.entries()].find(
      ([name, device]) => device.definition.ieee_address === id || name === id,
    );
    if (!found) {
      await respond({}, `Device '${String(id)}' does not exist`);
      return;
    }
    const [name, device] = found;
    const ota = device.ota ?? { installed: 1, latest: 1 };
    device.ota = ota;
    if (kind === "update/abort") {
      if (ota.updating === undefined) {
        await respond({}, `No OTA in progress to abort for device '${name}'`);
        return;
      }
      // The update fails as it is aborted, then the abort is answered.
      const updating = ota.updating;
      ota.updating = undefined;
      await this.publish("bridge/response/device/ota_update/update", {
        data: {},
        status: "error",
        error: `OTA update of '${name}' failed (Aborted)`,
        transaction: updating,
      });
      this.setUpdate(device, "available");
      await this.publish(name, device.state);
      await respond({ id });
      return;
    }
    if (ota.updating !== undefined) {
      await respond(
        {},
        `OTA update or check for update already in progress for '${name}'`,
      );
      return;
    }
    if (!device.definition.definition?.supports_ota) {
      await respond({}, `Device '${name}' does not support OTA updates`);
      return;
    }
    if (!device.answers && (kind === "check" || kind === "update")) {
      await respond(
        {},
        `Failed to check if OTA update available for '${name}' (Device didn't respond to OTA request)`,
      );
      return;
    }
    if (kind === "check") {
      const available = ota.latest > ota.installed;
      this.setUpdate(device, available ? "available" : "idle");
      await this.publish(name, device.state);
      await respond({ id, update_available: available });
    } else if (kind === "update") {
      ota.updating = transaction;
    } else if (kind === "schedule") {
      this.setUpdate(device, "scheduled");
      await this.publish(name, device.state);
      await respond({ id });
    } else if (kind === "unschedule") {
      this.setUpdate(device, "idle");
      await this.publish(name, device.state);
      await respond({ id });
    }
  }

  private async answerPermitJoin(request: Record<string, unknown>) {
    const { time, transaction } = request;
    if (this.permitJoin === "silent") {
      return;
    }
    if (this.permitJoin === "error") {
      await this.publish("bridge/response/permit_join", {
        data: {},
        status: "error",
        error: "Coordinator is not started",
        transaction,
      });
      return;
    }
    await this.publish("bridge/response/permit_join", {
      data: { time },
      status: "ok",
      transaction,
    });
    this.joinEnd = Number(time) > 0 ? Date.now() + Number(time) * 1000 : null;
    await this.info();
  }
}
