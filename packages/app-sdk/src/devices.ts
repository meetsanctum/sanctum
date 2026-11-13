import { z } from "zod";

import type { DeviceType } from "./device-types.js";
import type { FirmwareInfo } from "./firmware.js";
import type { Actor, Tier } from "./index.js";

// Devices and their typed capabilities: the core's contract with driver
// apps, which bring devices in, and with the apps that use them. A light
// should not care which protocol it uses, so a capability's state and
// commands are the same whatever driver brings it. Each capability kind is a
// core contract with its own version.

// Colour temperature in mireds (1,000,000 / kelvin), as Zigbee and most
// lights use it.
const mired = z.number().int().min(50).max(1000);
const percent = z.number().int().min(0).max(100);
const hue = z.number().min(0).max(360);
const saturation = z.number().min(0).max(100);

const lightFeatures = z.strictObject({
  brightness: z.boolean().default(false),
  colorTemperature: z
    .strictObject({ min: mired, max: mired })
    .refine((range) => range.min <= range.max, "min must not exceed max")
    .nullable()
    .default(null),
  color: z.boolean().default(false),
});

const lightState = z.strictObject({
  on: z.boolean(),
  brightness: percent.optional(),
  colorMode: z.enum(["temperature", "color"]).optional(),
  colorTemperature: mired.optional(),
  hue: hue.optional(),
  saturation: saturation.optional(),
});

// A command asks for state: whatever it leaves out stays as it is. An "off"
// with a brightness or colour says what the light comes back at, which the
// core holds until it turns on.
const lightCommand = z
  .strictObject({
    on: z.boolean().optional(),
    // 0 turns the light off.
    brightness: percent.optional(),
    colorTemperature: mired.optional(),
    hue: hue.optional(),
    saturation: saturation.optional(),
    transitionSeconds: z.number().min(0).max(3600).optional(),
  })
  .refine(
    (command) =>
      (command.hue === undefined) === (command.saturation === undefined),
    "hue and saturation go together",
  )
  .refine(
    (command) =>
      command.hue === undefined || command.colorTemperature === undefined,
    "a colour or a colour temperature, not both",
  )
  .refine(
    (command) =>
      command.on !== undefined ||
      command.brightness !== undefined ||
      command.colorTemperature !== undefined ||
      command.hue !== undefined,
    "a command asks for something",
  );

/**
 * A light's brightness moving by itself, as while a remote's button is held:
 * up or down at a rate until a stop, or the stop. It asks for no state, so
 * nothing waits for it to be confirmed: the light's reports say where it got
 * to. A driver that can move its lights has driver.move.
 */
export const lightMove = z.discriminatedUnion("move", [
  z.strictObject({
    move: z.enum(["up", "down"]),
    // Of the light's whole range, so 25 goes from lowest to full in 4 s.
    percentPerSecond: z.number().int().min(1).max(100),
  }),
  z.strictObject({ move: z.literal("stop") }),
]);
export type LightMove = z.output<typeof lightMove>;

const switchFeatures = z.strictObject({});
const switchState = z.strictObject({ on: z.boolean() });
const switchCommand = z.strictObject({ on: z.boolean() });

/**
 * One of a button's press actions, by its driver's name, such as single,
 * double, hold or Zigbee2MQTT's on_press and up_hold.
 */
export const buttonAction = z
  .string()
  .regex(
    /^[A-Za-z0-9][\w.:-]{0,63}$/,
    "use a short action name such as single",
  );

// The words for a kind of press at the end of an action's name.
const pressWords = new Set([
  "press",
  "hold",
  "click",
  "single",
  "double",
  "triple",
  "quadruple",
  "many",
  "long",
]);

/**
 * One of a remote's actions as its button and the press, as drivers name
 * them: up_hold is the up button's hold and button_1_double button 1's
 * double press; single, with no button named, is the remote's one button.
 */
