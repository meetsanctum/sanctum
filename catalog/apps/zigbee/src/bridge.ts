import {
  ActionError,
  type AppContext,
  type DriverCommand,
  type DriverDevice,
  type DriverMove,
  type DriverRemoval,
  type LightCommand,
  type OccupancyCommand,
  type SwitchCommand,
} from "@meetsanctum/app-sdk";
import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";

import { deviceEntries, type ZigbeeDeviceEntry } from "./devices.js";
import { createFirstList } from "./first-list.js";
import { firmwareOf } from "./firmware.js";
import { createFirmwareUpdates, firmwareRequests } from "./firmware-updates.js";
import { createJoining } from "./joining.js";
import { MessageQueue } from "./message-queue.js";
import { createMotionTiming } from "./motion-timing.js";
import {
  occupancyPayload,
  occupancyState,
  type OccupancyMapping,
} from "./occupancy.js";
import { createHolds, type Heard } from "./presses.js";
import { bridgeResponse, createPendingRequests } from "./requests.js";
import { batteryOf, sensorState } from "./sensors.js";
import { commandPayload, movePayload, stateFromPayload } from "./states.js";
import {
  defaultBaseTopic,
  type ZigbeeDevice,
  type ZigbeeMessage,
} from "./types.js";
import {
  availabilityValue,
  isRecord,
  numericValue,
  parseJson,
  stringValue,
} from "./values.js";

// The driver's connection to Zigbee2MQTT, through the broker account the
// core hands it (ctx.services.connection), from the app's start until its
// stop. Rewritten from v1's createZigbee2mqttIntegration and its handlers
// (zigbee2mqtt.ts, zigbee2mqtt-handlers.ts, Pragmata v1-final) against the
// Drivers contract: the devices Zigbee2MQTT lists are registered with the
// core, what they say is reported, and the core's commands are published on
// <device>/set for the device's report to confirm, as are its moves of a
// light's brightness while a remote is held, or for how long an Aqara
// motion sensor waits, as Zigbee2MQTT's device option (motion-timing.ts).
// While the core lets devices join, the driver says how each one that
// joins is getting on, and it asks Zigbee2MQTT to remove a device when the
// core removes it. It
// follows each device's firmware as Zigbee2MQTT publishes it with the
// device's state, and checks for, starts and stops updates over the air
// and asks a device how it is when someone asks.

export type BridgeOptions = {
  /** How long Zigbee2MQTT has to answer a request, in ms. */
  answerMs?: number;
  /** How long it has to remove a device, which waits for the device, in ms. */
  removeMs?: number;
  /** How long a command waits for a lost broker connection to come back, in ms. */
  reconnectWaitMs?: number;
  /** How long Zigbee2MQTT has to answer a firmware check, which waits for the device, in ms. */
  checkMs?: number;
  /** How long an update over the air may take before the driver gives up on it, in ms. */
  updateMs?: number;
  /** How often the driver tells the core of an update's progress at most, in ms. */
  progressEveryMs?: number;
  /** How often it tells the core an update is still under way, in ms. */
  heartbeatMs?: number;
  /** How long its start waits for Zigbee2MQTT's device list, in ms. */
  listWithinMs?: number;
};

export type BridgeStatus = {
  broker: "connecting" | "connected" | "disconnected";
  bridge: "online" | "offline" | "unknown";
  /** Until when new devices may join, while they may. */
  joinUntil: string | null;
};

// The requests the driver makes of Zigbee2MQTT, answered on
// bridge/response/<name>.
const requestNames = [
  "permit_join",
  "device/remove",
  "device/options",
  ...firmwareRequests,
] as const;
type RequestName = (typeof requestNames)[number];

