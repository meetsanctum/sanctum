import {
  lowBattery,
  onBattery,
  type CapabilityKind,
  type FirmwareInfo,
} from "@meetsanctum/app-sdk";

import type { Activity, ActivityEntry, Joining } from "../activity/activity.js";
import { activityTimes } from "../activity/kinds.js";
import type { Outcome } from "../activity/schema.js";
import type { deviceCapabilities } from "./schema.js";

// What Devices writes to the activity log: each command with what it asked
// for and the app that sent it, joined while it leaves a light on or off as
// it was, and whether it went again (`resent`); a command the device did not
// answer; a light or switch turned on or off outside Sanctum; a device going
// offline and coming back; and, for Maintenance, one on a battery going
// quiet, its battery falling low and a new battery.

// The person and client behind a call, or the actor acting on its own.
export type Who = { personId?: string; clientId?: string; actor?: string };

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
    who: Who,
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
        personId: who.personId,
        clientId: who.clientId,
        actor: who.actor,
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
      who: Who,
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
        firmware?: FirmwareInfo | null;
      },
      availability: string,
    ) {
      const battery = device.battery ?? null;
      const went =
        availability === "offline" && device.availability === "online"
          ? "device.offline"
          : availability === "online" && device.availability === "offline"
            ? "device.online"
            : availability === "unknown" &&
                device.availability === "online" &&
                onBattery({ battery, firmware: device.firmware ?? null })
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

    /** A battery's charge falling under lowBattery, or a new battery, from the charge it said before. */
    battery(
      device: { id: string; battery: number | null; createdAt: Date },
      battery: number,
      at: Date,
    ) {
      const was = device.battery;
      if (was === null) return;
      const action =
        was >= lowBattery && battery < lowBattery
          ? "device.battery.low"
          : battery - was >= newBatteryRise &&
              at.getTime() - device.createdAt.getTime() >= batterySettlesMs
            ? "device.battery.new"
            : null;
      if (action) {
        record({
          action,
          outcome: "ok",
          actor: "device",
          subjectId: device.id,
          detail: { battery, was },
        });
      }
    },
  };
}