export function pressParts(action: string): {
  button: string | null;
  press: string;
} {
  const words = action.split("_");
  const press = words.at(-1)!;
  return words.length > 1 && pressWords.has(press.toLowerCase())
    ? { button: words.slice(0, -1).join("_"), press }
    : { button: null, press: action };
}

// A button says which presses it makes, and which of them are holds: a
// press that lasts until the button is let go, which the driver says
// (ctx.devices.release), so a hold can brighten or dim lights while it
// lasts. It has no state: a press is momentary, so it reaches the core as
// an event (ctx.devices.press), never as state, and the button takes no
// commands.
const buttonFeatures = z
  .strictObject({
    actions: z
      .array(buttonAction)
      .min(1)
      .max(64)
      .refine((list) => new Set(list).size === list.length, "each action once"),
    holds: z.array(buttonAction).max(64).default([]),
  })
  .refine(
    (features) =>
      features.holds.every((hold) => features.actions.includes(hold)),
    "a hold is one of its actions",
  );
const buttonState = z.never();
const buttonCommand = z.never();

/**
 * What a sensor measures, each in its standard unit whatever the device
 * says: a temperature in degrees Celsius, a relative humidity in percent,
 * a light level (illuminance) in lux. Standard units keep readings
 * comparable, as `weather.forecast`'s are: a rule such as "below 18 °C" must
 * not change meaning when a household changes how the home shows
 * temperatures.
 */
export const sensorMeasures = [
  "temperature",
  "humidity",
  "illuminance",
] as const;
export type SensorMeasure = (typeof sensorMeasures)[number];

// A sensor says one reading, so a device that measures two has two
// capabilities, as a double switch has two switches. It takes no commands.
const sensorFeatures = z.strictObject({ measures: z.enum(sensorMeasures) });
const sensorState = z.strictObject({ value: z.number() });
const sensorCommand = z.never();

/**
 * How readily a motion sensor sees motion, lowest first. A sensor declares
 * the levels it has, in this order, such as low, medium and high.
 */
export const occupancySensitivities = [
  "low",
  "medium",
  "high",
  "very_high",
  "max",
] as const;
export type OccupancySensitivity = (typeof occupancySensitivities)[number];

const sensitivity = z.enum(occupancySensitivities);
// How long after the last movement it says no motion, in seconds.
const clearAfter = z.number().int().min(0).max(65_535);

// Whether someone is there, and what senses it: motion, from a PIR sensor.
// Its settings are the device's own, each only where the sensor has it: its
// sensitivity's levels, the range of how long it waits after the last
// movement before it says no motion, and whether its light blinks when it
// sees motion.
const occupancyFeatures = z.strictObject({
  senses: z.enum(["motion"]),
  sensitivity: z
    .array(sensitivity)
    .min(2)
    .max(occupancySensitivities.length)
    .refine(
      (levels) =>
        levels.every(
          (level, index) =>
            index === 0 ||
            occupancySensitivities.indexOf(level) >
              occupancySensitivities.indexOf(levels[index - 1]!),
        ),
      "each level once, lowest first",
    )
    .nullable()
    .default(null),
  clearAfter: z
    .strictObject({ min: clearAfter, max: clearAfter })
    .refine((range) => range.min <= range.max, "min must not exceed max")
    .nullable()
    .default(null),
  indicator: z.boolean().default(false),
});

// Whether it sees someone now, with its settings as it last reported them.
const occupancyState = z.strictObject({
  occupied: z.boolean(),
  sensitivity: sensitivity.optional(),
  clearAfter: clearAfter.optional(),
  indicator: z.boolean().optional(),
});

// A command changes its settings, never whether it sees someone.
const occupancyCommand = z
  .strictObject({
    sensitivity: sensitivity.optional(),
    clearAfter: clearAfter.optional(),
    indicator: z.boolean().optional(),
  })
  .refine(
    (command) =>
      command.sensitivity !== undefined ||
      command.clearAfter !== undefined ||
      command.indicator !== undefined,
    "a command asks for something",
  );

