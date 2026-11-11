import {
  dashboardBackgrounds,
  type DashboardBackground,
  type DashboardInfo,
  type DashboardKind,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import {
  asc,
  count,
  desc,
  eq,
  inArray,
  max,
  notInArray,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { RecordActivity } from "../activity/activity.js";
import type { Rule } from "../app-host/gate.js";
import type { CoreDatabase } from "../database.js";
import { deviceCapabilities, devices } from "../devices/schema.js";
import { dashboards, homeDevices } from "./schema.js";

// The Dashboards module: the home's dashboards, each with its name, its
// background and its place among the others, and the devices on Home. They
// belong to the household, not to a person or a client, so every client
// reads and changes them, shared ones included. A home always opens on Home:
// the first start seeds it, a core from before it made its first dashboard
// Home, and it cannot be removed. A light is on Home from when it joins the
// home, last in its room; anything else once someone adds it, and what
// someone takes off stays off.

// Reading them is a read, and changing them a write, removing one included:
// the client's confirmation is the safeguard.
export const dashboardRules = {
  read: { tier: "read" },
  change: { tier: "write" },
} as const satisfies Record<string, Rule>;

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(60);

export const newDashboard = z.object({
  name,
  background: z.enum(dashboardBackgrounds).default("mocha"),
});
export const dashboardChanges = z.object({ id, name });
export const removal = z.object({ id });
export const homeDevice = z.object({ device: id });
// A home has far fewer devices than this.
export const homeOrder = z.object({
  devices: z
    .array(id)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, "Each device once"),
});

// What a home starts with.
const firstDashboard = {
  name: "Home",
  background: "mocha",
  kind: "home",
} as const;

// Far more than a sidebar lists comfortably; it keeps any one client from
// filling the database.
export const maxDashboards = 50;

// Reordering Home in one go, as in its edit mode, makes one entry.
const orderJoinsMs = 10 * 60_000;

// The client behind a change, and its person on a personal client.
export type DashboardChangedBy = { personId?: string; clientId: string };

export class DashboardsError extends Error {
  constructor(
    // home_dashboard: Home cannot be removed. too_many_dashboards: it has
    // maxDashboards already. not_on_home: an order names a device Home does
    // not have.
    readonly code:
      "not_found" | "home_dashboard" | "too_many_dashboards" | "not_on_home",
    message: string,
  ) {
    super(message);
  }
}

const info = {
  id: dashboards.id,
  name: dashboards.name,
  background: dashboards.background,
  kind: dashboards.kind,
};

const hasLight = (device: DeviceInfo | null) =>
  device?.capabilities.some((capability) => capability.kind === "light") ??
  false;

export function createDashboards(
  db: CoreDatabase,
  options: {
    record: RecordActivity;
    // Called after a change has committed, so live clients can follow.
    onChange?: (dashboards: DashboardInfo[]) => void;
    now?: () => Date;
  },
) {
  const { record } = options;
  const now = options.now ?? (() => new Date());

  // After every other device on Home.
  function nextPosition() {
    const { last } = db
      .select({ last: max(homeDevices.position) })
      .from(homeDevices)
      .get()!;
    return (last ?? -1) + 1;
  }

  // A home without Home gets it: on the first start of its database, or of
  // a core from before Home, whose first dashboard becomes it with the
  // home's lights on it by name, so nothing it showed goes. A background the
  // shell no longer draws becomes the first: burgundy, the only one until
  // then, gave way to mocha (2026-10-31).
  db.transaction(() => {
    db.update(dashboards)
      .set({ background: firstDashboard.background })
      .where(notInArray(dashboards.background, [...dashboardBackgrounds]))
      .run();
    if (
      db
        .select({ id: dashboards.id })
        .from(dashboards)
        .where(eq(dashboards.kind, "home"))
        .get()
    ) {
      return;
    }
    const first = db
      .select({ id: dashboards.id })
      .from(dashboards)
      .orderBy(asc(dashboards.position), asc(dashboards.id))
      .limit(1)
      .get();
    if (!first) {
      const at = now();
      db.insert(dashboards)
        .values({
          id: randomUUID(),
          ...firstDashboard,
          position: 0,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      return;
    }
    db.update(dashboards)
      .set({ kind: "home" })
      .where(eq(dashboards.id, first.id))
      .run();
    const lights = db
      .select({ id: devices.id })
      .from(devices)
      .where(
        inArray(
          devices.id,
          db
            .select({ id: deviceCapabilities.deviceId })
            .from(deviceCapabilities)
            .where(eq(deviceCapabilities.kind, "light")),
        ),
      )
      .orderBy(
        sql`coalesce(${devices.name}, ${devices.driverName})`,
        asc(devices.id),
      )
      .all();
    const start = nextPosition();
    lights.forEach((light, at) =>
      db
        .insert(homeDevices)
        .values({ deviceId: light.id, position: start + at })
        .onConflictDoNothing()
        .run(),
    );
  });

  function onHome(): string[] {
    return db
      .select({ id: homeDevices.deviceId })
      .from(homeDevices)
      .orderBy(asc(homeDevices.position), asc(homeDevices.deviceId))
      .all()
      .map((row) => row.id);
  }

  function infoOf(
    row: {
      id: string;
      name: string;
      background: DashboardBackground;
      kind: DashboardKind;
    },
    devicesOnHome?: string[],
  ): DashboardInfo {
    const { kind, ...rest } = row;
    return kind === "home"
      ? { ...rest, kind, devices: devicesOnHome ?? onHome() }
      : { ...rest, kind };
  }

  function list(): DashboardInfo[] {
    const devicesOnHome = onHome();
    return db
      .select(info)
      .from(dashboards)
      .orderBy(
        desc(eq(dashboards.kind, "home")),
        asc(dashboards.position),
        asc(dashboards.id),
      )
      .all()
      .map((row) => infoOf(row, devicesOnHome));
  }

  function home(): DashboardInfo {
    return list().find((dashboard) => dashboard.kind === "home")!;
  }

  // Runs a change and its activity entry in one transaction, then tells
  // live clients.
  function change<T>(
    by: DashboardChangedBy,
    action: string,
    work: () => {
      subjectId: string;
      result: T;
      detail?: Record<string, unknown>;
    },
  ): T {
    const result = db.transaction(() => {
      const done = work();
      record(
        {
          action,
          outcome: "ok",
          personId: by.personId,
          clientId: by.clientId,
          subjectId: done.subjectId,
          detail: done.detail,
        },
        action === "dashboard.order"
          ? {
              withinMs: orderJoinsMs,
              matches: (previous) => previous.action === action,
            }
          : undefined,
      );
      return done.result;
    });
    options.onChange?.(list());
    return result;
  }

  function notFound(dashboardId: string) {
    return new DashboardsError("not_found", `No dashboard ${dashboardId}`);
  }

  // Home's id and name now, for an entry about what is on it.
  function homeRow() {
    return db
      .select({ id: dashboards.id, name: dashboards.name })
      .from(dashboards)
      .where(eq(dashboards.kind, "home"))
      .get()!;
  }

  function isOnHome(deviceId: string) {
    return !!db
      .select({ id: homeDevices.deviceId })
      .from(homeDevices)
      .where(eq(homeDevices.deviceId, deviceId))
      .get();
  }

  return {
    list,

    // After the others.
    add(
      by: DashboardChangedBy,
      input: z.input<typeof newDashboard>,
    ): DashboardInfo {
      const values = newDashboard.parse(input);
      return change(by, "dashboard.add", () => {
        const { total, last } = db
          .select({ total: count(), last: max(dashboards.position) })
          .from(dashboards)
          .get()!;
        if (total >= maxDashboards) {
          throw new DashboardsError(
            "too_many_dashboards",
            `A home has at most ${maxDashboards} dashboards`,
          );
        }
        const at = now();
        const dashboard = {
          id: randomUUID(),
          ...values,
          kind: "custom" as const,
        };
        db.insert(dashboards)
          .values({
            ...dashboard,
            position: (last ?? -1) + 1,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        return { subjectId: dashboard.id, result: dashboard };
      });
    },

    update(
      by: DashboardChangedBy,
      input: z.input<typeof dashboardChanges>,
    ): DashboardInfo {
      const { id: dashboardId, ...changes } = dashboardChanges.parse(input);
      return change(by, "dashboard.update", () => {
        const updated = db
          .update(dashboards)
          .set({ ...changes, updatedAt: now() })
          .where(eq(dashboards.id, dashboardId))
          .returning(info)
          .get();
        if (!updated) {
          throw notFound(dashboardId);
        }
        return { subjectId: dashboardId, result: infoOf(updated) };
      });
    },

    remove(by: DashboardChangedBy, input: z.input<typeof removal>) {
      const { id: dashboardId } = removal.parse(input);
      change(by, "dashboard.remove", () => {
        const found = db
          .select({ kind: dashboards.kind })
          .from(dashboards)
          .where(eq(dashboards.id, dashboardId))
          .get();
        if (!found) {
          throw notFound(dashboardId);
        }
        if (found.kind === "home") {
          throw new DashboardsError(
            "home_dashboard",
            "A home always keeps Home",
          );
        }
        db.delete(dashboards).where(eq(dashboards.id, dashboardId)).run();
        return { subjectId: dashboardId, result: undefined };
      });
    },

    // Last in its room; one on Home already stays where it is, and nothing
    // is recorded.
    addToHome(
      by: DashboardChangedBy,
      input: z.input<typeof homeDevice>,
    ): DashboardInfo {
      const { device } = homeDevice.parse(input);
      if (
        !db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.id, device))
          .get()
      ) {
        throw new DashboardsError("not_found", `No device ${device}`);
      }
      if (isOnHome(device)) return home();
      return change(by, "device.home.add", () => {
        db.insert(homeDevices)
          .values({ deviceId: device, position: nextPosition() })
          .run();
        return {
          subjectId: device,
          detail: { dashboard: homeRow().name },
          result: home(),
        };
      });
    },

    // One that is not on Home changes nothing, and nothing is recorded.
    removeFromHome(
      by: DashboardChangedBy,
      input: z.input<typeof homeDevice>,
    ): DashboardInfo {
      const { device } = homeDevice.parse(input);
      if (!isOnHome(device)) return home();
      return change(by, "device.home.remove", () => {
        db.delete(homeDevices).where(eq(homeDevices.deviceId, device)).run();
        return {
          subjectId: device,
          detail: { dashboard: homeRow().name },
          result: home(),
        };
      });
    },

    // The devices take the positions they hold now, in their new order.
    orderHome(
      by: DashboardChangedBy,
      input: z.input<typeof homeOrder>,
    ): DashboardInfo {
      const { devices: order } = homeOrder.parse(input);
      return change(by, "dashboard.order", () => {
        const held = db
          .select({ id: homeDevices.deviceId, position: homeDevices.position })
          .from(homeDevices)
          .where(inArray(homeDevices.deviceId, order))
          .orderBy(asc(homeDevices.position), asc(homeDevices.deviceId))
          .all();
        if (held.length !== order.length) {
          throw new DashboardsError(
            "not_on_home",
            "Each device to order must be on Home",
          );
        }
        order.forEach((deviceId, at) =>
          db
            .update(homeDevices)
            .set({ position: held[at]!.position })
            .where(eq(homeDevices.deviceId, deviceId))
            .run(),
        );
        return { subjectId: homeRow().id, result: home() };
      });
    },

    // Follows the home's devices once a change has committed: a device that
    // gains a light, as one does when it joins, goes on Home, and one on
    // Home that moves to another room goes last there. Neither is recorded:
    // the device's own entries say what happened.
    deviceChanged(change: {
      id: string;
      before: DeviceInfo | null;
      after: DeviceInfo | null;
    }) {
      const { id: deviceId, before, after } = change;
      if (!after) {
        // The foreign key has already removed its Home membership.
        options.onChange?.(list());
        return;
      }
      let changed = false;
      if (hasLight(after) && !hasLight(before)) {
        changed =
          db
            .insert(homeDevices)
            .values({ deviceId, position: nextPosition() })
            .onConflictDoNothing()
            .run().changes > 0;
      } else if (before && before.roomId !== after.roomId) {
        changed =
          db
            .update(homeDevices)
            .set({ position: nextPosition() })
            .where(eq(homeDevices.deviceId, deviceId))
            .run().changes > 0;
      }
      if (changed) options.onChange?.(list());
    },
  };
}

export type Dashboards = ReturnType<typeof createDashboards>;
