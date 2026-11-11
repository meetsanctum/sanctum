import {
  deviceFirmware,
  probeWaitMs as defaultProbeWaitMs,
  type Actor,
  type DeviceInfo,
  type DriverDevice,
  type FirmwareInfo,
  type FirmwareState,
  type ProbeResult,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import { z } from "zod";

import type { RecordActivity } from "../activity/activity.js";
import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Rule } from "../app-host/gate.js";
import type { CoreDatabase } from "../database.js";
import type { Devices } from "./devices.js";
import { devices as deviceTable } from "./schema.js";

// Firmware updates and Check connection, the same whatever the radio. A
// driver says what each device runs and whether it can update it when it
// registers it, and what an update is doing as it learns it; the core keeps
// that with the device. Every client, a shared one too, checks for an
// update, starts one or stops it, and Check connection asks a device how it
// is now and waits for its report. No workflow or app can start an update, a
// destructive action: it takes a device away for an hour or more and cannot
// be undone.

export const firmwareRules = {
  check: { tier: "read" },
  update: { tier: "destructive" },
  stop: { tier: "write" },
  probe: { tier: "read" },
} as const satisfies Record<string, Rule>;

export const deviceRequest = z.object({ id: z.string().min(1).max(64) });

export type FirmwareHook = "check" | "update" | "stop";

/** The driver apps' firmware and probe hooks, through the app host. */
export type FirmwareDrivers = {
  firmware(
    driver: string,
    hook: FirmwareHook,
    device: DriverDevice,
    actor: Actor,
  ): Promise<void>;
  probe(driver: string, device: DriverDevice, actor: Actor): Promise<void>;
};

// An update that has said nothing for this long has stopped, as when the
// device lost power: Zigbee2MQTT itself gives up after 150 seconds without
// a request for the next block.
export const staleMs = 10 * 60_000;

// The person and client behind a call, for the activity log.
type Who = { personId?: string; clientId?: string };

type Said = z.output<typeof deviceFirmware>;

// Waiting for the device, or under way.
const isRunning = (state: FirmwareState | null) =>
  state === "waiting" || state === "updating";

/**
 * What a device's firmware is after its driver said `said`. A failure
 * stays while the driver says an update is available, as a driver does
 * once an update fails; whether one is available counts as checked when
 * it changes.
 */
export function nextFirmware(
  current: FirmwareInfo,
  said: Said,
  at: string,
): FirmwareInfo {
  const was = current.state;
  if (said.state === "available" && was === "failed") {
    return current;
  }
  const isKnown = said.state === "current" || said.state === "available";
  return {
    ...current,
    state: said.state,
    progress: said.state === "updating" ? said.progress : null,
    remainingSeconds: said.state === "updating" ? said.remainingSeconds : null,
    problem:
      said.state === "failed"
        ? (said.problem ?? "The update did not finish.")
        : null,
    checkedAt: isKnown && said.state !== was ? at : current.checkedAt,
    startedAt:
      isRunning(said.state) && !isRunning(was) ? at : current.startedAt,
    endedAt: isRunning(was) && !isRunning(said.state) ? at : current.endedAt,
  };
}