export type LightFeatures = z.output<typeof lightFeatures>;
export type LightState = z.output<typeof lightState>;
export type LightCommand = z.output<typeof lightCommand>;
export type SwitchFeatures = z.output<typeof switchFeatures>;
export type SwitchState = z.output<typeof switchState>;
export type SwitchCommand = z.output<typeof switchCommand>;
export type ButtonFeatures = z.output<typeof buttonFeatures>;
export type SensorFeatures = z.output<typeof sensorFeatures>;
export type SensorState = z.output<typeof sensorState>;
export type OccupancyFeatures = z.output<typeof occupancyFeatures>;
export type OccupancyState = z.output<typeof occupancyState>;
export type OccupancyCommand = z.output<typeof occupancyCommand>;

export interface CapabilityDefinition<
  Kind extends string = string,
  Features extends object = object,
  State extends object = object,
  Command extends object = object,
> {
  readonly kind: Kind;
  readonly version: number;
  /** What this device's capability can do, as its driver declares it. */
  readonly features: z.ZodType<Features, unknown>;
  /** The state a driver reports. */
  readonly state: z.ZodType<State, unknown>;
  readonly command: z.ZodType<Command, unknown>;
  /** The state fields a command asks for, which the device's reports confirm. */
  desired(command: Command): Partial<State>;
  /** Whether a device with these features can carry the command out. */
  supports(features: Features, command: Command): boolean;
  /** The tier of its commands, which the permission gate applies to the actor. */
  readonly tier: Tier;
}

export const light = {
  kind: "light",
  version: 1,
  features: lightFeatures,
  state: lightState,
  command: lightCommand,
  desired(command) {
    const desired: Partial<LightState> = {};
    if (command.on !== undefined) desired.on = command.on;
    if (command.brightness !== undefined)
      desired.brightness = command.brightness;
    if (command.colorTemperature !== undefined) {
      desired.colorMode = "temperature";
      desired.colorTemperature = command.colorTemperature;
    }
    if (command.hue !== undefined && command.saturation !== undefined) {
      desired.colorMode = "color";
      desired.hue = command.hue;
      desired.saturation = command.saturation;
    }
    return desired;
  },
  supports(features, command) {
    if (command.brightness !== undefined && command.brightness > 0) {
      if (!features.brightness) return false;
    }
    if (command.colorTemperature !== undefined) {
      const range = features.colorTemperature;
      if (
        !range ||
        command.colorTemperature < range.min ||
        command.colorTemperature > range.max
      ) {
        return false;
      }
    }
    return command.hue === undefined || features.color;
  },
  tier: "write",
} as const satisfies CapabilityDefinition<
  "light",
  LightFeatures,
  LightState,
  LightCommand
>;

export const switchCapability = {
  kind: "switch",
  version: 1,
  features: switchFeatures,
  state: switchState,
  command: switchCommand,
  desired: (command) => ({ on: command.on }),
  supports: () => true,
  tier: "write",
} as const satisfies CapabilityDefinition<
  "switch",
  SwitchFeatures,
  SwitchState,
  SwitchCommand
>;

/**
 * A remote, a wireless button or a wall switch that sends presses: its
 * features are the press actions it declares, and it has no state and takes
 * no commands.
 */
export const button = {
  kind: "button",
  version: 1,
  features: buttonFeatures,
  state: buttonState,
  command: buttonCommand,
  // It takes no commands, so nothing is ever asked of it.
  desired: (command: never) => command,
  supports: () => false,
  tier: "read",
} as const satisfies CapabilityDefinition<
  "button",
  ButtonFeatures,
  never,
  never
>;

/**
 * One reading of a sensor, such as a room's temperature or humidity: its
 * features say what it measures, its state is its latest value in that
 * measure's standard unit, and it takes no commands.
 */
