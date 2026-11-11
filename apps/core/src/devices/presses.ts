import {
  ActionError,
  devicePress,
  deviceRelease,
  pressCaptureDurationMs,
  type DeviceInfo,
  type PressCapture,
} from "@meetsanctum/app-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Activity, Joining } from "../activity/activity.js";
import { activityTimes } from "../activity/kinds.js";
import {
  ActionCallError,
  type ActionCallErrorCode,
} from "../app-host/errors.js";
import type { Devices } from "./devices.js";

// A remote's presses: a driver says one of its devices was pressed, and the
// core hands the press on once, as it happens, to live clients, running apps
// and workflows. A press is never state, so nothing compares it with the
// last one, which v1 did with press times. The end of a hold, a release,
// only ends what the hold set going, such as lights brightening (holds.ts):
// it is not a press and goes nowhere else. A capture holds a remote's
// presses back from apps and workflows while someone picks one, as v1's
// runtime suppression `button_action_capture` did, for five minutes at most;
// captures live in memory, so a restart ends them. Each belongs to the
// client that asked and, when an app's page asked, to the app, which must be
// running and read remotes' buttons: it ends when the app pauses or loses
// that permission, and only its client stops it. Each press goes to the
// activity log, a held button's repeats as one, and what it sets off has it
// as its cause.

/** A press as the core hands it on. */
export type Press = {
  id: string;
  // The remote as people see it, every capability included.
  device: DeviceInfo;
  capability: string;
  action: string;
  at: Date;
  // Whether a capture holds it back from apps and workflows.
  isCaptured: boolean;
};

export const captureRequest = z.object({
  device: z.string().min(1).max(64),
  // The app whose page asks, if any.
  app: z.string().min(1).max(128).optional(),
});
export const captureRef = z.object({ id: z.string().min(1).max(64) });

function invalid(what: string, error: z.ZodError) {
  return new Error(`${what}: ${z.prettifyError(error)}`);
}

// The device's button with this id, if it has one.
function buttonOf(device: DeviceInfo | null, capability?: string) {
  return device?.capabilities.find(
    (each) =>
      each.kind === "button" &&
      (capability === undefined || each.id === capability),
  );
}

// A press repeated soon after the same one joins its entry.
const repeats = (
  capability: string,
  action: string,
  isCaptured: boolean,
): Joining => ({
  withinMs: activityTimes.pressesJoinMs,
  matches: (previous) =>
    previous.detail?.capability === capability &&
    previous.detail?.action === action &&
    previous.detail?.captured === isCaptured,
});

export function createPresses(options: {
  devices: Pick<Devices, "idFor" | "get" | "report">;
  activity?: Pick<Activity, "for" | "within">;
  // Called with each press, captured or not.
  onPress: (press: Press) => void;
  // Called with each release of a remote's button.
  onRelease?: (release: { device: string; capability: string }) => void;
  // Why an app's page may not capture presses now, or null when it may.
  captureRefusal?: (appId: string) => ActionCallErrorCode | null;
  now?: () => Date;
}) {
  const { devices, activity } = options;
  const record = activity?.for("devices");
  const now = options.now ?? (() => new Date());
  const captures = new Map<
    string,
    { device: string; until: number; app: string | null; client: string }
  >();

  function prune(at: number) {
    for (const [id, capture] of captures) {
      if (capture.until <= at) {
        captures.delete(id);
      }
    }
  }

  function isCapturing(deviceId: string) {
    prune(now().getTime());
    return [...captures.values()].some(
      (capture) => capture.device === deviceId,
    );
  }

  // The core's id for a driver's device and its button.
  function remoteOf(driver: string, key: string, capability: string) {
    const id = devices.idFor(driver, key);
    const button = buttonOf(id ? devices.get(id) : null, capability);
    if (!id || !button) {
      throw new ActionError(
        "not_found",
        `${driver} has no device ${key} with a button ${capability}`,
      );
    }
    return { id, button };
  }

  return {
    // A driver says one of its own devices was pressed, by its own key.
    press(driver: string, input: unknown) {
      const parsed = devicePress.safeParse(input);
      if (!parsed.success) {
        throw invalid(
          `${driver} sent a press the core cannot take`,
          parsed.error,
        );
      }
      const { key, capability, action } = parsed.data;
      const { id, button } = remoteOf(driver, key, capability);
      if (
        button.kind !== "button" ||
        !button.features.actions.includes(action)
      ) {
        throw new Error(
          `${driver}'s device ${key} pressed ${action}, which its button does not declare`,
        );
      }
      // A press means the device answers.
      devices.report(driver, { key, availability: "online" });
      const press: Press = {
        id: randomUUID(),
        device: devices.get(id)!,
        capability,
        action,
        at: now(),
        isCaptured: isCapturing(id),
      };
      const entry = record?.(
        {
          action: "device.press",
          outcome: "ok",
          actor: "device",
          subjectId: id,
          detail: { capability, action, captured: press.isCaptured },
        },
        repeats(capability, action, press.isCaptured),
      );
      if (activity && entry) {
        activity.within(entry, () => options.onPress(press));
      } else {
        options.onPress(press);
      }
    },

    // A driver says a hold of one of its own devices ended: its button was
    // let go.
    released(driver: string, input: unknown) {
      const parsed = deviceRelease.safeParse(input);
      if (!parsed.success) {
        throw invalid(
          `${driver} sent a release the core cannot take`,
          parsed.error,
        );
      }
      const { key, capability } = parsed.data;
      const { id } = remoteOf(driver, key, capability);
      devices.report(driver, { key, availability: "online" });
      options.onRelease?.({ device: id, capability });
    },

    /**
     * Holds a remote's presses back from apps and workflows for a while, as
     * someone picks one, for the client that asks; every client may.
     */
    capture(input: unknown, client: string): PressCapture {
      const parsed = captureRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const { device, app = null } = parsed.data;
      const refused = app && options.captureRefusal?.(app);
      if (refused) {
        throw new ActionCallError(refused);
      }
      if (!buttonOf(devices.get(device))) {
        throw new ActionCallError("not_found");
      }
      const id = randomUUID();
      const at = now().getTime();
      // Abandoned captures expire even when no remote has been pressed
      // between attempts, so each new capture cannot grow this forever.
      prune(at);
      const until = at + pressCaptureDurationMs;
      captures.set(id, { device, until, app, client });
      return { id, device, until: new Date(until).toISOString() };
    },

    /** Ends one of the client's captures, which may have ended already. */
    stopCapture(input: unknown, client: string) {
      const parsed = captureRef.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      if (captures.get(parsed.data.id)?.client === client) {
        captures.delete(parsed.data.id);
      }
    },

    /** Ends an app's captures, as it pauses or may no longer read buttons. */
    endCaptures(appId: string) {
      for (const [id, capture] of captures) {
        if (capture.app === appId) {
          captures.delete(id);
        }
      }
    },
  };
}

export type Presses = ReturnType<typeof createPresses>;
