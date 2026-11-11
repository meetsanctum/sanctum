import {
  ActionError,
  defineApp,
  type Actor,
  type AppContext,
  type DeviceJoining,
  type DeviceRegistration,
  type DriverCommand,
  type DriverDevice,
  type DriverMove,
  type DriverRemoval,
} from "@meetsanctum/app-sdk";

// A driver app for the tests, loaded from its package like a catalog app. It
// brings lamps, plugs, remotes, climate sensors and motion sensors (motion,
// light level and temperature, with their settings) from a pretend radio, the
// way the Zigbee app brings them from Zigbee2MQTT: it registers them when it
// starts and says those are all it has, carries out the commands the core hands
// it, and reports what the devices say back, remotes' presses and releases, and
// sensors' readings and battery. A lamp's brightness moves by itself while a
// remote is held, until the core stops it, and then says where it got to. While
// the core lets devices join, gadgets join it and say how they are getting on,
// and it takes gadgets off the air when the core removes them. Lamps' firmware
// can be updated and every gadget but a remote and a sensor can be asked how it
// is. Tests play the radio's side through the `radio` export.

type Gadget = {
  kind: "light" | "switch" | "button" | "sensor" | "occupancy";
  name: string;
  state: Record<string, unknown>;
  // Whether it still answers; an unplugged one takes nothing.
  answers: boolean;
};

const capabilityIds = {
  light: "light",
  switch: "power",
  button: "button",
} as const;
// What a remote's button can do, and which of that is a hold.
export const remoteActions = ["single", "double", "hold"];
export const remoteHolds = ["hold"];
const models = {
  light: "Lamp",
  switch: "Plug",
  button: "Remote",
  sensor: "Climate sensor",
  occupancy: "Motion sensor",
};
// A climate sensor's two readings and its battery, as it first says them.
const climate = { temperature: 21.5, humidity: 48, battery: 87 };
// A motion sensor's first report: no motion, its settings, its light level,
// its temperature and its battery.
const motion = {
  occupied: false,
  sensitivity: "medium",
  clearAfter: 60,
  indicator: true,
  illuminance: 320,
  temperature: 21,
  battery: 90,
};

class Radio {
  readonly gadgets = new Map<string, Gadget>();
  // Every command that reached the radio, with the actor behind it.
  readonly received: { command: DriverCommand; actor: Actor }[] = [];
  // Whether gadgets report back after a command; off, a command is never
  // confirmed.
  confirms = true;
  started = 0;
  stopped = 0;
  // Until when gadgets may join, and every time the core opened or closed
  // the radio for them, with the actor behind it.
  openUntil: Date | null = null;
  readonly pairing: { seconds: number; actor: Actor }[] = [];
  // How long the radio actually lets gadgets join, if not as asked, and
  // its clock, which a test sets to the core's.
  windowMs: number | undefined;
  clock = () => new Date();
  // Whether it refuses to let gadgets join, as a radio without its stick.
  refusesToOpen = false;
  // Every removal the core asked for, with the actor behind it.
  readonly removals: { removal: DriverRemoval; actor: Actor }[] = [];
  // The lamps a firmware update is out for, and every firmware call and
  // probe the core made, with the actor behind it.
  readonly updates = new Set<string>();
  readonly firmwareCalls: { hook: string; key: string; actor: Actor }[] = [];
  readonly probes: { key: string; actor: Actor }[] = [];
  // Whether asking a gadget never comes back, as a radio that hangs.
  probeHangs = false;
  // How long a stopped lamp takes to say where it got to; Zigbee2MQTT reads
  // one back half a second after its stop.
  stopReportMs = 0;
  // Every move the core asked of a lamp, with the actor behind it, and the
  // lamps moving now: which way, how fast and since when.
  readonly moves: { move: DriverMove; actor: Actor }[] = [];
  // Commands and moves in the order they reached the radio, such as
  // "lamp-1 up" or "lamp-1 command".
  readonly heard: string[] = [];
  readonly moving = new Map<
    string,
    { up: boolean; percentPerSecond: number; from: number; at: number }
  >();
  // The driver's own context, from start until stop.
  private ctx?: AppContext;

