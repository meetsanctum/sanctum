import {
  capabilityOf,
  light,
  type CapabilityKind,
  type LightCommand,
  type SyncStatus,
} from "@meetsanctum/app-sdk";

// Desired and observed state, and how they are reconciled: ported from v1's
// device-state-model.ts and device-state-service.ts (Pragmata, v1-final).
// A command records the fields it asks for as `desired` and waits for the
// device to confirm them in a report; what clients show is the reported
// state with what is desired applied. v1 kept a full target state and a
// list of target fields; here the desired fields carry both. v1's conflict
// that kept a light's colour while it was off is called `held`.
//
// v1 took every report as the device's latest state. Commands go out in
// order, but a device can still report the state it was in before an
// earlier one: Zigbee2MQTT publishes a light's previous state before the
// new one for every command. A pending command therefore awaits the on or
// off of the earlier commands still on their way, and until the device has
// shown them, its reports confirm nothing (reconcile()).

type State = Record<string, unknown>;

export type CapabilitySync = {
  kind: CapabilityKind;
  features: State;
  observed: State | null;
  desired: State | null;
  sync: SyncStatus;
  // While pending: the on and off of earlier commands, in order, that the
  // device has yet to show before this command's.
  awaiting?: boolean[] | null;
};

export type Settled = Pick<CapabilitySync, "desired" | "sync" | "awaiting">;

/** A command, ready to go: what it asks for, and what the driver gets, if anything yet. */
export type Prepared = Settled & { send: State | null };

// How long a device has to confirm a command (v1: 6 s).
export const confirmMs = 6_000;

// A light's appearance: what it keeps while off, and what a light that is
// off does not take (v1's shouldPreserveUnconfirmedLightAppearanceTarget).
const appearance = new Set([
  "brightness",
  "colorMode",
  "colorTemperature",
  "hue",
  "saturation",
]);

const isAppearance = (desired: State) =>
  Object.keys(desired).every((field) => appearance.has(field));

// Only a light that can dim has a brightness to remember.
const dims = (capability: CapabilitySync) =>
  capability.kind === "light" && capability.features.brightness === true;

// The brightness a light comes back at (v1's rememberedLightBrightness): the
// one last asked of it, or the one it last had while on, 1% included. Reports
// keep only what it showed, so a command that fails leaves nothing behind.
// v1 did not trust an off light's 1%, so a light set to 1% came back at 100.
// Every brightness change goes through the core, so 1% was asked for or a
// remote's dim stopped there, and a dim never ends in off.
function rememberedBrightness(
  capability: CapabilitySync,
  from = [capability.desired, capability.observed],
) {
  if (!dims(capability)) {
    return undefined;
  }
  for (const state of from) {
    const brightness = state?.brightness;
    if (typeof brightness === "number" && brightness > 0) {
      return brightness;
    }
  }
  return undefined;
}

/**
 * A report as the core keeps it (v1's normalizeEntityObservation). A light
 * that is off keeps showing the brightness it comes back at, whatever it
 * reports: many lights report their lowest level once off, and a plain "on"
 * would bring them back almost dark. A light that is on is never at 0, keeps
 * its brightness when a report leaves it out, and keeps it while fading out.
 */
export function observe(capability: CapabilitySync, reported: State): State {
  if (!dims(capability)) {
    return reported;
  }
  const { on, brightness } = reported;
  const shown = rememberedBrightness(capability, [capability.observed]);
  if (on === false) {
    const fallback =
      typeof brightness === "number" && brightness > 1 ? brightness : 100;
    return { ...reported, brightness: shown ?? fallback };
  }
  // An "off" on its way may fade the light down first: the levels it
  // passes through are not what it comes back at.
  // An earlier off can fade too; only an awaited on needs its new level.
  if (
    capability.sync === "pending" &&
    capability.desired?.on === false &&
    capability.awaiting?.[0] !== true &&
    shown !== undefined
  ) {
    return { ...reported, brightness: shown };
  }
  if (brightness === 0) {
    return { ...reported, brightness: shown ?? 100 };
  }
  if (brightness === undefined) {
    // Such a report confirms a brightness still asked for (confirms()).
    const kept = rememberedBrightness(capability, [
      capability.sync === "pending" ? capability.desired : null,
      capability.observed,
    ]);
    return kept === undefined ? reported : { ...reported, brightness: kept };
  }
  return reported;
}

