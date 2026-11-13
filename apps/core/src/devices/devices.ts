import {
  ActionError,
  capabilityOf,
  deviceRegistration,
  deviceReport,
  historyFields,
  type Actor,
  type CapabilityInfo,
  type CapabilityKind,
  type DeviceCommand,
  type DeviceInfo,
  type DriverCommand,
  type FirmwareInfo,
} from "@meetsanctum/app-sdk";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Activity, ChangedBy } from "../activity/activity.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Gate, Rule } from "../app-host/gate.js";
import type { Principal } from "../auth/clients.js";
import type { CoreDatabase } from "../database.js";
import type { PlacesModule } from "../places/places.js";
import { createDeviceLog, type Who } from "./activity.js";
import { createCommandTracking } from "./commands.js";
import { createNaming } from "./naming.js";
import { createPresence } from "./presence.js";
import { writeCapabilities } from "./registration.js";
import { createRemoval, type RemoveFromDriver } from "./removal.js";
import { createTurns } from "./turns.js";
import { deviceCapabilities, devices, type StoredSetBy } from "./schema.js";
import {
  confirmMs as defaultConfirmMs,
  observe,
  prepare,
  reconcile,
  settle,
  type Settled,
} from "./sync.js";
import { deviceInfo, viewOf, type View } from "./views.js";

// The Devices module: the registry of what driver apps bring in, their typed
// capabilities, state and commands, and the Drivers contract. A driver
// registers and reports its own devices by its own keys, so it cannot name
// another driver's; a command passes the permission gate as its actor and
// goes to the device's driver app, and the device's report confirms it
// (sync.ts). Each capability says who set it last: the app that sent the
// command and the actor behind it, so natural light can tell a mood's or a
// person's change from its own. A new device is named after its room and
// type until the household names it (naming.ts), and removing a device has
// its driver take it off its network first (removal.ts).

/** What a change did to a device, for live clients; null where it did not or no longer exists. */
export type DeviceChange = {
  id: string;
  before: DeviceInfo | null;
  after: DeviceInfo | null;
};

/** Hands a command to the driver app that brings the device. */
export type Deliver = (
  driver: string,
  command: DriverCommand,
  actor: Actor,
) => Promise<void>;

export const deviceChanges = z.object({
  id: z.string().min(1).max(64),
  // None names it after its room again.
  name: z.string().trim().min(1).max(120).nullable().optional(),
  roomId: z.string().min(1).max(64).nullable().optional(),
});

export const commandRequest = z.object({
  device: z.string().min(1).max(64),
  capability: z.string().min(1).max(32),
  command: z.unknown(),
});

type CapabilityRow = typeof deviceCapabilities.$inferSelect;

// Firmware a driver has said nothing about yet but what the device runs.
const unknownFirmware: FirmwareInfo = {
  version: null,
  updatable: false,
  sleeps: false,
  state: null,
  progress: null,
  remainingSeconds: null,
  problem: null,
  checkedAt: null,
  startedAt: null,
  endedAt: null,
};

// Whether a report changes what a capability says, by its kind's history
// fields (CapabilityInfo.changedAt): its first report does.
function changedFields(
  capability: {
    kind: CapabilityKind;
    observed: Record<string, unknown> | null;
  },
  observed: Record<string, unknown>,
) {
  return (
    capability.observed === null ||
    historyFields[capability.kind].some(
      (field: string) => capability.observed![field] !== observed[field],
    )
  );
}

function invalid(what: string, error: z.ZodError) {
  return new Error(`${what}: ${z.prettifyError(error)}`);
}