  // Puts a gadget in range, as pairing would.
  async add(key: string, kind: Gadget["kind"], name = key) {
    this.gadgets.set(key, {
      kind,
      name,
      state:
        kind === "light"
          ? {
              on: false,
              brightness: 100,
              colorMode: "temperature",
              colorTemperature: 370,
            }
          : kind === "sensor"
            ? { ...climate }
            : kind === "occupancy"
              ? { ...motion }
              : { on: false },
      answers: true,
    });
    if (this.ctx) {
      await this.bring(key);
    }
    return key;
  }

  async open(seconds: number, actor: Actor) {
    this.pairing.push({ seconds, actor });
    if (this.refusesToOpen) {
      throw new Error("the radio is not ready");
    }
    this.openUntil = new Date(
      this.clock().getTime() + (this.windowMs ?? seconds * 1000),
    );
    return { until: this.openUntil.toISOString() };
  }

  close(actor: Actor) {
    this.pairing.push({ seconds: 0, actor });
    this.openUntil = null;
  }

  // A gadget joins and says how it is getting on: once it is ready, the
  // driver brings it in. One the core cannot use stops there, and so does
  // one that fails.
  async join(
    key: string,
    kind: Gadget["kind"] | "doorbell",
    name = key,
    ends: "ready" | "failed" = "ready",
  ) {
    const ctx = this.ctx!;
    await ctx.devices.joining({ key, stage: "joined" });
    await ctx.devices.joining({ key, stage: "interviewing" });
    if (ends === "failed") {
      await ctx.devices.joining({ key, stage: "failed" });
    } else if (kind === "doorbell") {
      await ctx.devices.joining({
        key,
        stage: "unsupported",
        description: name,
      });
    } else {
      await this.add(key, kind, name);
      await ctx.devices.joining({ key, stage: "ready", description: name });
    }
  }

  // Says how a joining gadget is getting on, as the driver would.
  tell(key: string, stage: string) {
    return this.ctx!.devices.joining({ key, stage } as DeviceJoining);
  }

  // Takes a gadget off the air and says what it still has, before the core
  // forgets it. One that does not answer stays unless the removal is
  // forced; one the radio never had is gone already.
  async remove(removal: DriverRemoval, actor: Actor) {
    this.removals.push({ removal, actor });
    const gadget = this.gadgets.get(removal.key);
    if (gadget && !gadget.answers && !removal.force) {
      throw new Error(`${removal.key} does not answer`);
    }
    this.gadgets.delete(removal.key);
    await this.ctx?.devices.present({ keys: [...this.gadgets.keys()] });
  }

  // The core asks about a lamp's firmware: whether an update is out for
  // it, to start it or to stop it. The lamp says how it goes.
  async firmware(hook: string, { key }: DriverDevice, actor: Actor) {
    this.firmwareCalls.push({ hook, key, actor });
    const gadget = this.gadgets.get(key);
    if (!gadget?.answers) {
      throw new Error(`${key} does not answer`);
    }
    if (hook === "check") {
      await this.sayFirmware(key, {
        state: this.updates.has(key) ? "available" : "current",
      });
    } else if (hook === "update") {
      await this.sayFirmware(key, { state: "updating", progress: 0 });
    } else {
      await this.sayFirmware(key, { state: "available" });
    }
  }

  // Says what a lamp's firmware is doing, as the radio learns it.
  sayFirmware(
    key: string,
    firmware: {
      state: string;
      progress?: number;
      remainingSeconds?: number;
      problem?: string;
    },
  ) {
    return this.ctx!.devices.firmware({ key, ...firmware } as never);
  }

  // Asks a gadget how it is: one that answers says so a moment later.
  probe({ key }: DriverDevice, actor: Actor): Promise<void> {
    this.probes.push({ key, actor });
    if (this.probeHangs) {
      return new Promise(() => undefined);
    }
    if (this.gadgets.get(key)?.answers) {
      setImmediate(() => void this.say(key).catch(() => undefined));
    }
    return Promise.resolve();
  }

  async unplug(key: string) {
    this.gadgets.get(key)!.answers = false;
    await this.ctx?.devices.report({ key, availability: "offline" });
  }

