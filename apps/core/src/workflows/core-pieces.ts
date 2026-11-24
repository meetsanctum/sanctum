import {
  buttonAction,
  capabilityKinds,
  choice,
  daysOfWeek,
  luxField,
  minutesField,
  names,
  partOf,
  percentField,
  stateOperators,
  sunOffset,
  timeOfDay,
  type PieceKind,
  type PieceWords,
  type SunEvent,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { lightsAre, lightsChange, lightsPlace } from "../devices/lights.js";
import { motionPlace } from "../devices/motion.js";

// The core's own workflow pieces, for time, the sun, devices, remotes'
// presses, the lights of a place, motion and the light level in a place
// (devices/motion.ts) and entities, beside those apps provide (pieces.ts).
// Media players' pieces read a player loading as playing (media.ts).
// Each carries the words Automations reads it with, as apps' pieces do
// (PieceWords), and a trigger the group its workflows are listed under. The
// client knows no piece by its id, so the words, the presets and the markers
// on each field are all it has.

const field = z.string().min(1).max(100);
const operator = z.enum(stateOperators);
const entityId = z.string().min(1).max(128);

// Which entities an entity piece means: one, by its app and key, or every
// one of a type. An app goes with a key, so a piece names the app behind a
// type only when the household picks one entity.
const entities = {
  type: entityId.optional(),
  app: entityId.optional(),
  key: entityId.optional(),
};
const oneEntity = (config: { app?: string; key?: string }) =>
  (config.app === undefined) === (config.key === undefined);
const pairing = { message: "an app and a key go together" };

/** One of the core's own pieces. */
export type CorePiece = {
  title: string;
  config: z.ZodType;
  words?: PieceWords;
  // A trigger's group (PieceInfo.group); none where the list groups its
  // workflows itself, as a device's by its category.
  group?: string;
};

export const corePieces = {
  trigger: {
    manual: {
      title: "Run by hand",
      config: z.strictObject({}),
      group: "By hand",
      words: { sentence: "By hand", card: { name: "By hand" }, icon: "hand" },
    },
    time: {
      title: "At a time of day",
      config: z.strictObject({ time: timeOfDay, days: daysOfWeek }),
      group: "Time",
      words: {
        sentence: "At {time} {days}",
        card: { name: "{time}", specifics: "{days}" },
        icon: "clock",
      },
    },
    sun: {
      title: "At sunrise or sunset",
      config: z.strictObject({
        event: choice({
          sunrise: "sunrise",
          sunset: "sunset",
        }) satisfies z.ZodType<SunEvent>,
        offsetMinutes: sunOffset,
      }),
      group: "Sunrise and sunset",
      words: {
        sentence: "At {event}, {offsetMinutes}",
        card: { name: "{event}", specifics: "{offsetMinutes}" },
        icon: "sunset",
        presets: [
          {
            title: "At sunrise",
            sentence: "At sunrise, {offsetMinutes}",
            icon: "sunrise",
            config: { event: "sunrise" },
          },
          {
            title: "At sunset",
            sentence: "At sunset, {offsetMinutes}",
            icon: "sunset",
            config: { event: "sunset" },
          },
        ],
      },
    },
    device: {
      title: "A device changes",
      config: z.strictObject({
        device: names("device").optional(),
        capability: partOf("device").optional(),
        kind: z.enum(capabilityKinds).optional(),
        field: field.optional(),
        operator: operator.optional(),
        value: z.unknown().optional(),
        // Fires only on a change from a value the core knew, not on a
        // device's first state: a door found open has not just opened.
        fromKnown: z.boolean().optional().meta({ title: "Only on a change" }),
        // Fires once the change has held this long, and not at all if it
        // is undone before: a player stopped for a moment between two
        // episodes has not stopped playing.
        forSeconds: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .optional()
          .meta({ title: "Held for seconds" }),
      }),
      words: {
        sentence: "{device} changes",
        card: { name: "{device}", specifics: "Changes" },
        presets: [
          {
            title: "Turns on",
            sentence: "{device} turns on",
            card: { name: "{device}", specifics: "Turns on" },
            config: { field: "on", operator: "is_on" },
          },
          {
            title: "Turns off",
            sentence: "{device} turns off",
            card: { name: "{device}", specifics: "Turns off" },
            config: { field: "on", operator: "is_off" },
          },
          {
            title: "Brightness changes",
            sentence: "{device}'s brightness changes",
            card: { name: "{device}", specifics: "Brightness changes" },
            config: { kind: "light", field: "brightness" },
          },
          {
            title: "Detects motion",
            sentence: "{device} detects motion",
            card: { name: "{device}", specifics: "Detects motion" },
            config: { kind: "motion", field: "motion", operator: "is_on" },
          },
          {
            title: "Motion stops",
            sentence: "{device}'s motion stops",
            card: { name: "{device}", specifics: "Motion stops" },
            config: {
              kind: "motion",
              field: "motion",
              operator: "is_off",
            },
          },
          {
            title: "Opens",
            sentence: "{device} opens",
            card: { name: "{device}", specifics: "Opens" },
            config: {
              kind: "contact",
              field: "open",
              operator: "is_on",
              fromKnown: true,
            },
          },
          {
            title: "Closes",
            sentence: "{device} closes",
            card: { name: "{device}", specifics: "Closes" },
            config: {
              kind: "contact",
              field: "open",
              operator: "is_off",
              fromKnown: true,
            },
          },
          {
            title: "Starts playing",
            sentence: "{device} starts playing",
            card: { name: "{device}", specifics: "Starts playing" },
            config: {
              kind: "media",
              field: "activity",
              operator: "equals",
              value: "playing",
              fromKnown: true,
            },
          },
          {
            title: "Pauses",
            sentence: "{device} pauses",
            card: { name: "{device}", specifics: "Pauses" },
            config: {
              kind: "media",
              field: "activity",
              operator: "equals",
              value: "paused",
              fromKnown: true,
            },
          },
          {
            title: "Stops playing",
            sentence: "{device} stops playing",
            card: { name: "{device}", specifics: "Stops playing" },
            config: {
              kind: "media",
              field: "activity",
              operator: "equals",
              value: "idle",
              fromKnown: true,
              forSeconds: 5,
            },
          },
        ],
      },
    },
    motion: {
      title: "Motion in a place",
      config: z.strictObject({ place: motionPlace }),
      group: "Motion",
      words: {
        sentence: "Motion in {place}",
        card: { name: "{place}", specifics: "Motion" },
        icon: "footprints",
      },
    },
    noMotion: {
      title: "No motion in a place for a while",
      config: z.strictObject({ place: motionPlace, forMinutes: minutesField }),
      group: "Motion",
      words: {
        sentence: "No motion in {place} for {forMinutes}",
        card: { name: "{place}", specifics: "No motion for {forMinutes}" },
        icon: "footprints",
        // Add starts it at 10 minutes, as Moods does.
        presets: [
          { title: "No motion for a while", config: { forMinutes: 10 } },
        ],
      },
    },
    press: {
      title: "A remote is pressed",
      config: z.strictObject({
        device: names("device"),
        capability: partOf("device").optional(),
        // Any of its actions when left out.
        action: buttonAction.optional(),
      }),
      group: "Buttons",
      words: {
        sentence: "{action} on {device}",
        card: { name: "{device}", specifics: "{action}" },
        icon: "circle-dot",
      },
    },
    entity: {
      title: "An entity changes",
      config: z
        .strictObject({
          ...entities,
          field: field.optional(),
          operator: operator.optional(),
          value: z.unknown().optional(),
        })
        .refine(oneEntity, pairing),
    },
  },
  condition: {
    device: {
      title: "A device is",
      config: z.strictObject({
        device: names("device"),
        capability: partOf("device").optional(),
        field,
        operator,
        value: z.unknown().optional(),
      }),
      words: {
        presets: [
          {
            title: "Is on",
            sentence: "{device} is on",
            config: { field: "on", operator: "is_on" },
          },
          {
            title: "Is off",
            sentence: "{device} is off",
            config: { field: "on", operator: "is_off" },
          },
          {
            title: "Sees motion",
            sentence: "{device} sees motion",
            config: { field: "motion", operator: "is_on" },
          },
          {
            title: "Is open",
            sentence: "{device} is open",
            config: { field: "open", operator: "is_on" },
          },
          {
            title: "Is closed",
            sentence: "{device} is closed",
            config: { field: "open", operator: "is_off" },
          },
          {
            title: "Is playing",
            sentence: "{device} is playing",
            config: { field: "activity", operator: "equals", value: "playing" },
          },
          {
            title: "Isn't playing",
            sentence: "{device} isn't playing",
            config: {
              field: "activity",
              operator: "not_equals",
              value: "playing",
            },
          },
        ],
      },
    },
    motion: {
      title: "There's motion in a place",
      config: z.strictObject({ place: motionPlace }),
      words: { sentence: "There's motion in {place}", icon: "footprints" },
    },
    noMotion: {
      title: "No motion in a place for a while",
      config: z.strictObject({ place: motionPlace, forMinutes: minutesField }),
      words: {
        sentence: "No motion in {place} for {forMinutes}",
        icon: "footprints",
        presets: [
          { title: "No motion for a while", config: { forMinutes: 10 } },
        ],
      },
    },
    lightLevel: {
      title: "A place's light level",
      config: z.strictObject({
        place: motionPlace,
        is: choice({ darker: "darker than", brighter: "brighter than" }),
        lux: luxField,
      }),
      words: {
        sentence: "{place} is {is} {lux}",
        icon: "sun",
        presets: [
          // Add starts each at a level a room is lit at, or dark under.
          {
            title: "Darker than",
            sentence: "{place} is darker than {lux}",
            config: { is: "darker", lux: 30 },
          },
          {
            title: "Brighter than",
            sentence: "{place} is brighter than {lux}",
            config: { is: "brighter", lux: 100 },
          },
        ],
      },
    },
    entity: {
      title: "An entity is",
      config: z
        .strictObject({
          ...entities,
          field,
          operator,
          value: z.unknown().optional(),
        })
        .refine(oneEntity, pairing)
        .refine(
          (config) => config.type !== undefined || config.key !== undefined,
          {
            message: "name an entity or a type",
          },
        ),
    },
    time: {
      title: "The time is between",
      config: z
        .strictObject({ after: timeOfDay, before: timeOfDay, days: daysOfWeek })
        .refine((span) => span.after !== span.before, {
          message: "the times must differ",
        }),
      words: {
        sentence: "Between {after} and {before} {days}",
        icon: "clock",
      },
    },
    lights: {
      title: "Lights are on or off",
      config: z.strictObject({ place: lightsPlace, are: lightsAre }),
      words: {
        sentence: "In {place}, {are}",
        icon: "lightbulb",
        presets: [
          {
            title: "Any light is on",
            sentence: "In {place}, any light is on",
            config: { are: "anyOn" },
          },
          {
            title: "Every light is off",
            sentence: "In {place}, every light is off",
            config: { are: "allOff" },
          },
        ],
      },
    },
  },
  step: {
    device: {
      title: "Command a device",
      config: z.strictObject({
        device: names("device"),
        capability: partOf("device"),
        command: z.record(z.string(), z.unknown()),
      }),
      words: {
        presets: [
          {
            title: "Turn on",
            sentence: "Turn on {device}",
            config: { command: { on: true } },
          },
          {
            title: "Turn off",
            sentence: "Turn off {device}",
            config: { command: { on: false } },
          },
          // Resume carries on with what a player had; it starts nothing new.
          {
            title: "Resume",
            sentence: "Resume {device}",
            config: { command: { activity: "playing" } },
          },
          {
            title: "Pause",
            sentence: "Pause {device}",
            config: { command: { activity: "paused" } },
          },
          {
            title: "Stop",
            sentence: "Stop {device}",
            config: { command: { playback: "stop" } },
          },
          {
            title: "Mute",
            sentence: "Mute {device}",
            config: { command: { muted: true } },
          },
          {
            title: "Unmute",
            sentence: "Unmute {device}",
            config: { command: { muted: false } },
          },
        ],
      },
    },
    volume: {
      title: "Set a player's volume",
      config: z.strictObject({
        device: names("device", { sends: { volume: 0 } }),
        capability: partOf("device"),
        volume: percentField.meta({ percent: true, title: "Volume" }),
      }),
      words: {
        sentence: "Set {device}'s volume to {volume}",
        // Add starts it at a level a room can talk over.
        presets: [{ title: "Set the volume", config: { volume: 30 } }],
      },
    },
    lights: {
      title: "Switch lights",
      config: z.strictObject({ place: lightsPlace, to: lightsChange }),
      words: {
        sentence: "{to} the lights in {place}",
        icon: "lightbulb",
        presets: [
          {
            title: "Turn on the lights",
            sentence: "Turn on the lights in {place}",
            config: { to: "on" },
          },
          {
            title: "Turn off the lights",
            sentence: "Turn off the lights in {place}",
            config: { to: "off" },
          },
          {
            title: "Turn the lights on or off",
            sentence: "Turn the lights in {place} on or off",
            config: { to: "toggle" },
          },
        ],
      },
    },
  },
} as const satisfies Record<PieceKind, Record<string, CorePiece>>;

/**
 * What a core step about one device sends it, the device step's command or
 * the volume step's level, or undefined for another piece.
 */
export function deviceCommandOf(
  piece: string,
  config: unknown,
): DeviceStepConfig | undefined {
  if (piece === "device") {
    return config as DeviceStepConfig;
  }
  if (piece === "volume") {
    const { device, capability, volume } = config as VolumeStepConfig;
    return { device, capability, command: { volume } };
  }
  return undefined;
}

export type DeviceTriggerConfig = z.output<
  typeof corePieces.trigger.device.config
>;
export type PressTriggerConfig = z.output<
  typeof corePieces.trigger.press.config
>;
export type DeviceConditionConfig = z.output<
  typeof corePieces.condition.device.config
>;
export type EntityTriggerConfig = z.output<
  typeof corePieces.trigger.entity.config
>;
export type EntityConditionConfig = z.output<
  typeof corePieces.condition.entity.config
>;
export type TimeTriggerConfig = z.output<typeof corePieces.trigger.time.config>;
export type SunTriggerConfig = z.output<typeof corePieces.trigger.sun.config>;
export type TimeConditionConfig = z.output<
  typeof corePieces.condition.time.config
>;
export type DeviceStepConfig = z.output<typeof corePieces.step.device.config>;
export type VolumeStepConfig = z.output<typeof corePieces.step.volume.config>;
export type LightsConditionConfig = z.output<
  typeof corePieces.condition.lights.config
>;
export type LightsStepConfig = z.output<typeof corePieces.step.lights.config>;
export type MotionTriggerConfig = z.output<
  typeof corePieces.trigger.motion.config
>;
export type NoMotionTriggerConfig = z.output<
  typeof corePieces.trigger.noMotion.config
>;
export type MotionConditionConfig = z.output<
  typeof corePieces.condition.motion.config
>;
export type NoMotionConditionConfig = z.output<
  typeof corePieces.condition.noMotion.config
>;
export type LightLevelConditionConfig = z.output<
  typeof corePieces.condition.lightLevel.config
>;