export function createDevices(
  db: CoreDatabase,
  options: {
    gate: Gate;
    places: Pick<PlacesModule, "hasRoom" | "list">;
    activity: Activity;
    deliver: Deliver;
    // Which run of a driver app this is, which each start changes.
    driverRun?: (driver: string) => number | undefined;
    removeFromDriver?: RemoveFromDriver;
    // Called after a change has committed, so live clients can follow.
    onChange?: (change: DeviceChange) => void;
    // Called after a device's report has committed: it answered.
    onReport?: (id: string) => void;
    // Called before a command goes to a capability's driver, so a remote's
    // hold that has the light moving ends first (holds.ts); it answers
    // nothing while there is nothing to wait for.
    beforeCommand?: (
      device: string,
      capability: string,
    ) => Promise<void> | undefined;
    confirmMs?: number;
    now?: () => Date;
  },
) {
  const { gate, places, deliver } = options;
  const record = options.activity.for("devices");
  const now = options.now ?? (() => new Date());
  const confirmMs = options.confirmMs ?? defaultConfirmMs;
  const deviceLog = createDeviceLog({ activity: options.activity, confirmMs });
  const { rename, roomNames } = createNaming(db, places);
  const commands = createCommandTracking({
    confirmMs,
    now,
    read: capabilityRow,
    write: (device, capability, state, setBy) =>
      changing(device, () => writeSync(device, capability, state, setBy)),
  });

  function load(id: string): DeviceInfo | null {
    const device = db.select().from(devices).where(eq(devices.id, id)).get();
    return device
      ? deviceInfo(
          device,
          db
            .select()
            .from(deviceCapabilities)
            .where(eq(deviceCapabilities.deviceId, id))
            .all(),
        )
      : null;
  }

  function loadAll(): DeviceInfo[] {
    const byDevice = new Map<string, CapabilityRow[]>();
    for (const capability of db.select().from(deviceCapabilities).all()) {
      byDevice.set(capability.deviceId, [
        ...(byDevice.get(capability.deviceId) ?? []),
        capability,
      ]);
    }
    return db
      .select()
      .from(devices)
      .all()
      .map((device) => deviceInfo(device, byDevice.get(device.id) ?? []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function capabilityRow(deviceId: string, capabilityId: string) {
    return db
      .select()
      .from(deviceCapabilities)
      .where(
        and(
          eq(deviceCapabilities.deviceId, deviceId),
          eq(deviceCapabilities.id, capabilityId),
        ),
      )
      .get();
  }

  // Writes a capability's target, and who set it when that changes too.
  function writeSync(
    deviceId: string,
    capabilityId: string,
    state: Settled,
    setBy?: StoredSetBy | null,
  ) {
    if (state.desired) {
      const capability = capabilityRow(deviceId, capabilityId);
      if (
        capability &&
        !capabilityOf(capability.kind).supports(
          capability.features,
          state.desired,
        )
      ) {
        // A failed delivery can restore an older target after the driver
        // changed the capability's features. A desired state asks for the
        // same fields its command did, so the command's check applies.
        state = { desired: null, sync: "conflict" };
      }
    }
    db.update(deviceCapabilities)
      .set({
        desired: state.desired,
        sync: state.sync,
        awaiting: state.awaiting ?? null,
        ...(setBy === undefined ? {} : { setBy }),
        updatedAt: now(),
      })
      .where(
        and(
          eq(deviceCapabilities.deviceId, deviceId),
          eq(deviceCapabilities.id, capabilityId),
        ),
      )
      .run();
    return state;
  }

  // Runs a change, then tells live clients what it did to the device.
  function changing<T>(id: string, work: () => T): T {
    const before = load(id);
    const result = work();
    const after = load(id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      options.onChange?.({ id, before, after });
    }
    return result;
  }

  // Removing and repairing a device take turns (turns.ts).
  const turns = createTurns();
  const removal = createRemoval(db, {
    record,
    turns,
    removeFromDriver: options.removeFromDriver,
    nameOf: (id) => load(id)?.name ?? null,
    changing,
    forget: (id, capability) => commands.forget(id, capability),
  });
  const present = createPresence(db, {
    record,
    deviceLog,
    removing: removal.removing,
    changing,
    now,
  });

  // No command is on its way across a restart, so what was pending when
  // the core stopped is settled now.
  for (const capability of db
    .select()
    .from(deviceCapabilities)
    .where(eq(deviceCapabilities.sync, "pending"))
    .all()) {
    writeSync(capability.deviceId, capability.id, settle(capability));
  }

  function visible(id: string, capabilityId: string, view: View) {
    const device = load(id);
    const shown = device && viewOf(device, view);
    const capability = shown?.capabilities.find(
      (each) => each.id === capabilityId,
    );
    if (!shown || !capability) {
      throw new ActionCallError("not_found");
    }
    return { device: shown, capability };
  }

  // What the gate weighs for a capability's commands.
  function ruleFor(kind: CapabilityKind): Rule {
    return { tier: capabilityOf(kind).tier };
  }

  // A command that passed the gate: it asks for state, and goes to the
  // driver unless it has to wait for the light to turn on. The capability
  // then says who set it: the app whose code sent it, if any, and the actor
  // behind it. A command that fails leaves the last one standing, as it
  // leaves the last target.
  async function run(
    actor: Actor,
    app: string | null,
    who: Who,
    view: View,
    target: { device: DeviceInfo; capability: CapabilityInfo },
    command: unknown,
  ): Promise<CapabilityInfo> {
    const { device, capability } = target;
    const definition = capabilityOf(capability.kind);
    const parsed = definition.command.safeParse(command);
    if (
      !parsed.success ||
      !definition.supports(capability.features, parsed.data)
    ) {
      deviceLog.command(who, device.id, "refused", "invalid_request");
      throw new ActionCallError("invalid_request");
    }
    // Finish a hold before preparing or tracking its replacement. Otherwise
    // the move can overwrite who set the light, and its final report can
    // confirm a command that has not gone out yet.
    const ending = options.beforeCommand?.(device.id, capability.id);
    if (ending) await ending;
    const row = capabilityRow(device.id, capability.id);
    if (!row) throw new ActionCallError("not_found");
    const prepared = prepare(row, parsed.data as Record<string, unknown>);
    const setBy: StoredSetBy = {
      app,
      actor,
      asked: definition.desired(parsed.data) as Record<string, unknown>,
      at: now().toISOString(),
    };
    const sent = {
      capability: capability.id,
      kind: capability.kind,
      asked: setBy.asked,
      app,
    };
    const { driver, key } = db
      .select({ driver: devices.driver, key: devices.key })
      .from(devices)
      .where(eq(devices.id, device.id))
      .get()!;
    // Sending it again, if the device does not confirm it in time, goes the
    // same way, as the same actor (commands.ts), and only to the driver as it
    // ran when it first went: a driver that has restarted never gets it again,
    // since a light switched twice is worse than one someone switches again.
    const wentThrough = options.driverRun?.(driver);
    const send = async (command: Record<string, unknown>) => {
      if (options.driverRun?.(driver) !== wentThrough) {
        throw new ActionCallError("unavailable");
      }
      return deliver(
        driver,
        {
          key,
          device: device.id,
          capability: capability.id,
          kind: capability.kind,
          command,
        } as DriverCommand,
        actor,
      );
    };
    const delivery = commands.begin(
      device.id,
      capability.id,
      row,
      prepared,
      setBy,
      send,
    );
    if (prepared.send) {
      try {
        await send(prepared.send);
      } catch (error) {
        const failure =
          error instanceof ActionCallError
            ? error
            : new ActionCallError("app_failed");
        delivery.failed(failure.code);
        deviceLog.command(
          who,
          device.id,
          failure.status >= 500 ? "failed" : "refused",
          failure.code,
          sent,
        );
        throw failure;
      }
    }
    const entryId = deviceLog.command(who, device.id, "ok", undefined, sent);
    delivery.sent({
      unanswered: (reason, hasResent) =>
        deviceLog.unanswered(entryId, who, device.id, sent, {
          reason,
          hasResent,
        }),
      resent: () => deviceLog.resent(entryId),
    });
    return visible(device.id, capability.id, view).capability;
  }

  function admitted<T>(who: Who, deviceId: string, check: () => T): T {
    try {
      return check();
    } catch (error) {
      if (error instanceof ActionCallError) {
        deviceLog.command(who, deviceId, "refused", error.code);
      }
      throw error;
    }
  }

  return {
    list(view: View = {}): DeviceInfo[] {
      return loadAll().flatMap((device) => viewOf(device, view) ?? []);
    },

    get(id: string, view: View = {}): DeviceInfo | null {
      const device = load(id);
      return device && viewOf(device, view);
    },

    // A client's command: the gate admits the principal behind it.
    async commandFor(
      principal: Principal,
      input: unknown,
    ): Promise<CapabilityInfo> {
      const request = commandRequest.safeParse(input);
      if (!request.success) {
        throw new ActionCallError("invalid_request");
      }
      const view: View = {};
      const who = {
        personId: principal.person?.id,
        clientId: principal.client.id,
      };
      const target = admitted(who, request.data.device, () =>
        visible(request.data.device, request.data.capability, view),
      );
      const actor = admitted(who, target.device.id, () =>
        gate.admit(principal, ruleFor(target.capability.kind)),
      );
      return run(actor, null, who, view, target, request.data.command);
    },

    // An app's command (ctx.devices.command), for the actor behind the call,
    // or a workflow's own device step, which no app sent. The app host has
    // checked the app's own permission.
    async command(
      actor: Actor,
      input: DeviceCommand,
      view: View,
      app: string | null,
    ): Promise<CapabilityInfo> {
      const request = commandRequest.safeParse(input);
      if (!request.success) {
        throw new ActionCallError("invalid_request");
      }
      const { device, capability, command } = request.data;
      const who =
        actor.kind === "user"
          ? { personId: actor.id }
          : actor.kind === "client"
            ? { clientId: actor.id }
            : { actor: `${actor.kind}:${actor.id}` };
      const target = admitted(who, device, () =>
        visible(device, capability, view),
      );
      admitted(who, target.device.id, () =>
        gate.permit(actor, ruleFor(target.capability.kind)),
      );
      return run(actor, app, who, view, target, command);
    },

    // A driver brings one of its devices in, or updates it, by its own key.
    register(driver: string, input: unknown): { id: string } {
      const parsed = deviceRegistration.safeParse(input);
      if (!parsed.success) {
        throw invalid(
          `${driver} registered a device the core cannot take`,
          parsed.error,
        );
      }
      const registration = parsed.data;
      const existing = db
        .select({ id: devices.id, firmware: devices.firmware })
        .from(devices)
        .where(
          and(eq(devices.driver, driver), eq(devices.key, registration.key)),
        )
        .get();
      const id = existing?.id ?? randomUUID();
      changing(id, () =>
        db.transaction(() => {
          const at = now();
          const described = {
            driverName: registration.name,
            manufacturer: registration.manufacturer,
            model: registration.model,
            declaredType: registration.type,
            // What an update is doing outlives the driver saying again
            // what the device runs.
            firmware: registration.firmware && {
              ...(existing?.firmware ?? unknownFirmware),
              ...registration.firmware,
            },
            probe: registration.probe,
            // A device its driver registers is on its network.
            leftAt: null,
            updatedAt: at,
          };
          if (existing) {
            db.update(devices).set(described).where(eq(devices.id, id)).run();
          } else {
            db.insert(devices)
              .values({
                id,
                driver,
                key: registration.key,
                ...described,
                autoNamed: true,
                availability: "unknown",
                createdAt: at,
              })
              .run();
            record({ action: "device.register", outcome: "ok", subjectId: id });
          }
          writeCapabilities(db, id, registration.capabilities, {
            at,
            forget: (capability) => commands.forget(id, capability),
          });
          // What it is may have changed with its capabilities, or with
          // what its driver says it is.
          rename(id);
        }),
      );
      return { id };
    },

    // A driver reports what one of its own devices said, by its own key.
    report(driver: string, input: unknown) {
      const parsed = deviceReport.safeParse(input);
      if (!parsed.success) {
        throw invalid(
          `${driver} sent a report the core cannot take`,
          parsed.error,
        );
      }
      const { key, availability, states = {}, battery } = parsed.data;
      const device = db
        .select()
        .from(devices)
        .where(and(eq(devices.driver, driver), eq(devices.key, key)))
        .get();
      if (!device) {
        throw new ActionError("not_found", `${driver} has no device ${key}`);
      }
      const observations = Object.entries(states).map(
        ([capabilityId, state]) => {
          const capability = capabilityRow(device.id, capabilityId);
          if (!capability) {
            throw new ActionError(
              "not_found",
              `${driver}'s device ${key} has no capability ${capabilityId}`,
            );
          }
          const observed = capabilityOf(capability.kind).state.safeParse(state);
          if (!observed.success) {
            throw invalid(
              `${driver} reported a ${capability.kind} state the core cannot take`,
              observed.error,
            );
          }
          return {
            capability,
            observed: observed.data as Record<string, unknown>,
          };
        },
      );
      const answered =
        observations.length > 0 ||
        battery !== undefined ||
        availability === "online";
      changing(device.id, () =>
        db.transaction(() => {
          const at = now();
          for (const { capability, observed: reported } of observations) {
            const observed = observe(capability, reported);
            deviceLog.reported(
              device.id,
              capability,
              observed,
              at,
              commands.sentAt(device.id, capability.id),
            );
            const settled = reconcile(capability, observed);
            db.update(deviceCapabilities)
              .set({
                observed,
                ...settled,
                awaiting: settled.awaiting ?? null,
                ...(changedFields(capability, observed) && { changedAt: at }),
                updatedAt: at,
              })
              .where(
                and(
                  eq(deviceCapabilities.deviceId, device.id),
                  eq(deviceCapabilities.id, capability.id),
                ),
              )
              .run();
            commands.reported(device.id, capability.id, capability, observed);
          }
          // One its network no longer has stays offline until a list has it
          // again or its driver registers it, whatever a late report says.
          const left = device.leftAt !== null;
          if (battery !== undefined) deviceLog.battery(device, battery, at);
          db.update(devices)
            .set({
              availability: left
                ? "offline"
                : (availability ?? device.availability),
              lastSeenAt: answered ? at : device.lastSeenAt,
              battery: battery ?? device.battery,
            })
            .where(eq(devices.id, device.id))
            .run();
          if (availability && !left) {
            deviceLog.availability(device, availability);
          }
        }),
      );
      if (answered) options.onReport?.(device.id);
    },

    // A driver says which of its devices its network still has (presence.ts).
    present,

    // A driver going down makes its devices unreachable, not unpaired. Their
    // reports can bring them online again without registering them anew.
    markDriverOffline(driver: string) {
      for (const device of db
        .select()
        .from(devices)
        .where(eq(devices.driver, driver))
        .all()) {
        if (device.availability === "offline") continue;
        changing(device.id, () =>
          db.transaction(() => {
            db.update(devices)
              .set({ availability: "offline" })
              .where(eq(devices.id, device.id))
              .run();
            deviceLog.availability(device, "offline");
          }),
        );
      }
    },

    // What the household decides about a device: its name and its room.
    update(by: ChangedBy, input: unknown): DeviceInfo {
      const parsed = deviceChanges.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const { id, name, ...changes } = parsed.data;
      // A name of the household's own stays; without one, the device is
      // named after its room.
      const naming =
        name === undefined
          ? {}
          : name === null
            ? { name: null, autoNamed: true }
            : { name, autoNamed: false };
      changing(id, () =>
        db.transaction(() => {
          if (changes.roomId && !places.hasRoom(changes.roomId)) {
            throw new ActionCallError("not_found");
          }
          const updated = db
            .update(devices)
            .set({ ...changes, ...naming, updatedAt: now() })
            .where(eq(devices.id, id))
            .returning({ id: devices.id })
            .get();
          if (!updated) {
            throw new ActionCallError("not_found");
          }
          rename(id);
          // What changed: its name, which removed entries are named by, or
          // its room.
          record({
            action: "device.update",
            outcome: "ok",
            personId: by.personId,
            clientId: by.clientId,
            subjectId: id,
            detail: {
              ...(name === undefined ? {} : { name: load(id)!.name }),
              ...("roomId" in changes
                ? { roomId: changes.roomId ?? null }
                : {}),
            },
          });
        }),
      );
      return load(id)!;
    },

    // Names every auto-named device again after its room, as when a room
    // is renamed or removed. The oldest go first, so they keep the lower
    // numbers.
    renameAll() {
      const rooms = roomNames();
      for (const { id } of db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.autoNamed, true))
        .orderBy(asc(devices.createdAt))
        .all()) {
        changing(id, () => rename(id, rooms));
      }
    },

    // Runs a change of a device's own row, as firmware.ts makes, then
    // tells live clients what it did.
    changing,

    // A hold's move on its way to a light (holds.ts): it is newer than any
    // command waiting for the light, its own wake included, so none of
    // those goes again.
    moving(deviceId: string, capabilityId: string) {
      commands.moving(deviceId, capabilityId);
    },

    // A light a remote's hold set moving (holds.ts): a move asks for no
    // state, so its target stays as it was, and it says who set it last.
    moved(deviceId: string, capabilityId: string, setBy: StoredSetBy) {
      commands.moved(deviceId, capabilityId, setBy);
      changing(deviceId, () =>
        db
          .update(deviceCapabilities)
          .set({ setBy, updatedAt: now() })
          .where(
            and(
              eq(deviceCapabilities.deviceId, deviceId),
              eq(deviceCapabilities.id, capabilityId),
            ),
          )
          .run(),
      );
    },

    // A device as the core keeps it, with its driver and key.
    row(id: string) {
      return db.select().from(devices).where(eq(devices.id, id)).get() ?? null;
    },

    // The core's id for a driver's device, if it has it.
    idFor(driver: string, key: string): string | null {
      return (
        db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.driver, driver), eq(devices.key, key)))
          .get()?.id ?? null
      );
    },

    // Removes a device (removal.ts).
    remove: removal.remove,

    // Removing and repairing a device, which take turns.
    turns,

    // The core is stopping: nothing goes to a device again from now on.
    closing() {
      commands.closing();
    },

    close() {
      commands.close();
    },
  };
}

export type Devices = ReturnType<typeof createDevices>;
