import { randomUUID } from "node:crypto";
import { totalmem } from "node:os";
import { join } from "node:path";

import { readJson, writeJson } from "../state.js";
import { AppRefusal } from "./refusal.js";

// What the manager has promised of the host's memory and disk, which every
// add and container start is checked against, so the add sheet and a start
// agree. Memory: each app container it holds, running or stopped (one stopped
// for its update's copy or after a crash still needs its room back), at its
// limit, unless the core turned the app off; each service it runs, at a fixed
// size; and what's reserved. Disk: what each data image may still grow to, the
// room kept for updates (images.ts), and what's reserved. A reservation holds
// an add's memory, its services and its data image until its container
// starts, or for 10 minutes, so a core that stopped part way can't hold it
// for ever. Reservations live in memory only: a manager that restarts has
// nothing half done to hold room for.

const mebibyte = 1024 * 1024;
const reservedForMs = 10 * 60_000;

/** What the host keeps for itself, the core and Docker, beside the apps. */
export const keptForTheHost = (total: number) =>
  Math.max(1024 * mebibyte, Math.floor(total / 4));

/** An app container the manager holds, by its app and memory limit. */
export type HeldApp = { app: string; memoryMb: number };

/** What an add needs, as the core asks for it. */
export type ReservationRequest = {
  memoryMb: number;
  dataMb: number;
  // The services it needs, by name.
  services: string[];
};

type Reservation = ReservationRequest & {
  id: string;
  app: string;
  until: number;
};

export function createCapacity(options: {
  dataDir: string;
  totalMemory?: () => number;
  // The services it runs now, by name, and what each counts for.
  services: () => readonly string[];
  serviceMemoryMb: (name: string) => number;
  now?: () => number;
}) {
  const totalMemory = options.totalMemory ?? totalmem;
  const now = options.now ?? Date.now;
  const offPath = join(options.dataDir, "apps-off.json");
  let reservations: Reservation[] = [];
  let off = new Set<string>();
  let loaded: Promise<void> | undefined;
  let saving: Promise<unknown> = Promise.resolve();

  const load = () =>
    (loaded ??= readJson<{ apps: string[] }>(offPath).then((state) => {
      off = new Set(state?.apps ?? []);
    }));

  async function setOff(app: string, isOff: boolean) {
    await load();
    if (off.has(app) === isOff) return;
    if (isOff) off.add(app);
    else off.delete(app);
    const apps = [...off].sort();
    const next = saving.then(() => writeJson(offPath, { apps }));
    saving = next.catch(() => undefined);
    await next;
  }

  // Those still open, of other apps than this one.
  function othersOpen(except?: string) {
    const at = now();
    reservations = reservations.filter((each) => each.until > at);
    return reservations.filter((each) => each.app !== except);
  }

  /** The memory apps may take beside the host's, in MB. */
  const roomMb = () => {
    const total = totalMemory();
    return (total - keptForTheHost(total)) / mebibyte;
  };

  // The services that count: those running, and those reserved for an add.
  function servicesCounted(except?: string) {
    return new Set([
      ...options.services(),
      ...othersOpen(except).flatMap((each) => each.services),
    ]);
  }

  /** What's taken of the apps' room by all but this app, in MB. */
  async function takenMb(held: readonly HeldApp[], except?: string) {
    await load();
    const apps = held
      .filter((each) => each.app !== except && !off.has(each.app))
      .reduce((sum, each) => sum + (each.memoryMb || 0), 0);
    const services = [...servicesCounted(except)].reduce(
      (sum, name) => sum + options.serviceMemoryMb(name),
      0,
    );
    const reserved = othersOpen(except).reduce(
      (sum, each) => sum + each.memoryMb,
      0,
    );
    return apps + services + reserved;
  }

  /** The memory left for this app, in MB. */
  async function freeMb(held: readonly HeldApp[], except?: string) {
    return Math.max(0, Math.floor(roomMb() - (await takenMb(held, except))));
  }

  // What its services add that nothing counts yet, in MB.
  function servicesNeedMb(app: string, services: readonly string[]) {
    const counted = servicesCounted(app);
    return services
      .filter((name) => !counted.has(name))
      .reduce((sum, name) => sum + options.serviceMemoryMb(name), 0);
  }

  return {
    freeMb,

    /** The data reserved by apps other than this one, in bytes. */
    reservedData(except?: string) {
      return othersOpen(except).reduce(
        (sum, each) => sum + each.dataMb * mebibyte,
        0,
      );
    },

    /** Refuses a start the room left can't hold beside the others. */
    async assertFits(app: string, memoryMb: number, held: readonly HeldApp[]) {
      const free = await freeMb(held, app);
      if (memoryMb > free) {
        throw new AppRefusal(
          `${app} needs ${memoryMb} MB, and only ${free} MB are left beside the others`,
          409,
        );
      }
    },

    /**
     * Holds what an add needs, or refuses it with what's short. Data is
     * checked by `dataFree`, what's left of the disk for this app, with
     * what its image already has (one kept from its removal) left out.
     */
    async reserve(
      app: string,
      request: ReservationRequest,
      held: readonly HeldApp[],
      dataFree: (app: string) => Promise<number | null>,
    ) {
      const memoryMb = request.memoryMb + servicesNeedMb(app, request.services);
      const free = await freeMb(held, app);
      if (memoryMb > free) {
        throw new AppRefusal(
          `${app} needs ${memoryMb} MB, and only ${free} MB are left beside the others`,
          409,
        );
      }
      const data = await dataFree(app);
      if (data !== null && request.dataMb * mebibyte > data) {
        throw new AppRefusal(
          `${app} needs ${request.dataMb} MB for its data, and only ${Math.max(0, Math.floor(data / mebibyte))} MB can be spared`,
          409,
        );
      }
      // One reservation per app: asking again replaces it.
      reservations = [
        ...othersOpen(app),
        {
          ...request,
          id: randomUUID(),
          app,
          until: now() + reservedForMs,
        },
      ];
      const [reservation] = reservations.slice(-1);
      return {
        id: reservation!.id,
        until: new Date(reservation!.until).toISOString(),
      };
    },

    /** Its container started: what it reserved is its container's now. */
    async started(app: string) {
      reservations = reservations.filter((each) => each.app !== app);
      await setOff(app, false);
    },

    /** The core turned it off: it gives its room back until it starts. */
    turnedOff: (app: string) => setOff(app, true),

    /** Its container went, as on removal. */
    async gone(app: string) {
      reservations = reservations.filter((each) => each.app !== app);
      await setOff(app, false);
    },
  };
}

export type Capacity = ReturnType<typeof createCapacity>;