export const sensor = {
  kind: "sensor",
  version: 1,
  features: sensorFeatures,
  state: sensorState,
  command: sensorCommand,
  // It takes no commands, so nothing is ever asked of it.
  desired: (command: never) => command,
  supports: () => false,
  tier: "read",
} as const satisfies CapabilityDefinition<
  "sensor",
  SensorFeatures,
  SensorState,
  never
>;

/**
 * Whether someone is in a sensor's sight, as a motion sensor sees it: its
 * features say what it senses and which settings it has, its state whether
 * it sees someone now, and its commands change those settings, which its
 * report confirms.
 */
export const occupancy = {
  kind: "occupancy",
  version: 1,
  features: occupancyFeatures,
  state: occupancyState,
  command: occupancyCommand,
  desired(command) {
    const desired: Partial<OccupancyState> = {};
    if (command.sensitivity !== undefined)
      desired.sensitivity = command.sensitivity;
    if (command.clearAfter !== undefined)
      desired.clearAfter = command.clearAfter;
    if (command.indicator !== undefined) desired.indicator = command.indicator;
    return desired;
  },
  supports(features, command) {
    if (
      command.sensitivity !== undefined &&
      !features.sensitivity?.includes(command.sensitivity)
    ) {
      return false;
    }
    if (command.clearAfter !== undefined) {
      const range = features.clearAfter;
      if (
        !range ||
        command.clearAfter < range.min ||
        command.clearAfter > range.max
      ) {
        return false;
      }
    }
    return command.indicator === undefined || features.indicator;
  },
  tier: "write",
} as const satisfies CapabilityDefinition<
  "occupancy",
  OccupancyFeatures,
  OccupancyState,
  OccupancyCommand
>;

/** Every capability kind the core knows. Climate, cover and the rest join here. */
export const capabilities = {
  light,
  switch: switchCapability,
  button,
  sensor,
  occupancy,
} as const;

export type CapabilityKind = keyof typeof capabilities;
export const capabilityKinds = Object.keys(capabilities) as CapabilityKind[];

type Kinds = {
  light: { features: LightFeatures; state: LightState; command: LightCommand };
  switch: {
    features: SwitchFeatures;
    state: SwitchState;
    command: SwitchCommand;
  };
  button: { features: ButtonFeatures; state: never; command: never };
  sensor: { features: SensorFeatures; state: SensorState; command: never };
  occupancy: {
    features: OccupancyFeatures;
    state: OccupancyState;
    command: OccupancyCommand;
  };
};
export type FeaturesOf<K extends CapabilityKind> = Kinds[K]["features"];
export type StateOf<K extends CapabilityKind> = Kinds[K]["state"];
export type CommandOf<K extends CapabilityKind> = Kinds[K]["command"];

export function isCapabilityKind(kind: string): kind is CapabilityKind {
  return Object.hasOwn(capabilities, kind);
}

/** A kind's definition, typed loosely for code that handles every kind alike. */
export function capabilityOf(kind: CapabilityKind): CapabilityDefinition {
  return capabilities[kind] as unknown as CapabilityDefinition;
}

// Permissions: devices.read:<kind> to see a kind's devices and state,
// devices.control:<kind> to command them (which includes seeing them), and
// devices.register for a driver app's own devices.
export const registerPermission = "devices.register";
export const readPermission = (kind: CapabilityKind) => `devices.read:${kind}`;
export const controlPermission = (kind: CapabilityKind) =>
  `devices.control:${kind}`;

/**
 * Where a capability's state stands: `synced` shows what the device last
 * reported; `pending` waits for the device to confirm a command; `held`
 * keeps a colour or brightness for a light that is off until it turns on;
 * `conflict` means the device did not confirm the last command in time.
 */
export const syncStatuses = ["synced", "pending", "held", "conflict"] as const;
export type SyncStatus = (typeof syncStatuses)[number];

export const availabilities = ["online", "offline", "unknown"] as const;
export type Availability = (typeof availabilities)[number];