/** What to show: the reported state with what is pending or held applied, while that makes a whole state. */
export function shownState(capability: CapabilitySync): State | null {
  if (!capability.desired) {
    return capability.observed;
  }
  const merged = { ...capability.observed, ...capability.desired };
  return capabilityOf(capability.kind).state.safeParse(merged).success
    ? merged
    : capability.observed;
}

/**
 * Whether a report confirms what was asked. A field the device does not
 * report cannot be confirmed, so it does not hold the rest back (v1's
 * targetFieldsMatch), unless `reported` asks for every field to be there.
 */
export function confirms(
  observed: State,
  desired: State,
  options: { reported?: boolean } = {},
) {
  return Object.entries(desired).every(([field, value]) =>
    field in observed ? observed[field] === value : !options.reported,
  );
}

/** Prepares a command, already checked against its kind's schema, for a capability. */
export function prepare(capability: CapabilitySync, command: State): Prepared {
  const prepared: Prepared =
    capability.kind === "light"
      ? prepareLight(capability, command as LightCommand)
      : {
          desired: capabilityOf(capability.kind).desired(command) as State,
          sync: "pending",
          send: command,
        };
  return prepared.sync === "pending"
    ? { ...prepared, awaiting: awaitingBefore(capability, prepared.desired) }
    : prepared;
}

// The on and off a command awaits: those its pending predecessor awaited,
// then that one's own. Only a change can be told from the state before it,
// so an on or off that leaves the device as it was is not awaited, and
// neither is a last one this command asks too.
function awaitingBefore(capability: CapabilitySync, desired: State | null) {
  if (capability.sync !== "pending") {
    return undefined;
  }
  const awaiting = [...(capability.awaiting ?? [])];
  const on = capability.desired?.on;
  if (
    typeof on === "boolean" &&
    on !== (awaiting.at(-1) ?? capability.observed?.on)
  ) {
    awaiting.push(on);
  }
  if (awaiting.at(-1) === desired?.on) {
    awaiting.pop();
  }
  return awaiting.length > 0 ? awaiting : undefined;
}

// A colour replaces a colour temperature and the other way round.
function withAppearance(held: State, asked: State): State {
  const kept = { ...held };
  if (asked.colorMode === "temperature") {
    delete kept.hue;
    delete kept.saturation;
  }
  if (asked.colorMode === "color") {
    delete kept.colorTemperature;
  }
  return { ...kept, ...asked };
}

