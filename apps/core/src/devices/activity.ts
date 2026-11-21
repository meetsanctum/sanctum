import {
  hasLowBattery,
  lowCharge,
  onBattery,
  type CapabilityKind,
  type FirmwareInfo,
} from "@meetsanctum/app-sdk";

import type {
  Activity,
  ActivityAuthor,
  ActivityEntry,
  Joining,
} from "../activity/activity.js";
import { activityTimes } from "../activity/kinds.js";
import type { Outcome } from "../activity/schema.js";
import type { deviceCapabilities } from "./schema.js";

// What Devices writes to the activity log: each command with what it asked
// for and the app that sent it, joined while it leaves a light on or off as
// it was, and whether it went again (`resent`); a command the device did not
// answer; a light or switch turned on or off outside Sanctum; a device going
// offline and coming back; and, for Maintenance, one on a battery going
// quiet, its battery going low and a new battery.

/** A command as its entry says it: what it asked of which capability, and the app that sent it. */
export type Sent = {
  capability: string;
  kind: CapabilityKind;
  asked: Record<string, unknown>;
  app: string | null;
};

type CapabilityRow = typeof deviceCapabilities.$inferSelect;

// A charge that rises this much at once is a new battery, as Battery Notes
// reckons it.
const newBatteryRise = 25;
// A device's first reports can be wrong, as a Hue dimmer says 5% before its
// 100%: a rise this soon after it joined is no new battery.
const batterySettlesMs = 60 * 60_000;

// A command that leaves a light on or off as it was joins the entry before
// it when that one did too: it keeps what the first asked as `from`. A
// motion sensor's settings each keep an entry of their own.
const adjustments = (capability: string): Joining => ({
  withinMs: activityTimes.adjustmentsJoinMs,
  matches: (previous: ActivityEntry) =>
    previous.detail?.capability === capability &&
    !("on" in ((previous.detail.asked as Record<string, unknown>) ?? {})),
  detail: (previous, next) => ({
    ...next,
    from: previous?.from ?? previous?.asked,
  }),
});