  // A remote's button is pressed.
  async pressButton(key: string, action: string) {
    await this.ctx?.devices.press({
      key,
      capability: capabilityIds.button,
      action,
    });
  }

  // A remote's button is let go after a hold.
  async releaseButton(key: string) {
    await this.ctx?.devices.release({ key, capability: capabilityIds.button });
  }

  // A lamp's brightness moves by itself, from the lowest to full at most,
  // and says where it got to once stopped, as Zigbee2MQTT reads it back.
  async moveLight(asked: DriverMove, actor: Actor) {
    const { move, key } = asked;
    const gadget = this.gadgets.get(key);
    if (!gadget) {
      throw new ActionError("not_found", `No gadget ${key}`);
    }
    if (!gadget.answers) {
      throw new Error(`${key} does not answer`);
    }
    this.moves.push({ move: asked, actor });
    this.heard.push(`${key} ${move.move}`);
    const at = this.clock().getTime();
    const going = this.moving.get(key);
    if (going) {
      const moved = (going.percentPerSecond * (at - going.at)) / 1000;
      const level = going.from + (going.up ? moved : -moved);
      gadget.state.brightness = Math.round(Math.min(100, Math.max(1, level)));
      this.moving.delete(key);
    }
    if (move.move === "stop") {
      const say = () => void this.say(key).catch(() => undefined);
      if (this.stopReportMs > 0) setTimeout(say, this.stopReportMs);
      else setImmediate(say);
      return;
    }
    this.moving.set(key, {
      up: move.move === "up",
      percentPerSecond: move.percentPerSecond,
      from: gadget.state.brightness as number,
      at,
    });
  }

  // Something other than the core changed it, such as its wall switch.
  async press(key: string, state: Record<string, unknown>) {
    const gadget = this.gadgets.get(key)!;
    Object.assign(gadget.state, state);
    await this.say(key);
  }

  async attach(ctx: AppContext) {
    this.started += 1;
    this.ctx = ctx;
    for (const key of this.gadgets.keys()) {
      await this.bring(key);
    }
    await ctx.devices.present({ keys: [...this.gadgets.keys()] });
  }

  detach() {
    this.stopped += 1;
    this.ctx = undefined;
  }

  async carryOut(command: DriverCommand, actor: Actor) {
    const gadget = this.gadgets.get(command.key);
    if (!gadget) {
      throw new ActionError("not_found", `No gadget ${command.key}`);
    }
    if (!gadget.answers) {
      throw new Error(`${command.key} does not answer`);
    }
    this.received.push({ command, actor });
    this.heard.push(`${command.key} command`);
    const { transitionSeconds: _, ...fields } = command.command as Record<
      string,
      unknown
    >;
    Object.assign(gadget.state, fields);
    if ("colorTemperature" in fields) {
      gadget.state.colorMode = "temperature";
      delete gadget.state.hue;
      delete gadget.state.saturation;
    }
    if ("hue" in fields) {
      gadget.state.colorMode = "color";
      delete gadget.state.colorTemperature;
    }
    if (this.confirms) {
      // The gadget says what it did a moment later, as a radio does.
      setImmediate(() => void this.say(command.key).catch(() => undefined));
    }
  }

  reset() {
    this.gadgets.clear();
    this.received.length = 0;
    this.confirms = true;
    this.started = 0;
    this.stopped = 0;
    this.openUntil = null;
    this.pairing.length = 0;
    this.windowMs = undefined;
    this.clock = () => new Date();
    this.refusesToOpen = false;
    this.removals.length = 0;
    this.updates.clear();
    this.firmwareCalls.length = 0;
    this.probes.length = 0;
    this.probeHangs = false;
    this.stopReportMs = 0;
    this.moves.length = 0;
    this.heard.length = 0;
    this.moving.clear();
    this.ctx = undefined;
  }

