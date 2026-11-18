import { ManagerRefusal, type ManagerClient } from "../manager.js";
import type { AppGrants } from "./grants.js";
import type { ApartPackage } from "./loader.js";
import { declaredServices, servicePermission } from "./services.js";

// An update that needs more memory than is left beside the other apps waits
// for room, the app staying on its version (waiting.ts), and starts by itself
// once there's room, as when someone turns off an app they don't use or
// removes one: the core tries each such update again every minute, as a step
// of starting, until it stops.

const retryEveryMs = 60_000;

type UpdateRoom =
  | { kind: "held"; release: () => Promise<void> }
  | { kind: "short"; moreMemoryMb: number };

/** Asks the manager to hold room, or confirms how much memory is short. */
export function updateRoom(options: {
  manager: Pick<ManagerClient, "capabilities"> &
    Partial<
      Pick<
        ManagerClient,
        "reserveForApp" | "appCapacity" | "releaseAppReservation"
      >
    >;
  grants: Pick<AppGrants, "of">;
  log: (message: string) => void;
}) {
  const { manager } = options;
  return async (pkg: ApartPackage): Promise<UpdateRoom | undefined> => {
    if (!manager.capabilities().reserves || !manager.reserveForApp) return;
    const manifest = pkg.apart.manifest;
    const { id, runtime } = manifest;
    const granted = options.grants.of(manifest);
    const need = {
      memoryMb: runtime.memory,
      dataMb: runtime.data,
      services: declaredServices(manifest).filter((name) =>
        granted.includes(servicePermission(name)),
      ),
    };
    try {
      const reservation = await manager.reserveForApp(id, need);
      return {
        kind: "held",
        async release() {
          try {
            await manager.releaseAppReservation?.(id, reservation.id);
          } catch (error) {
            options.log(
              `apps: ${id}'s reservation wasn't released (${String(error)})`,
            );
          }
        },
      };
    } catch (error) {
      if (!(error instanceof ManagerRefusal) || error.status !== 409) return;
    }
    const counted = await manager
      .appCapacity?.([{ app: id, ...need }])
      .catch(() => null);
    const room = counted?.[id];
    if (!room) return;
    const moreMemoryMb = Math.ceil(room.memoryNeedsMb - room.memoryFreeMb);
    if (moreMemoryMb > 0) return { kind: "short", moreMemoryMb };
  };
}

export function createRoomWaits(options: {
  // Tries each update that waits for room again.
  retry: (signal: AbortSignal) => Promise<void>;
  log: (message: string) => void;
}) {
  const stopping = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let trying: Promise<void> | undefined;

  // One try at a time: the manager may take a while to answer.
  function tryAgain() {
    if (stopping.signal.aborted || trying) return;
    trying = options
      .retry(stopping.signal)
      .catch((error: unknown) => {
        options.log(
          `apps: updates waiting for room weren't tried (${String(error)})`,
        );
      })
      .finally(() => {
        trying = undefined;
      });
  }

  function interrupt() {
    stopping.abort();
    clearInterval(timer);
  }

  return {
    start() {
      if (stopping.signal.aborted || timer) return;
      timer = setInterval(tryAgain, retryEveryMs);
      timer.unref();
    },

    interrupt,

    async close() {
      interrupt();
      await trying;
    },
  };
}