// v1's normalizeEntityCommand, applyCommandWithOptions and
// shouldPublishEntityCommand, for a light.
function prepareLight(
  capability: CapabilitySync,
  input: LightCommand,
): Prepared {
  const command = { ...input };
  // Dimming to nothing turns a light off; dimming it up turns it on.
  if (command.brightness === 0) {
    delete command.brightness;
    command.on = false;
  } else if (command.brightness !== undefined && command.on === undefined) {
    command.on = true;
  }
  const asked = light.desired(command);
  const isTurningOff =
    capability.sync === "pending" && capability.desired?.on === false;
  // The look requested by an off is already reserved for the next on,
  // even while its report is still on the way.
  const held =
    (capability.sync === "held" || isTurningOff) && capability.desired
      ? capability.desired
      : {};
  // A light whose state is unknown takes the command.
  const isOff = shownState(capability)?.on === false;
  // A colour for a light that is off waits until it turns on.
  if (command.on === undefined && isOff) {
    return {
      desired: withAppearance(held, asked),
      sync: isTurningOff ? "pending" : "held",
      send: null,
    };
  }
  // Turning a light off drops what was held and leaves the rest as the
  // light last reported it, unless the command says what it comes back at:
  // that waits, held once the light reports off (reconcile()), and only the
  // "off" goes out.
  if (command.on === false) {
    const send: State = { on: false };
    if (command.transitionSeconds !== undefined) {
      send.transitionSeconds = command.transitionSeconds;
    }
    // Compare the look only when the off is confirmed: a previous
    // command may still report a different colour before then.
    return { desired: asked, sync: "pending", send };
  }
  // Turning it on brings what was held, and the brightness it comes back at
  // (v1's lightOnCommand), unless the light reports it is on already: an
  // "on" still on its way may yet fail.
  const desired = command.on === true ? withAppearance(held, asked) : asked;
  if (
    command.on === true &&
    desired.brightness === undefined &&
    dims(capability) &&
    capability.observed?.on !== true
  ) {
    // A light reported off with nothing remembered comes back at 100.
    const brightness =
      rememberedBrightness(capability) ??
      (capability.observed ? 100 : undefined);
    if (brightness !== undefined) {
      desired.brightness = brightness;
    }
  }
  // The colour mode follows from the fields themselves.
  const send: State = { ...desired };
  delete send.colorMode;
  if (command.transitionSeconds !== undefined) {
    send.transitionSeconds = command.transitionSeconds;
  }
  return { desired, sync: "pending", send };
}

// What a report leaves of the on and off a command awaits: the next one is
// shown once the device reports it.
function stillAwaiting(capability: CapabilitySync, observed: State) {
  const awaiting =
    capability.sync === "pending" ? (capability.awaiting ?? []) : [];
  const left = awaiting[0] === observed.on ? awaiting.slice(1) : awaiting;
  return left.length > 0 ? left : undefined;
}

/** A report from the device (v1's reconcileEntityObservation). */
export function reconcile(
  capability: CapabilitySync,
  observed: State,
): Settled {
  const { desired, sync } = capability;
  // A report from before an earlier command confirms nothing; one that
  // shows the last of them may already confirm this one.
  const awaiting = stillAwaiting(capability, observed);
  if (awaiting) {
    return { desired, sync, awaiting };
  }
  // A light that reports off confirms an "off", and holds what it said the
  // light comes back at, as for a colour asked of it while off.
  if (desired?.on === false && sync === "pending" && observed.on === false) {
    const { on: _on, ...comesBackAt } = desired;
    return reconcile(
      { ...capability, desired: comesBackAt, sync: "held" },
      observed,
    );
  }
  if (desired && sync === "pending" && !confirms(observed, desired)) {
    return { desired, sync, awaiting };
  }
  // Held while the light stays off, until it reports the colour itself (a
  // light that is off rarely reports one at all); turned on some other way,
  // it shows what it reports.
  if (
    desired &&
    sync === "held" &&
    observed.on === false &&
    !confirms(observed, desired, { reported: true })
  ) {
    return { desired, sync };
  }
  return { desired: null, sync: "synced" };
}

/** The device did not confirm a command in time (v1's settleCommandTarget). */
export function settle(capability: CapabilitySync): Settled {
  const { desired, sync } = capability;
  if (sync !== "pending") {
    return { desired, sync };
  }
  // No report is from before an earlier command by now, so the last one
  // decides, even when the device never showed that command or its driver
  // reports only where a device ends.
  if (capability.awaiting?.length && capability.observed) {
    const settled = reconcile(
      { ...capability, awaiting: null },
      capability.observed,
    );
    if (settled.sync !== "pending") {
      return settled;
    }
  }
  if (
    capability.kind === "light" &&
    capability.observed?.on === false &&
    desired &&
    isAppearance(desired)
  ) {
    return { desired, sync: "held" };
  }
  return { desired: null, sync: "conflict" };
}