/**
 * Who last set a capability through the core, so an app can tell its own
 * commands from a mood's or a person's, as natural light pauses for them. A
 * report from the device changes nothing here: it names the last command the
 * core carried out.
 */
export type SetBy<State = Record<string, unknown>> = {
  /**
   * The app whose code sent the command, such as sanctum.moods; null for a
   * client's own command, the shell's or an app page's, and for a
   * workflow's own device step.
   */
  app: string | null;
  /** Who was behind it. */
  actor: Actor;
  /** The state fields the command asked for, such as { on: true }. */
  asked: Partial<State>;
  at: string;
};

type CapabilityInfoOf<K extends CapabilityKind> = {
  /** Unique within its device, such as "light" or, for a double switch, "l1". */
  id: string;
  kind: K;
  features: FeaturesOf<K>;
  /** What to show: the reported state with what is pending or held, or none while nothing is known. */
  state: StateOf<K> | null;
  /**
   * What the device last reported. A light that can dim keeps the brightness
   * it comes back at while off, whatever it reports, is never on at 0, and
   * keeps its brightness when a report leaves it out.
   */
  observed: StateOf<K> | null;
  /** The fields a command asked for, until the device confirms them. */
  desired: Partial<StateOf<K>> | null;
  sync: SyncStatus;
  /** The last command the core carried out for it, if any. */
  setBy: SetBy<StateOf<K>> | null;
  /**
   * When what it reports last changed (its kind's history fields, such as
   * a light's on and brightness or a motion sensor's occupied), or null
   * before its first report: "No motion for 12 min".
   */
  changedAt: string | null;
};

export type CapabilityInfo = {
  [K in CapabilityKind]: CapabilityInfoOf<K>;
}[CapabilityKind];

/** A device as apps and clients see it, with the capabilities they may see. */
export type DeviceInfo = {
  id: string;
  name: string;
  /** The app that brings it, such as sanctum.zigbee. */
  driver: string;
  manufacturer: string | null;
  model: string | null;
  roomId: string | null;
  /** What its driver calls it, such as its model's name. */
  driverName: string;
  /** What it is, by all its capabilities, whichever of them a view shows. */
  type: DeviceType;
  availability: Availability;
  lastSeenAt: string | null;
  capabilities: CapabilityInfo[];
  /** Its firmware, where its driver can tell (firmware.ts). */
  firmware: FirmwareInfo | null;
  /** Whether Check connection can ask it how it is now (driver.probe). */
  probe: boolean;
  /**
   * Its battery's charge in percent, as its driver last reported it; null
   * for a device on mains power and one that has not said.
   */
  battery: number | null;
  /**
   * When its driver said its network no longer has it, as after a reset
   * (ctx.devices.present); null while its network has it.
   */
  leftAt: string | null;
};

const capabilityId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "use a short id such as light or l1");
// The driver's own id for a device, such as a Zigbee IEEE address.
export const deviceKey = z.string().min(1).max(128);
const label = z.string().trim().min(1).max(120);
// A device type's id, whether or not this version has the type yet.
const deviceTypeId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "use a device type's id such as plug");

const capabilityRegistration = z.discriminatedUnion("kind", [
  z.strictObject({
    id: capabilityId,
    kind: z.literal("light"),
    features: lightFeatures.default(lightFeatures.parse({})),
  }),
  z.strictObject({
    id: capabilityId,
    kind: z.literal("switch"),
    features: switchFeatures.default({}),
  }),
  z.strictObject({
    id: capabilityId,
    kind: z.literal("button"),
    features: buttonFeatures,
  }),
  z.strictObject({
    id: capabilityId,
    kind: z.literal("sensor"),
    features: sensorFeatures,
  }),
  z.strictObject({
    id: capabilityId,
    kind: z.literal("occupancy"),
    features: occupancyFeatures,
  }),
]);