const bridgeTopics = [
  "state",
  "info",
  "devices",
  "event",
  ...requestNames.map((name) => `response/${name}`),
];

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createBridge(ctx: AppContext, options: BridgeOptions = {}) {
  const reconnectWaitMs = options.reconnectWaitMs ?? 3_000;
  // Removing a device that does not answer takes Zigbee2MQTT a while to
  // give up on; the core waits 30 seconds for the driver.
  const removeMs = options.removeMs ?? 25_000;
  // A check waits for the device to ask for its image; the core waits 30
  // seconds for the driver. An update answers only once it has ended,
  // which takes an hour or more.
  const checkMs = options.checkMs ?? 25_000;
  const updateMs = options.updateMs ?? 4 * 60 * 60_000;
  const requests = createPendingRequests(options.answerMs ?? 10_000);
  const status: BridgeStatus = {
    broker: "connecting",
    bridge: "unknown",
    joinUntil: null,
  };
  let base = defaultBaseTopic;
  let queue: MessageQueue | undefined;
  let client: MqttClient | undefined;
  let closed = false;
  let draining = false;
  let needsStateRefresh = false;
  let lastError: string | undefined;
  let droppedLoggedAt = 0;
  // The devices in Zigbee2MQTT's latest list that the core has taken, by
  // key and by name.
  const devices = new Map<string, ZigbeeDeviceEntry>();
  const byName = new Map<string, ZigbeeDeviceEntry>();
  // The registration the core last took for each key, so an unchanged
  // list registers nothing again.
  const registered = new Map<string, string>();
  // Every device in Zigbee2MQTT's latest list, by key, taken or not; none
  // until the first list arrives.
  let listed: Set<string> | undefined;
  // That list as it came, to register a device again from.
  let latestList: unknown = [];
  const firstList = createFirstList(options.listWithinMs ?? 20_000);
  const joining = createJoining((key, stage, description) =>
    ctx.devices.joining({ key, stage, description }),
  );
  // Each remote's holds, said once until its release.
  const holds = createHolds();
  const firmware = createFirmwareUpdates({
    ctx,
    devices,
    send,
    isOnline: () => status.bridge === "online" && !!client?.connected,
    isClosed: () => closed,
    checkMs,
    updateMs,
    progressEveryMs: options.progressEveryMs,
    heartbeatMs: options.heartbeatMs,
  });
  const timing = createMotionTiming({
    ctx,
    device: (key) => devices.get(key),
    request,
    registerAgain,
  });

  const topic = (...parts: string[]) => [base, ...parts].join("/");
  const deviceTopics = (name: string) => [
    topic(name),
    topic(name, "availability"),
  ];

  function subscribe(topics: string[]) {
    if (topics.length > 0 && client?.connected) {
      client.subscribeAsync(topics).catch((error: unknown) => {
        ctx.log(
          `could not subscribe to ${topics.join(", ")} (${messageOf(error)})`,
        );
      });
    }
  }

  function unsubscribe(topics: string[]) {
    if (topics.length > 0 && client?.connected) {
      client.unsubscribeAsync(topics).catch(() => undefined);
    }
  }

  // The client once the broker answers; a command does not wait long for
  // a connection that was lost.
  async function connected() {
    const deadline = Date.now() + reconnectWaitMs;
    while (!closed && !client?.connected) {
      if (Date.now() >= deadline) {
        throw new Error("not connected to the broker");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (closed || !client) {
      throw new Error("the Zigbee app has stopped");
    }
    return client;
  }

  async function publish(to: string, payload: unknown) {
    const mqttClient = await connected();
    await mqttClient.publishAsync(to, JSON.stringify(payload), { qos: 0 });
  }

  // Asks a device that is awake what it shows now, so the core learns it
  // without waiting for the device to change. Battery-powered devices
  // sleep and would not answer. Resolves once asked.
  async function ask(device: ZigbeeDeviceEntry) {
    const properties = device.capabilities.flatMap((each) => each.readable);
    if (device.battery || properties.length === 0) {
      return false;
    }
    await publish(
      topic(device.friendlyName, "get"),
      Object.fromEntries(properties.map((property) => [property, ""])),
    );
    return true;
  }

  function read(device: ZigbeeDeviceEntry) {
    ask(device).catch((error: unknown) => {
      ctx.log(`could not read ${device.friendlyName} (${messageOf(error)})`);
    });
  }

  // Registers a device unless the core has it as it is; false when the
  // core would not take it.
  async function take(entry: ZigbeeDeviceEntry) {
    if (closed) return false;
    const registration = JSON.stringify(entry.registration);
    if (registered.get(entry.key) === registration) {
      return true;
    }
    try {
      await ctx.devices.register(entry.registration);
    } catch (error) {
      ctx.log(`could not register ${entry.friendlyName} (${messageOf(error)})`);
      return false;
    }
    if (!registered.has(entry.key)) {
      ctx.log(`registered ${entry.friendlyName} (${entry.key})`);
    }
    registered.set(entry.key, registration);
    return true;
  }

  // What the driver keeps of a device until it is back in a list.
  function forgetState(key: string) {
    registered.delete(key);
    firmware.forget(key);
    timing.forget(key);
  }

  async function syncDevices(payload: unknown) {
    if (!Array.isArray(payload)) return;
    latestList = payload;
    const list = payload.filter(isRecord) as ZigbeeDevice[];
    listed = new Set(
      list.flatMap((device) => stringValue(device.ieee_address) ?? []),
    );
    // A device that left the list is registered afresh if it comes back,
    // as when it is removed and joins again.
    for (const key of registered.keys()) {
      if (!listed.has(key)) {
        forgetState(key);
      }
    }
    const subscribed = new Set(byName.keys());
    const taken: ZigbeeDeviceEntry[] = [];
    for (const entry of deviceEntries(payload, timing.intervals)) {
      if (await take(entry)) {
        taken.push(entry);
        continue;
      }
      // The core keeps what it took before, so a device it has stays
      // reachable as it was, under its current name, until the next list
      // tries again.
      const previous = devices.get(entry.key);
      if (previous) {
        taken.push({ ...previous, friendlyName: entry.friendlyName });
      }
    }
    if (closed) {
      return;
    }
    devices.clear();
    byName.clear();
    for (const entry of taken) {
      devices.set(entry.key, entry);
      byName.set(entry.friendlyName, entry);
    }
    // The list is every device Zigbee2MQTT has, so the core marks the rest
    // offline: one that left by itself, as after a reset, even while the
    // driver was not running, stays in the core until someone removes it
    // or it joins again, as itself; until then nothing reaches it. One the
    // core is removing it forgets instead. A device the core would not take
    // this time is still on the network.
    let unsaid: string | undefined;
    await ctx.devices.present({ keys: [...listed] }).catch((error: unknown) => {
      unsaid = messageOf(error);
      ctx.log(`could not say which devices are here (${unsaid})`);
    });
    unsubscribe(
      [...subscribed].filter((name) => !byName.has(name)).flatMap(deviceTopics),
    );
    const added = taken.filter((entry) => !subscribed.has(entry.friendlyName));
    subscribe(added.flatMap((entry) => deviceTopics(entry.friendlyName)));
    // What changed while the broker was away is lost with the session, so
    // after a reconnect it reads every device again, by its current name.
    (needsStateRefresh ? taken : added).forEach(read);
    needsStateRefresh = false;
    await joining.listed(list, (key) => devices.has(key));
    // The start waits for the first list. A device the core wouldn't take
    // stays out, as on any list; a core that can't hear which are here fails it.
    firstList.taken(unsaid);
  }

  // Forgets a device Zigbee2MQTT no longer has, so nothing it said late
  // reaches the core.
  function forget(key: string) {
    const device = devices.get(key);
    devices.delete(key);
    forgetState(key);
    holds.forget(key);
    listed?.delete(key);
    if (device) {
      byName.delete(device.friendlyName);
      unsubscribe(deviceTopics(device.friendlyName));
    }
  }

  // Registers a device again from the latest list, with what the driver
  // has learned of it since.
  async function registerAgain(key: string) {
    const entry = deviceEntries(latestList, timing.intervals).find(
      (each) => each.key === key,
    );
    if (!entry || !(await take(entry)) || closed) {
      return devices.get(key);
    }
    devices.set(entry.key, entry);
    byName.set(entry.friendlyName, entry);
    return entry;
  }

  async function reportState(found: ZigbeeDeviceEntry, payload: Buffer) {
    const raw = parseJson(payload);
    if (!isRecord(raw)) {
      return;
    }
    const device = await timing.said(found, raw);
    const states: Record<string, unknown> = {};
    const heard: { capability: string; heard: NonNullable<Heard> }[] = [];
    for (const capability of device.capabilities) {
      if (capability.kind === "button") {
        const said = holds.heard(device.key, capability, raw);
        if (said) heard.push({ capability: capability.id, heard: said });
        continue;
      }
      if (capability.kind === "occupancy") {
        const state = occupancyState(
          capability,
          raw,
          timing.timingOf(device.key),
        );
        if (state) {
          states[capability.id] = state;
          timing.reported(device.key, capability, state);
        }
        continue;
      }
      const state =
        capability.kind === "sensor"
          ? sensorState(capability, raw)
          : stateFromPayload(capability, raw);
      if (state) {
        states[capability.id] = state;
      }
    }
    // A message from the device means it answers. A battery-powered one
    // says its charge with its state.
    const battery = batteryOf(raw);
    await ctx.devices.report({
      key: device.key,
      availability: "online",
      states,
      ...(battery === undefined ? {} : { battery }),
    });
    // Each press is said once: Zigbee2MQTT never keeps a device's action
    // in the state it publishes again, and retained messages never get here.
    // A release says the button was let go.
    for (const { capability, heard: said } of heard) {
      await ("press" in said
        ? ctx.devices.press({ key: device.key, capability, action: said.press })
        : ctx.devices.release({ key: device.key, capability }));
    }
    // Zigbee2MQTT publishes what it knows of the firmware with every state.
    const said = firmwareOf(raw.update);
    if (said) {
      await firmware.say(device, said);
    }
  }

  // Changes a motion sensor's settings: Zigbee2MQTT's option first, which
  // it may refuse, then the sensor's own on <device>/set, which its report
  // confirms.
  async function setOccupancy(
    device: ZigbeeDeviceEntry,
    capability: OccupancyMapping,
    command: OccupancyCommand,
  ) {
    const { set, option } = occupancyPayload(capability, command);
    if (option !== null) {
      await timing.set(device, option);
    }
    if (Object.keys(set).length > 0) {
      await publish(topic(device.friendlyName, "set"), set);
    }
  }

  async function reportAvailability(
    device: ZigbeeDeviceEntry,
    payload: Buffer,
  ) {
    const availability = availabilityValue(payload);
    // A battery-powered device that has not been heard from is likely
    // asleep rather than gone (v1's normalizeDeviceAvailability).
    await ctx.devices.report({
      key: device.key,
      availability:
        availability === "offline" && device.battery ? "unknown" : availability,
    });
  }

  async function noteEvent(payload: Buffer) {
    const event = parseJson(payload);
    if (!isRecord(event) || !isRecord(event.data)) {
      return;
    }
    await joining.event(event.type, event.data);
    const name =
      stringValue(event.data.friendly_name) ??
      stringValue(event.data.ieee_address) ??
      "a device";
    if (event.type === "device_joined") {
      ctx.log(`${name} joined the network`);
    } else if (event.type === "device_leave") {
      ctx.log(`${name} left the network`);
    } else if (event.type === "device_interview") {
      ctx.log(
        `${name}: interview ${stringValue(event.data.status) ?? "update"}`,
      );
    }
  }

  async function noteInfo(payload: Buffer) {
    const info = parseJson(payload);
    if (!isRecord(info)) {
      return;
    }
    const end = numericValue(info.permit_join_end);
    status.joinUntil =
      info.permit_join === true && end !== null
        ? new Date(end < 1e12 ? end * 1000 : end).toISOString()
        : null;
    await timing.configured(info.config);
  }

  async function handle({ topic: name, payload, retained }: ZigbeeMessage) {
    const bridge = topic("bridge", "");
    if (name.startsWith(bridge)) {
      const subject = name.slice(bridge.length);
      if (subject === "devices") {
        await syncDevices(parseJson(payload));
      } else if (subject === "state") {
        const state = availabilityValue(payload);
        if (state !== status.bridge) {
          ctx.log(`Zigbee2MQTT is ${state}`);
          if (state === "online") {
            // The retained list may arrive while Zigbee2MQTT is stopped,
            // with nobody to answer the reads it led to.
            devices.forEach(read);
          }
        }
        status.bridge = state;
      } else if (subject === "info") {
        await noteInfo(payload);
      } else if (subject === "event") {
        await noteEvent(payload);
      }
      return;
    }
    const rest = name.slice(base.length + 1);
    const suffix = "/availability";
    if (rest.endsWith(suffix)) {
      const device = byName.get(rest.slice(0, -suffix.length));
      if (device) {
        await reportAvailability(device, payload);
      }
      return;
    }
    // A device's retained state is older than anything the core may have
    // heard since; Zigbee2MQTT keeps none unless someone configured it to.
    const device = byName.get(rest);
    if (device && !retained) {
      await reportState(device, payload);
    }
  }

  // Handles waiting messages one at a time, in order.
  async function drain() {
    draining = true;
    try {
      for (
        let message = queue?.next();
        message && !closed;
        message = queue?.next()
      ) {
        try {
          await handle(message);
        } catch (error) {
          ctx.log(`could not handle ${message.topic} (${messageOf(error)})`);
        }
      }
    } finally {
      draining = false;
    }
  }

  // Asks Zigbee2MQTT's bridge for something, resolving once the request
  // is out with its answer to come, told apart from others by its
  // transaction.
  async function send(
    name: RequestName,
    payload: Record<string, unknown>,
    ms?: number,
  ) {
    const transaction = `sanctum-${randomUUID()}`;
    const answer = requests.wait(transaction, name.replace(/[_/]/g, " "), ms);
    // Awaited once the request is out; until then a refusal or a timeout
    // must not go unhandled.
    answer.catch(() => undefined);
    try {
      await publish(topic("bridge", "request", name), {
        ...payload,
        transaction,
      });
    } catch (error) {
      requests.forget(transaction);
      throw error;
    }
    return { answer };
  }

  // Asks and waits for the answer.
  async function request(
    name: RequestName,
    payload: Record<string, unknown>,
    ms?: number,
  ) {
    return (await send(name, payload, ms)).answer;
  }

  function receive(message: ZigbeeMessage) {
    if (closed || !queue) {
      return;
    }
    firstList.receive(message, base);
    if (
      requestNames.some(
        (name) => message.topic === topic("bridge", "response", name),
      )
    ) {
      requests.answer(bridgeResponse(message.payload));
      return;
    }
    const { dropped } = queue.enqueue(message);
    if (dropped > 0 && Date.now() - droppedLoggedAt > 30_000) {
      droppedLoggedAt = Date.now();
      ctx.log(`dropped ${dropped} messages it could not keep up with`);
    }
    if (!draining) {
      void drain();
    }
  }

  return {
    /**
     * Gets the broker account from the core, then connects and keeps
     * reconnecting until close. Resolves once it has started connecting.
     */
    async open() {
      const connection = await ctx.services.connection("zigbee2mqtt");
      const account = connection.mqtt;
      if (closed) {
        return;
      }
      if (!account) {
        throw new Error(
          "the zigbee2mqtt service came without a broker account",
        );
      }
      base = stringValue(connection.baseTopic) ?? defaultBaseTopic;
      queue = new MessageQueue(base);
      const mqttClient = mqtt.connect(account.url, {
        username: account.username,
        password: account.password,
        clientId: `sanctum-zigbee-${randomUUID().slice(0, 8)}`,
        reconnectPeriod: 2_000,
        // It subscribes again itself on every connection.
        resubscribe: false,
        // A command that waited for the broker would switch a light long
        // after it was asked.
        queueQoSZero: false,
      });
      client = mqttClient;
      mqttClient.on("connect", () => {
        firstList.connected();
        needsStateRefresh = true;
        status.broker = "connected";
        lastError = undefined;
        ctx.log(`connected to the broker at ${account.url}`);
        subscribe([
          ...bridgeTopics.map((each) => topic("bridge", each)),
          ...[...byName.keys()].flatMap(deviceTopics),
        ]);
      });
      mqttClient.on("close", () => {
        if (status.broker === "connected" && !closed) {
          ctx.log("lost the broker; reconnecting");
        }
        status.broker = "disconnected";
        firstList.disconnected();
      });
      mqttClient.on("error", (error) => {
        // Said once, not on every attempt to reconnect.
        if (error.message !== lastError) {
          lastError = error.message;
          ctx.log(`broker: ${error.message}`);
        }
      });
      mqttClient.on("message", (to, payload, packet) =>
        receive({ topic: to, payload, retained: packet.retain }),
      );
    },

    /** Once its first device list is registered and said to the core. */
    listed: () => firstList.wait(),

    /**
     * Moves a light's brightness up or down at a rate, or stops it, with
     * Zigbee2MQTT's brightness_move; once stopped, Zigbee2MQTT reads the
     * light back and publishes where it got to.
     */
    async move(move: DriverMove) {
      const device = devices.get(move.key);
      const capability = device?.capabilities.find(
        (each) => each.id === move.capability && each.kind === "light",
      );
      if (!device || capability?.kind !== "light") {
        throw new ActionError(
          "not_found",
          `No Zigbee device ${move.key} with a light ${move.capability}`,
        );
      }
      const payload = movePayload(capability, move.move);
      if (!payload) {
        throw new ActionError(
          "conflict",
          `${device.friendlyName} cannot dim, so it cannot move`,
        );
      }
      await publish(topic(device.friendlyName, "set"), payload);
    },

    /** Carries out a command the core hands the driver; the device's report confirms it. */
    async command(command: DriverCommand) {
      const device = devices.get(command.key);
      const capability = device?.capabilities.find(
        (each) => each.id === command.capability && each.kind === command.kind,
      );
      // A button and a sensor take no commands, and the core sends them none.
      if (
        !device ||
        !capability ||
        capability.kind === "button" ||
        capability.kind === "sensor"
      ) {
        throw new ActionError(
          "not_found",
          `No Zigbee device ${command.key} with a ${command.kind} ${command.capability}`,
        );
      }
      // The capability is of the command's kind (above).
      if (capability.kind === "occupancy") {
        await setOccupancy(
          device,
          capability,
          command.command as OccupancyCommand,
        );
        return;
      }
      await publish(
        topic(device.friendlyName, "set"),
        commandPayload(
          capability,
          command.command as LightCommand | SwitchCommand,
        ),
      );
    },

    /**
     * Lets new devices join for `seconds`, or no longer with 0, once
     * Zigbee2MQTT says so. A device that joins is registered once its
     * interview succeeds.
     */
    async permitJoin(seconds: number) {
      await request("permit_join", { time: seconds });
      status.joinUntil =
        seconds > 0
          ? new Date(Date.now() + seconds * 1000).toISOString()
          : null;
      return { until: status.joinUntil };
    },

    /**
     * Has Zigbee2MQTT remove a device from the network, by its IEEE
     * address, which outlives renames. By force it drops the device from
     * its database even if the device does not answer. A device that is
     * not in its list, or that it says does not exist, as when the list
     * has yet to arrive, has gone already.
     */
    async remove({ key, force }: Pick<DriverRemoval, "key" | "force">) {
      if (listed && !listed.has(key)) {
        forget(key);
        return;
      }
      try {
        await request("device/remove", { id: key, force }, removeMs);
      } catch (error) {
        if (!/does not exist/i.test(messageOf(error))) {
          throw error;
        }
      }
      forget(key);
      ctx.log(`removed ${key}${force ? " by force" : ""}`);
    },

    /** Checks for, starts and stops updates over the air (firmware-updates.ts). */
    checkFirmware: (device: DriverDevice) => firmware.check(device),
    updateFirmware: (device: DriverDevice) => firmware.update(device),
    stopFirmware: (device: DriverDevice) => firmware.stop(device),

    /** Asks a device how it is now; its state answers (Check connection). */
    async probe({ key }: DriverDevice) {
      const device = devices.get(key);
      if (!device) {
        throw new ActionError("not_found", `No Zigbee device ${key}`);
      }
      if (!(await ask(device))) {
        throw new ActionError(
          "conflict",
          `${device.friendlyName} sleeps or has nothing to read`,
        );
      }
    },

    status(): BridgeStatus {
      const { joinUntil } = status;
      return {
        ...status,
        joinUntil:
          joinUntil && Date.parse(joinUntil) > Date.now() ? joinUntil : null,
      };
    },

    async close() {
      closed = true;
      firstList.close();
      firmware.close();
      queue?.clear();
      requests.cancel("the Zigbee app stopped");
      const mqttClient = client;
      client = undefined;
      await mqttClient?.endAsync(true);
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