  private async bring(key: string) {
    const gadget = this.gadgets.get(key)!;
    await this.ctx!.devices.register({
      key,
      name: gadget.name,
      manufacturer: "Test",
      model: models[gadget.kind],
      capabilities:
        gadget.kind === "sensor"
          ? sensorCapabilities
          : gadget.kind === "occupancy"
            ? motionCapabilities
            : [
                gadget.kind === "light"
                  ? {
                      id: capabilityIds.light,
                      kind: "light",
                      features: {
                        brightness: true,
                        colorTemperature: { min: 153, max: 500 },
                        color: true,
                      },
                    }
                  : gadget.kind === "button"
                    ? {
                        id: capabilityIds.button,
                        kind: "button",
                        features: {
                          actions: remoteActions,
                          holds: remoteHolds,
                        },
                      }
                    : { id: capabilityIds.switch, kind: "switch" },
              ],
      // A lamp's firmware can be updated, a plug's only read; a remote
      // sleeps between presses, and a sensor between readings.
      firmware: sleeps(gadget)
        ? null
        : { version: "1.0.0", updatable: gadget.kind === "light" },
      probe: !sleeps(gadget),
    });
    await this.ctx!.devices.report({
      key,
      availability: "online",
      ...reportOf(gadget),
    });
  }

  private async say(key: string) {
    const gadget = this.gadgets.get(key)!;
    if (gadget.kind === "button") return;
    await this.ctx?.devices.report({ key, ...reportOf(gadget) });
  }
}

const sleeps = (gadget: Gadget) =>
  gadget.kind === "button" ||
  gadget.kind === "sensor" ||
  gadget.kind === "occupancy";

// A motion sensor's motion, with its settings, and its two readings.
const motionCapabilities: DeviceRegistration["capabilities"] = [
  {
    id: "occupancy",
    kind: "occupancy",
    features: {
      senses: "motion",
      sensitivity: ["low", "medium", "high"],
      clearAfter: { min: 10, max: 3600 },
      indicator: true,
    },
  },
  { id: "illuminance", kind: "sensor", features: { measures: "illuminance" } },
  { id: "temperature", kind: "sensor", features: { measures: "temperature" } },
];

// A sensor's readings, each a capability.
const sensorCapabilities: DeviceRegistration["capabilities"] = [
  { id: "temperature", kind: "sensor", features: { measures: "temperature" } },
  { id: "humidity", kind: "sensor", features: { measures: "humidity" } },
];

// What a gadget says of itself: a remote has no state, only presses; a
// sensor says its readings and its battery.
function reportOf(gadget: Gadget) {
  if (gadget.kind === "button") return {};
  if (gadget.kind === "occupancy") {
    const { illuminance, temperature, battery, ...occupancy } = gadget.state;
    return {
      states: {
        occupancy,
        illuminance: { value: illuminance },
        temperature: { value: temperature },
      },
      battery: battery as number,
    };
  }
  if (gadget.kind === "sensor") {
    const { temperature, humidity, battery } = gadget.state;
    return {
      states: {
        temperature: { value: temperature },
        humidity: { value: humidity },
      },
      battery: battery as number,
    };
  }
  return { states: { [capabilityIds[gadget.kind]]: { ...gadget.state } } };
}

export const radio = new Radio();

export default defineApp({
  id: "test.lamps",
  name: "Lamps",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [
    { id: "devices.register", reason: "For the test.", needed: true },
  ],
  actions: [],
  events: [],
  async start(ctx) {
    await radio.attach(ctx);
  },
  async stop() {
    radio.detach();
  },
  driver: {
    async command(ctx, command) {
      await radio.carryOut(command, ctx.actor);
    },
    pairing: {
      open: async (ctx, { seconds }) => radio.open(seconds, ctx.actor),
      close: async (ctx) => radio.close(ctx.actor),
    },
    async remove(ctx, removal) {
      await radio.remove(removal, ctx.actor);
    },
    firmware: {
      check: (ctx, device) => radio.firmware("check", device, ctx.actor),
      update: (ctx, device) => radio.firmware("update", device, ctx.actor),
      stop: (ctx, device) => radio.firmware("stop", device, ctx.actor),
    },
    async probe(ctx, device) {
      await radio.probe(device, ctx.actor);
    },
    async move(ctx, move) {
      await radio.moveLight(move, ctx.actor);
    },
  },
});
