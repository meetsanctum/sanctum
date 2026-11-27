import type {
  CapabilityInfo,
  DeviceInfo,
  LightCommand,
} from "@meetsanctum/app-sdk";

// What the lights of a place are asked one by one (lights.ts): whether a
// light is on and dims, a step brighter or dimmer, and what of a set
// brightness, white or colour each light can take.

export type Light = {
  device: DeviceInfo;
  capability: Extract<CapabilityInfo, { kind: "light" }>;
};

/** How far Brighter and Dimmer step a light, of its whole range. */
export const lightsStepPercent = 20;
// The short fade of a step, as Hue's dimmer steps.
const stepSeconds = 0.4;

export const isOn = (light: Light) => light.capability.state?.on === true;

export const canDim = (light: Light) =>
  light.capability.kind === "light" && light.capability.features.brightness;

// What a step asks of a light: brighter from off as from nothing, dimmer
// down to the lowest but never off, and nothing where it is at that end.
export function stepOf(
  { capability }: Light,
  to: "brighter" | "dimmer",
): LightCommand | null {
  if (capability.kind !== "light") return null;
  const isLit = capability.state?.on === true;
  if (to === "dimmer" && !isLit) return null;
  const level = isLit ? (capability.state?.brightness ?? 100) : 0;
  const brightness =
    to === "brighter"
      ? Math.min(100, level + lightsStepPercent)
      : Math.max(1, level - lightsStepPercent);
  return brightness === level
    ? null
    : { brightness, transitionSeconds: stepSeconds };
}

export const keyOf = (device: string, capability: string) =>
  `${device}/${capability}`;

// What of a set a light can take: a brightness where it dims, a colour
// temperature within its range, a colour where it has colour; or nothing.
export function fieldsOf(
  { capability }: Light,
  set: LightCommand,
): LightCommand {
  const { features } = capability;
  const fields: LightCommand = {};
  if (features.brightness && set.brightness !== undefined) {
    fields.brightness = set.brightness;
  }
  const range = features.colorTemperature;
  if (range && set.colorTemperature !== undefined) {
    fields.colorTemperature = Math.min(
      range.max,
      Math.max(range.min, set.colorTemperature),
    );
  }
  if (features.color && set.hue !== undefined && set.saturation !== undefined) {
    fields.hue = set.hue;
    fields.saturation = set.saturation;
  }
  return fields;
}

// What of a set a light takes, as fieldsOf says, except that a white
// gives a light with colour but no whites no saturation, so it is white
// too.
export function lookOf(light: Light, set: LightCommand): LightCommand {
  const { features } = light.capability;
  return set.colorTemperature !== undefined &&
    !features.colorTemperature &&
    features.color
    ? {
        ...(features.brightness && set.brightness !== undefined
          ? { brightness: set.brightness }
          : {}),
        hue: 0,
        saturation: 0,
      }
    : fieldsOf(light, set);
}

export function withSettings(
  rule: LightCommand,
  fields: LightCommand,
): LightCommand {
  const command: LightCommand = { ...rule, ...fields };
  if (fields.colorTemperature !== undefined) {
    delete command.hue;
    delete command.saturation;
  }
  if (fields.hue !== undefined) delete command.colorTemperature;
  return command;
}
