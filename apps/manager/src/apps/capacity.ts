import { randomUUID } from "node:crypto";
import { totalmem } from "node:os";
import { join } from "node:path";

import {
  serviceMemoryMb,
  withServiceDependencies,
} from "../services/registry.js";
import { readJson, writeJson } from "../state.js";
import type { AppImages } from "./images.js";
import { AppRefusal } from "./refusal.js";

// What the manager has promised of the host's memory and disk, which every
// add and container start is checked against, so the add sheet and a start
// agree. Memory: each app container it holds, running or stopped (one stopped
// for its update's copy or after a crash still needs its room back), at its
// limit, unless the core turned the app off; each service it runs, at its
// configured size; and what's reserved. Disk: what each data image may still
// grow to, the room kept for updates (images.ts), and what's reserved.
// A reservation holds an add's memory and data image until its container
// starts, and its services until the manager is asked to run them. Any claim
// expires after 10 minutes.
// Reservations live in memory only and are lost on a manager restart.

const mebibyte = 1024 * 1024;
const reservedForMs = 10 * 60_000;

/** What the host keeps for itself, the core and Docker, beside the apps. */
const keptForTheHost = (total: number) =>
  Math.max(1024 * mebibyte, Math.floor(total / 4));

/** An app container the manager holds, by its app and memory limit. */
export type HeldApp = { app: string; memoryMb: number; isRunning: boolean };

/** What an add needs, as the core asks for it. */
type ReservationRequest = {
  memoryMb: number;
  dataMb: number;
  // The services it needs, by name.
  services: string[];
};

type Reservation = ReservationRequest & {
  id: string;
  app: string;
  until: number;
  isWaitingForServices?: true;
};