export function createFirmware(options: {
  db: CoreDatabase;
  devices: Devices;
  drivers: FirmwareDrivers;
  record: RecordActivity;
  now?: () => Date;
  staleMs?: number;
  probeWaitMs?: number;
}) {
  const { db, devices, drivers, record } = options;
  const now = options.now ?? (() => new Date());
  const stale = options.staleMs ?? staleMs;
  const probeWait = options.probeWaitMs ?? defaultProbeWaitMs;
  // Each update under way's deadline for its next word.
  const deadlines = new Map<string, NodeJS.Timeout>();
  // The devices whose update a driver is starting, so a second update
  // cannot slip in before the first says it is under way.
  const starting = new Map<string, { hasReported: boolean }>();
  // Check connection's waits for a device's next report.
  const probes = new Map<string, Set<() => void>>();

  function log(
    action: string,
    id: string,
    outcome: Outcome,
    who: Who = {},
    reason?: string,
  ) {
    record({
      action,
      outcome,
      reason,
      personId: who.personId,
      clientId: who.clientId,
      subjectId: id,
    });
  }

  function write(id: string, firmware: FirmwareInfo) {
    devices.changing(id, () =>
      db
        .update(deviceTable)
        .set({ firmware })
        .where(eq(deviceTable.id, id))
        .run(),
    );
    watch(id, firmware);
  }

  // An update under way must say something before its deadline.
  function watch(id: string, firmware: FirmwareInfo) {
    clearTimeout(deadlines.get(id));
    deadlines.delete(id);
    if (firmware.state !== "updating") return;
    const timer = setTimeout(() => {
      deadlines.delete(id);
      const current = devices.row(id)?.firmware;
      if (current?.state !== "updating") return;
      write(id, {
        ...current,
        state: "failed",
        progress: null,
        remainingSeconds: null,
        problem: "It stopped answering.",
        endedAt: now().toISOString(),
      });
      log("device.firmware.failed", id, "failed", {}, "stopped_answering");
    }, stale);
    timer.unref?.();
    deadlines.set(id, timer);
  }

  // Updates under way when the core stopped keep their deadline.
  for (const { id, firmware } of db
    .select({ id: deviceTable.id, firmware: deviceTable.firmware })
    .from(deviceTable)
    .all()) {
    if (firmware) watch(id, firmware);
  }

  // A device whose firmware its driver can update, for a client's call.
  function updatable(input: unknown, action: string, who: Who) {
    const parsed = deviceRequest.safeParse(input);
    if (!parsed.success) {
      throw new ActionCallError("invalid_request");
    }
    const { id } = parsed.data;
    const row = devices.row(id);
    if (!row) {
      throw new ActionCallError("not_found");
    }
    if (!row.firmware?.updatable) {
      log(action, id, "refused", who, "conflict");
      throw new ActionCallError("conflict");
    }
    return { id, row, firmware: row.firmware };
  }

  async function call(
    action: string,
    hook: FirmwareHook,
    row: { id: string; driver: string; key: string },
    actor: Actor,
    who: Who,
  ) {
    try {
      await drivers.firmware(
        row.driver,
        hook,
        { key: row.key, device: row.id },
        actor,
      );
    } catch (error) {
      const failure =
        error instanceof ActionCallError
          ? error
          : new ActionCallError("app_failed");
      log(
        action,
        row.id,
        failure.status >= 500 ? "failed" : "refused",
        who,
        failure.code,
      );
      throw failure;
    }
  }

  const shown = (id: string): DeviceInfo => devices.get(id)!;

  return {
    // A driver says what one of its devices' firmware is doing.
    report(driver: string, input: unknown) {
      const parsed = deviceFirmware.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `${driver} said something of firmware the core cannot take: ${z.prettifyError(parsed.error)}`,
        );
      }
      const said = parsed.data;
      const id = devices.idFor(driver, said.key);
      const row = id ? devices.row(id) : null;
      if (!id || !row) {
        throw new ActionCallError("not_found");
      }
      if (!row.firmware) {
        throw new Error(
          `${driver} said what ${said.key}'s firmware is doing without registering it with firmware`,
        );
      }
      const attempt = starting.get(id);
      if (attempt) attempt.hasReported = true;
      const next = nextFirmware(row.firmware, said, now().toISOString());
      if (JSON.stringify(next) === JSON.stringify(row.firmware)) {
        watch(id, next);
        return;
      }
      write(id, next);
      if (row.firmware.state === "updating" && said.state === "current") {
        log("device.firmware.updated", id, "ok");
      } else if (said.state === "failed" && row.firmware.state !== "failed") {
        log("device.firmware.failed", id, "failed", {}, "driver");
      }
    },

    // Asks the device's driver whether an update is available; answers
    // the device as it is once the driver has said.
    async check(actor: Actor, who: Who, input: unknown): Promise<DeviceInfo> {
      const action = "device.firmware.check";
      const { id, row, firmware } = updatable(input, action, who);
      if (isRunning(firmware.state)) {
        log(action, id, "refused", who, "conflict");
        throw new ActionCallError("conflict");
      }
      await call(action, "check", row, actor, who);
      const after = devices.row(id)?.firmware;
      if (after) {
        write(id, { ...after, checkedAt: now().toISOString() });
      }
      log(action, id, "ok", who);
      return shown(id);
    },

    // Starts an update the driver knows of. One device of a driver
    // updates at a time, so the rest of its network stays responsive; one
    // that waits for a sleeping device to wake does not count.
    async update(actor: Actor, who: Who, input: unknown): Promise<DeviceInfo> {
      const action = "device.firmware.update";
      const { id, row, firmware } = updatable(input, action, who);
      const busy = db
        .select({ id: deviceTable.id, firmware: deviceTable.firmware })
        .from(deviceTable)
        .where(eq(deviceTable.driver, row.driver))
        .all()
        .some(
          (other) =>
            other.id !== id &&
            (other.firmware?.state === "updating" || starting.has(other.id)),
        );
      if (
        busy ||
        starting.has(id) ||
        (firmware.state !== "available" && firmware.state !== "failed")
      ) {
        log(action, id, "refused", who, "conflict");
        throw new ActionCallError("conflict");
      }
      const attempt = { hasReported: false };
      starting.set(id, attempt);
      try {
        await call(action, "update", row, actor, who);
      } finally {
        starting.delete(id);
      }
      // Under way only if the driver has not already reported an outcome.
      const after = devices.row(id)?.firmware;
      if (after && !attempt.hasReported) {
        write(id, {
          ...after,
          state: "updating",
          progress: null,
          remainingSeconds: null,
          problem: null,
          startedAt: now().toISOString(),
        });
      }
      log(action, id, "ok", who);
      return shown(id);
    },

    // Stops an update under way or waiting; the device keeps what it runs.
    async stop(actor: Actor, who: Who, input: unknown): Promise<DeviceInfo> {
      const action = "device.firmware.stop";
      const { id, row, firmware } = updatable(input, action, who);
      if (!isRunning(firmware.state)) {
        log(action, id, "refused", who, "conflict");
        throw new ActionCallError("conflict");
      }
      await call(action, "stop", row, actor, who);
      const after = devices.row(id)?.firmware;
      if (after && isRunning(after.state)) {
        write(id, {
          ...after,
          state: "available",
          progress: null,
          remainingSeconds: null,
          endedAt: now().toISOString(),
        });
      }
      log(action, id, "ok", who);
      return shown(id);
    },

    // Check connection: asks the device how it is now and waits a while
    // for its report.
    async probe(actor: Actor, who: Who, input: unknown): Promise<ProbeResult> {
      const action = "device.probe";
      const parsed = deviceRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const { id } = parsed.data;
      const row = devices.row(id);
      if (!row) {
        throw new ActionCallError("not_found");
      }
      if (!row.probe) {
        log(action, id, "refused", who, "conflict");
        throw new ActionCallError("conflict");
      }
      const started = performance.now();
      let answered!: () => void;
      let timer: NodeJS.Timeout | undefined;
      // Waiting before asking, since the answer may beat the driver's.
      const answer = new Promise<number | null>((resolve) => {
        answered = () => resolve(Math.round(performance.now() - started));
        timer = setTimeout(() => resolve(null), probeWait);
      });
      const waits = probes.get(id) ?? new Set();
      waits.add(answered);
      probes.set(id, waits);
      try {
        const asking = drivers.probe(
          row.driver,
          { key: row.key, device: id },
          actor,
        );
        // A driver still asking when the wait is over has no answer either;
        // its failure after that is no news.
        asking.catch(() => undefined);
        const answeredInMs = await Promise.race([
          answer,
          asking.then(() => answer),
        ]);
        log(
          action,
          id,
          "ok",
          who,
          answeredInMs === null ? "no_answer" : undefined,
        );
        return { answeredInMs };
      } catch (error) {
        const failure =
          error instanceof ActionCallError
            ? error
            : new ActionCallError("app_failed");
        log(
          action,
          id,
          failure.status >= 500 ? "failed" : "refused",
          who,
          failure.code,
        );
        throw failure;
      } finally {
        clearTimeout(timer);
        waits.delete(answered);
        if (waits.size === 0) probes.delete(id);
      }
    },

    // A device's report committed: it answered whoever is checking it.
    reported(id: string) {
      for (const answered of probes.get(id) ?? []) answered();
    },

    close() {
      for (const timer of deadlines.values()) clearTimeout(timer);
      deadlines.clear();
    },
  };
}

export type Firmware = ReturnType<typeof createFirmware>;