export function createDeviceLog(options: {
  activity: Pick<Activity, "for" | "get" | "update" | "within">;
  // How long a device has to confirm a command.
  confirmMs: number;
}) {
  const { activity, confirmMs } = options;
  const record = activity.for("devices");

  // A command's entry; it answers the entry's id, or the one it joined.
  // One that failed after joining others keeps their cause.
  function command(
    who: ActivityAuthor,
    deviceId: string,
    outcome: Outcome,
    reason?: string,
    sent?: Sent,
    failed: { hasResent?: boolean } = {},
  ) {
    const adjusts =
      sent !== undefined && sent.kind === "light" && !("on" in sent.asked);
    return record(
      {
        action: "device.command",
        outcome,
        reason,
        ...who,
        app: sent?.app ?? null,
        subjectId: deviceId,
        detail: sent && {
          capability: sent.capability,
          asked: sent.asked,
          ...(failed.hasResent && { resent: true }),
        },
      },
      adjusts ? adjustments(sent.capability) : undefined,
    );
  }

  return {
    command,

    /**
     * A command the device did not confirm in time, even sent again, or that
     * could not go again: its entry failed, or, for one that joins several,
     * an entry of its own.
     */
    unanswered(
      entryId: string,
      who: ActivityAuthor,
      deviceId: string,
      sent: Sent,
      failure: { reason: string; hasResent: boolean },
    ) {
      const entry = activity.get(entryId);
      if (!entry) return;
      if (entry.count === 1) {
        activity.update(entryId, { outcome: "failed", reason: failure.reason });
      } else {
        // Restoring an older command can run inside a newer workflow.
        // Preserve the original cause, including when there was none.
        activity.within(entry.causeId ?? {}, () =>
          command(who, deviceId, "failed", failure.reason, sent, {
            hasResent: failure.hasResent,
          }),
        );
      }
    },

    /** A command that went again, unconfirmed: its entry says so, unless it joins several. */
    resent(entryId: string) {
      const entry = activity.get(entryId);
      if (!entry || entry.count !== 1) return;
      activity.update(entryId, { detail: { ...entry.detail, resent: true } });
    },

    /**
     * A light or switch turned on or off that no command explains, as at
     * its wall switch or in its maker's app: none while a command waits to
     * be confirmed, or soon after one last went (`sentAt`, ms), when a
     * report can still be its echo.
     */
    reported(
      deviceId: string,
      capability: CapabilityRow,
      observed: Record<string, unknown>,
      at: Date,
      sentAt?: number,
    ) {
      const was = capability.observed?.on;
      if (typeof was !== "boolean" || typeof observed.on !== "boolean") {
        return;
      }
      if (was === observed.on || capability.sync === "pending") return;
      const setAt = capability.setBy ? Date.parse(capability.setBy.at) : NaN;
      const lastSent = Math.max(
        Number.isNaN(setAt) ? -Infinity : setAt,
        sentAt ?? -Infinity,
      );
      if (at.getTime() - lastSent < 2 * confirmMs) return;
      record({
        action: "device.changed",
        outcome: "ok",
        actor: "device",
        subjectId: deviceId,
        detail: { capability: capability.id, on: observed.on },
      });
    },

    /**
     * A device that stopped answering, or answers again after it had, and
     * one on a battery whose driver no longer knows whether it does: it
     * went quiet, with the charge it last said.
     */
    availability(
      device: {
        id: string;
        availability: string;
        battery?: number | null;
        batteryLow?: boolean | null;
        firmware?: FirmwareInfo | null;
      },
      availability: string,
    ) {
      const battery = device.battery ?? null;
      const batteryLow = device.batteryLow ?? null;
      const went =
        availability === "offline" && device.availability === "online"
          ? "device.offline"
          : availability === "online" && device.availability === "offline"
            ? "device.online"
            : availability === "unknown" &&
                device.availability === "online" &&
                onBattery({
                  battery,
                  batteryLow,
                  firmware: device.firmware ?? null,
                })
              ? "device.quiet"
              : null;
      if (went) {
        record({
          action: went,
          outcome: "ok",
          actor: "device",
          subjectId: device.id,
          detail:
            went === "device.quiet" && battery !== null
              ? { battery }
              : undefined,
        });
      }
    },

    /**
     * A battery going low, by its charge falling under lowBattery or by the
     * device saying so itself, and a new battery, by its charge rising:
     * each from what the device said before, so its first word of its
     * battery records nothing. A device that takes back that its battery
     * is low has no new one for that: a cold battery recovers as it warms.
     */
    battery(
      device: {
        id: string;
        battery: number | null;
        batteryLow: boolean | null;
        createdAt: Date;
      },
      said: { battery?: number; batteryLow?: boolean },
      at: Date,
    ) {
      const was = device.battery;
      if (was === null && device.batteryLow === null) return;
      const before = { battery: was, batteryLow: device.batteryLow };
      const after = {
        battery: said.battery ?? was,
        batteryLow: said.batteryLow ?? before.batteryLow,
      };
      if (!hasLowBattery(before) && hasLowBattery(after)) {
        // Its charge only where that is what is low.
        const battery = lowCharge(after);
        record({
          action: "device.battery.low",
          outcome: "ok",
          actor: "device",
          subjectId: device.id,
          detail:
            battery === undefined
              ? undefined
              : { battery, ...(was !== null && { was }) },
        });
        return;
      }
      if (
        was !== null &&
        said.battery !== undefined &&
        said.battery - was >= newBatteryRise &&
        at.getTime() - device.createdAt.getTime() >= batterySettlesMs
      ) {
        record({
          action: "device.battery.new",
          outcome: "ok",
          actor: "device",
          subjectId: device.id,
          detail: { battery: said.battery, was },
        });
      }
    },
  };
}