export function createCapacity(options: {
  dataDir: string;
  totalMemory?: () => number;
  // The services it keeps running, with their dependencies.
  services?: () => Iterable<string>;
  servicesWantedBy?: (app: string) => ReadonlySet<string>;
  // Containers that can still be running while their services are released.
  heldServices?: () => Iterable<string>;
  now?: () => number;
}) {
  const totalMemory = options.totalMemory ?? totalmem;
  const now = options.now ?? Date.now;
  const offPath = join(options.dataDir, "apps-off.json");
  let reservations: Reservation[] = [];
  let off = new Set<string>();
  let loaded: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  // Reservations, container changes and image growth share this turn.
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }

  const load = () =>
    (loaded ??= readJson<{ apps: string[] }>(offPath)
      .then((state) => {
        off = new Set(state?.apps ?? []);
      })
      .catch((error: unknown) => {
        loaded = undefined;
        throw error;
      }));

  async function setOff(app: string, isOff: boolean) {
    await load();
    if (off.has(app) === isOff) return;
    const next = new Set(off);
    if (isOff) next.add(app);
    else next.delete(app);
    await writeJson(offPath, { apps: [...next].sort() });
    off = next;
  }

  // Those still open, of other apps than this one.
  function othersOpen(except?: string) {
    const at = now();
    reservations = reservations.filter(
      (each) =>
        each.until > at &&
        (!each.isWaitingForServices || stillWaitingForServices(each)),
    );
    return reservations.filter((each) => each.app !== except);
  }

  function stillWaitingForServices(reservation: Reservation) {
    const wanted = options.servicesWantedBy?.(reservation.app);
    return reservation.services.some((name) => !wanted?.has(name));
  }

  async function memory(
    held: readonly HeldApp[],
    app?: string,
    services: readonly string[] = [],
  ) {
    await load();
    const open = othersOpen(app);
    const byApp = new Map(open.map((each) => [each.app, each.memoryMb]));
    for (const each of held) {
      if (each.app === app || (!each.isRunning && off.has(each.app))) continue;
      byApp.set(
        each.app,
        Math.max(byApp.get(each.app) ?? 0, each.memoryMb || 0),
      );
    }
    const counted = new Set([
      ...(options.services?.() ?? []),
      ...(options.heldServices?.() ?? []),
      ...open.flatMap((each) => each.services),
    ]);
    const total = totalMemory();
    let free = (total - keptForTheHost(total)) / mebibyte;
    for (const mb of byApp.values()) free -= mb;
    const totalMb = total / mebibyte;
    for (const name of counted) free -= serviceMemoryMb(name, totalMb);
    let servicesMb = 0;
    for (const name of withServiceDependencies(services)) {
      if (!counted.has(name)) servicesMb += serviceMemoryMb(name, totalMb);
    }
    return { memoryFreeMb: Math.max(0, Math.floor(free)), servicesMb };
  }

  /** The memory left overall, in MB. */
  async function freeMb(held: readonly HeldApp[]) {
    return (await memory(held)).memoryFreeMb;
  }

  // An image it has already, as one kept from its removal, is used as it
  // is: its start makes none and grows none.
  function dataNeededMb(requestedMb: number, sizeMb: number) {
    return sizeMb > 0 ? 0 : requestedMb;
  }

  async function check(
    app: string,
    request: ReservationRequest,
    held: readonly HeldApp[],
    disk: Awaited<ReturnType<AppImages["available"]>>,
  ) {
    const { memoryFreeMb, servicesMb } = await memory(
      held,
      app,
      request.services,
    );
    return {
      memoryNeedsMb: request.memoryMb + servicesMb,
      memoryFreeMb,
      dataNeedsMb: dataNeededMb(request.dataMb, disk.sizeMb(app)),
      dataFreeBytes: disk.room(app),
    };
  }

  function assertMemory(app: string, needs: number, free: number) {
    if (needs > free) {
      throw new AppRefusal(
        `${app} needs ${needs} MB, and only ${free} MB are left beside the others`,
        409,
      );
    }
  }

  function cancel(app: string, id?: string) {
    reservations = reservations.filter(
      (each) => each.app !== app || (id !== undefined && each.id !== id),
    );
  }

  // The app no longer needs its own claim. A service request can arrive later.
  function releaseAppClaim(app: string) {
    const reservation = othersOpen().find((each) => each.app === app);
    if (!reservation) return;
    reservation.memoryMb = 0;
    reservation.dataMb = 0;
    reservation.isWaitingForServices = true;
    othersOpen();
  }

  return {
    inTurn,
    freeMb,
    check,
    cancel,

    /** The data reserved by apps other than this one, in bytes. */
    reservedData(sizeMb: (app: string) => number, except?: string) {
      return othersOpen(except).reduce(
        (sum, each) =>
          sum + dataNeededMb(each.dataMb, sizeMb(each.app)) * mebibyte,
        0,
      );
    },

    /** Refuses a start the room left can't hold beside the others. */
    async assertFits(app: string, memoryMb: number, held: readonly HeldApp[]) {
      const services = othersOpen().find((each) => each.app === app)?.services;
      const { memoryFreeMb, servicesMb } = await memory(held, app, services);
      assertMemory(app, memoryMb + servicesMb, memoryFreeMb);
    },

    /**
     * Holds what an add needs, or refuses it with what's short. The caller
     * reads the containers and disk and reserves in the same turn.
     */
    async reserve(
      app: string,
      request: ReservationRequest,
      held: readonly HeldApp[],
      disk: Awaited<ReturnType<AppImages["available"]>>,
    ) {
      const need = await check(app, request, held, disk);
      assertMemory(app, need.memoryNeedsMb, need.memoryFreeMb);
      const data = need.dataFreeBytes;
      if (data !== null && need.dataNeedsMb * mebibyte > data) {
        throw new AppRefusal(
          `${app} needs ${need.dataNeedsMb} MB for its data, and only ${Math.floor(data / mebibyte)} MB can be spared`,
          409,
        );
      }
      // One reservation per app: asking again replaces it.
      const reservation = {
        ...request,
        services: [...withServiceDependencies(request.services)],
        id: randomUUID(),
        app,
        until: now() + reservedForMs,
      };
      reservations = [...othersOpen(app), reservation];
      return {
        id: reservation.id,
        until: new Date(reservation.until).toISOString(),
      };
    },

    /** Its container took over the app's claim. */
    started: releaseAppClaim,

    /** Clears the off marker before Docker can start the container. */
    turningOn: (app: string) => setOff(app, false),

    /** The core turned it off: it gives its room back until it starts. */
    async turnedOff(app: string) {
      await setOff(app, true);
      releaseAppClaim(app);
    },

    /** Its container went, as on removal. */
    async gone(app: string) {
      cancel(app);
      await setOff(app, false);
    },
  };
}

export type Capacity = ReturnType<typeof createCapacity>;
