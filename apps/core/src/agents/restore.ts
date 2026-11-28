import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";

import { ActionCallError } from "../app-host/errors.js";
import type { AgentCaller } from "../app-host/gate.js";
import type { Devices } from "../devices/devices.js";
import { matchesField } from "../devices/sync.js";
import type { View } from "../devices/views.js";
import type { ChangedCapability } from "./changes.js";

// Putting back one light or switch an AI agent changed: only while it still
// shows what the agent asked, checked again as the command goes out, so a
// person's, a switch's or an app's change since is left as it is and named,
// and a remote's dimming under way is left alone. What goes back is how the
// capability was when the agent's command was accepted.

class RestoreSkipped extends Error {
  constructor(readonly outcome: RestoreOutcome) {
    super("restore skipped");
  }
}

type RestoreOutcome = {
  name: string | null;
  result:
    | "gone"
    | "offline"
    | "uncertain"
    | "changed"
    | "skipped"
    | "sent"
    | "confirmed"
    | "failed";
  why?: string;
  by?: string | null;
  state?: CapabilityInfo["state"];
};

// A report may omit the mode. A single reported colour representation
// identifies it; if both are present, only an explicit mode can decide.
function colorModeOf(state: Record<string, unknown>) {
  if (state.colorMode === "temperature" || state.colorMode === "color") {
    return state.colorMode;
  }
  const hasTemperature = typeof state.colorTemperature === "number";
  const hasColor =
    typeof state.hue === "number" && typeof state.saturation === "number";
  if (hasTemperature !== hasColor)
    return hasTemperature ? "temperature" : "color";
}

/** Restores a capability only while it still shows what the agent set. */
export function createRestoreCapability(options: {
  devices: Pick<Devices, "get" | "commandFor">;
  appName: (appId: string) => string | undefined;
  view: () => View;
}) {
  // How a capability was, as a command: a light's on or off with its
  // brightness and colour, which an off holds for when it comes back on.
  function lookOf(
    kind: ChangedCapability["kind"],
    before: Record<string, unknown>,
  ): Record<string, unknown> {
    const look: Record<string, unknown> = { on: before.on === true };
    if (kind !== "light") return look;
    if (typeof before.brightness === "number" && before.brightness > 0) {
      look.brightness = before.brightness;
    }
    const mode = colorModeOf(before);
    if (
      mode === "color" &&
      typeof before.hue === "number" &&
      typeof before.saturation === "number"
    ) {
      look.hue = before.hue;
      look.saturation = before.saturation;
    } else if (
      mode === "temperature" &&
      typeof before.colorTemperature === "number"
    ) {
      look.colorTemperature = before.colorTemperature;
    }
    return look;
  }

  // Puts one capability back where it still shows what the agent set; one
  // changed since, by a person, a switch on the wall or an app, is left as
  // it is, and one whose command is still on its way is uncertain.
  function restoreStatus(
    item: ChangedCapability,
    device: DeviceInfo | null,
    capability: CapabilityInfo | undefined,
  ): RestoreOutcome | undefined {
    const name = device?.name ?? null;
    if (!device || capability?.kind !== item.kind) {
      return { name, result: "gone" };
    }
    if (device.availability === "offline") return { name, result: "offline" };
    if (capability.sync === "pending") return { name, result: "uncertain" };
    const state: Record<string, unknown> = { ...capability.state };
    if (capability.kind === "light") state.colorMode = colorModeOf(state);
    const differentFields = Object.keys(item.asked).filter(
      (field) => !matchesField(state, item.asked, field),
    );
    if (differentFields.length > 0) {
      const setBy = capability.setBy;
      const app =
        setBy?.app &&
        Date.parse(setBy.at) >= item.at.getTime() &&
        differentFields.some(
          (field) =>
            field in setBy.asked && matchesField(state, setBy.asked, field),
        )
          ? (options.appName(setBy.app) ?? setBy.app)
          : null;
      return { name, result: "changed", by: app, state: capability.state };
    }
  }

  return async function putBack(
    agent: AgentCaller,
    item: ChangedCapability,
  ): Promise<
    RestoreOutcome & Pick<ChangedCapability, "device" | "capability">
  > {
    const device = options.devices.get(item.device, options.view());
    const capability = device?.capabilities.find(
      (each) => each.id === item.capability,
    );
    const address = { device: item.device, capability: item.capability };
    const base = { ...address, name: device?.name ?? null };
    const skipped = restoreStatus(item, device, capability);
    if (skipped) return { ...address, ...skipped };
    if (!item.before) {
      return { ...base, result: "skipped", why: "unknown_before" };
    }
    try {
      let isConfirmed = false;
      const after = await options.devices.commandFor(
        agent,
        { ...address, command: lookOf(item.kind, item.before) },
        {
          shouldLeaveMoving: true,
          accepted: (_change, confirmed) => {
            isConfirmed = confirmed;
          },
          check(target) {
            const skipped = restoreStatus(
              item,
              target.device,
              target.capability,
            );
            if (skipped) throw new RestoreSkipped(skipped);
          },
        },
      );
      return {
        ...base,
        result: isConfirmed ? "confirmed" : "sent",
        state: after.state,
      };
    } catch (error) {
      if (error instanceof RestoreSkipped)
        return { ...address, ...error.outcome };
      if (error instanceof ActionCallError && error.code === "not_found") {
        return { ...base, result: "gone" };
      }
      if (error instanceof ActionCallError && error.code === "conflict") {
        return { ...base, result: "uncertain" };
      }
      return {
        ...base,
        result: "failed",
        why: error instanceof ActionCallError ? error.code : "failed",
      };
    }
  };
}