/** What a driver tells the core about one of its devices (ctx.devices.register). */
export const deviceRegistration = z.strictObject({
  key: deviceKey,
  name: label,
  manufacturer: label.nullable().default(null),
  model: label.nullable().default(null),
  // What the device is, where its driver can tell: a device type's id
  // (device-types.ts), such as plug, which no capability tells from a
  // switch. The core takes it when the device has the kinds that type
  // needs, and works out the type itself when a driver says none or one
  // it does not know.
  type: deviceTypeId.nullable().default(null),
  capabilities: z
    .array(capabilityRegistration)
    .min(1)
    .max(32)
    .refine(
      (list) => new Set(list.map((each) => each.id)).size === list.length,
      "capability ids must be unique",
    ),
  // What it runs, as its maker numbers it, whether the driver can update
  // it (driver.firmware), and whether it sleeps, so an update waits for it
  // to wake; none when the driver cannot tell.
  firmware: z
    .strictObject({
      version: label.nullable().default(null),
      updatable: z.boolean(),
      sleeps: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  // Whether the driver can ask it how it is now (driver.probe): a device
  // that sleeps, or has nothing to read, cannot be asked.
  probe: z.boolean().default(false),
});
export type DeviceRegistration = Omit<
  z.input<typeof deviceRegistration>,
  "type"
> & { type?: DeviceType | null };

/**
 * What a driver reports about one of its devices (ctx.devices.report):
 * whether it answers, each capability's whole state as the device reported
 * it, and its battery's charge, which is the device's rather than a
 * capability's.
 */
export const deviceReport = z
  .strictObject({
    key: deviceKey,
    availability: z.enum(availabilities).optional(),
    states: z.record(capabilityId, z.unknown()).optional(),
    battery: percent.optional(),
  })
  .refine(
    (report) =>
      report.availability !== undefined ||
      report.states ||
      report.battery !== undefined,
    "a report says something",
  );
export type DeviceReport = z.input<typeof deviceReport>;

/**
 * Every device a driver still has, by its keys (ctx.devices.present), as
 * after its network's whole list: the core marks the driver's other
 * devices offline and as having left its network (DeviceInfo.leftAt), until
 * a list has them again.
 */
export const devicePresence = z.strictObject({
  // Far more than any home has.
  keys: z.array(deviceKey).max(10_000),
});
export type DevicePresence = z.input<typeof devicePresence>;

/**
 * A press of one of a driver app's own devices (ctx.devices.press): one of
 * the actions its button declares, once, as it happens.
 */
export const devicePress = z.strictObject({
  key: deviceKey,
  capability: capabilityId,
  action: buttonAction,
});
export type DevicePress = z.input<typeof devicePress>;

/**
 * The end of a hold of one of a driver app's own devices
 * (ctx.devices.release): its button was let go, which ends whatever its
 * hold set going, such as dimming lights.
 */
export const deviceRelease = z.strictObject({
  key: deviceKey,
  capability: capabilityId,
});
export type DeviceRelease = z.input<typeof deviceRelease>;

/** The lifetime of a remote's capture, shared by the core and its picker. */
export const pressCaptureDurationMs = 5 * 60_000;

/**
 * A capture of a remote's presses, while someone picks one: until it ends,
 * its presses reach live clients only, never workflows or apps.
 */
export type PressCapture = { id: string; device: string; until: string };

/** A command for one capability of a device (ctx.devices.command). */
export type DeviceCommand = {
  device: string;
  capability: string;
  command: unknown;
};

/** What the core hands a driver app for one of its devices: the command as the core prepared it. */
export type DriverCommand = {
  /** The device, by the driver's own key. */
  key: string;
  /** The device's id in the core. */
  device: string;
  capability: string;
} & {
  [K in CapabilityKind]: { kind: K; command: CommandOf<K> };
}[CapabilityKind];

/** What the core hands a driver app to move one of its lights (driver.move). */
export type DriverMove = {
  /** The device, by the driver's own key. */
  key: string;
  /** The device's id in the core. */
  device: string;
  capability: string;
  move: LightMove;
};
