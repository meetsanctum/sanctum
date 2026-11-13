import { buttonAction, pressParts } from "@meetsanctum/app-sdk";

import type { ZigbeeExpose } from "./types.js";
import { stringValue } from "./values.js";

// A remote's presses: the actions its action expose declares, which of them
// are holds, and what a device's message carries. Each press goes to the
// core once, a hold once however often the remote repeats it, and a
// release-like action, such as a hold's end, tells the core the button was
// let go.

const releaseLike = /(?:^|[_\s-])(release|released|stop|end)(?:$|[_\s-])/i;
// A press that lasts until its release: Hue's up_hold, Aqara's hold and
// long, IKEA's brightness_move_up.
const holdLike = /(?:^|_)(?:hold|long)$|(?:^|_)move_(?:up|down)$/i;
// How long a hold's repeats may pause before one counts as a new hold, as
// when its release was lost. Hue's dimmer repeats about every 0.8 s.
export const holdRepeatMs = 2_000;
// How long after its press a tap's release may come and still make it a
// tap. Hue's dimmer says a hold 0.8 s after the press, and a tap's release
// within a tenth of a second of letting go.
export const tapReleaseMs = 1_000;
// The core takes this many actions for one button.
export const maxActions = 64;

/** Whether an action only ends another, such as on_hold_release or brightness_stop. */
export function isReleaseLike(action: string) {
  return releaseLike.test(action);
}

// An action the core takes as a press.
function isPress(action: string | null): action is string {
  return (
    action !== null &&
    !isReleaseLike(action) &&
    buttonAction.safeParse(action).success
  );
}

/** Whether an expose is a device's actions, as Zigbee2MQTT lists a remote's buttons. */
export function isActionExpose(expose: ZigbeeExpose) {
  return expose.type === "enum" && expose.property === "action";
}

/** Whether a press lasts until its release, such as up_hold. */
export function isHold(action: string) {
  return holdLike.test(action) && !isReleaseLike(action);
}

function exposeValues(expose: ZigbeeExpose) {
  return (Array.isArray(expose.values) ? expose.values : [])
    .map(stringValue)
    .filter((value) => value !== null);
}

/** The presses an action expose declares, each once, in its order. */
export function pressActions(expose: ZigbeeExpose): string[] {
  return [...new Set(exposeValues(expose).filter(isPress))].slice(
    0,
    maxActions,
  );
}

/**
 * The presses a remote says as its button goes down and again at their
 * release, on a button that also holds: Hue's dimmer sends up_press first,
 * then up_press_release for a tap or up_hold 0.8 s on. Such a tap reaches
 * the core at its release, so a hold never starts as a tap.
 */
export function tapsAtRelease(expose: ZigbeeExpose): string[] {
  const values = exposeValues(expose);
  const actions = pressActions(expose);
  const holds = actions.filter(isHold);
  return actions.filter((action) => {
    const { button } = pressParts(action);
    return (
      button !== null &&
      !holds.includes(action) &&
      values.includes(`${action}_release`) &&
      holds.some((hold) => pressParts(hold).button === button)
    );
  });
}

/** The press a device's message carries, if it is one the button declares. */
export function pressOf(
  button: { property: string; features: { actions: readonly string[] } },
  payload: Record<string, unknown>,
): string | null {
  const action = stringValue(payload[button.property]);
  return isPress(action) && button.features.actions.includes(action)
    ? action
    : null;
}

/** Whether a device's message says its button was let go. */
export function isReleaseOf(
  button: { property: string },
  payload: Record<string, unknown>,
) {
  const action = stringValue(payload[button.property]);
  return action !== null && isReleaseLike(action);
}

/** What to tell the core of a button's message: a press, a release, or nothing. */
export type Heard = { press: string } | { release: true } | null;

/**
 * Follows each button's holds, so a hold reaches the core once however
 * often the remote repeats it until it is let go: Hue's dimmer sends
 * up_hold again about every second while held. A repeat after a pause
 * longer than holdRepeatMs is a new hold, as when its release was lost.
 * A tap the remote also says at its release (tapsAtRelease) waits for that
 * release; it is dropped when a hold of its button comes instead, or
 * another press, or no release within tapReleaseMs.
 */
export function createHolds(now: () => number = Date.now) {
  const holding = new Map<string, { action: string; at: number }>();
  const taps = new Map<string, { action: string; at: number }>();
  const keyOf = (device: string, capability: string) =>
    `${device}/${capability}`;
  return {
    heard(
      device: string,
      button: {
        id: string;
        property: string;
        features: { actions: readonly string[]; holds: readonly string[] };
        tapsAtRelease?: readonly string[];
      },
      payload: Record<string, unknown>,
    ): Heard {
      const key = keyOf(device, button.id);
      if (isReleaseOf(button, payload)) {
        holding.delete(key);
        const tap = taps.get(key);
        taps.delete(key);
        return tap &&
          now() - tap.at <= tapReleaseMs &&
          stringValue(payload[button.property]) === `${tap.action}_release`
          ? { press: tap.action }
          : { release: true };
      }
      const action = pressOf(button, payload);
      if (!action) return null;
      taps.delete(key);
      if (button.tapsAtRelease?.includes(action)) {
        holding.delete(key);
        taps.set(key, { action, at: now() });
        return null;
      }
      if (!button.features.holds.includes(action)) {
        holding.delete(key);
        return { press: action };
      }
      const at = now();
      const held = holding.get(key);
      holding.set(key, { action, at });
      return held?.action === action && at - held.at <= holdRepeatMs
        ? null
        : { press: action };
    },

    /** Forgets a device's holds, as when it leaves. */
    forget(device: string) {
      for (const map of [holding, taps]) {
        for (const key of map.keys()) {
          if (key.startsWith(`${device}/`)) map.delete(key);
        }
      }
    },
  };
}
