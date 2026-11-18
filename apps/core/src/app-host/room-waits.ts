import { ManagerRefusal, type ManagerClient } from "../manager.js";
import { needOf } from "./fit.js";
import type { AppGrants } from "./grants.js";
import type { ApartPackage } from "./loader.js";

// An update that needs more memory than is left beside the other apps waits
// for room, the app staying on its version (waiting.ts), and starts by itself
// once there's room, as when someone turns off an app they don't use or
// removes one: the core tries each such update again every minute, as a step
// of starting, until it stops.

const everyMs = 60_000;

/**
 * How much more memory a version needs than is left, in MB, having held it
 * in the manager when there's room: undefined when it fits, when the manager
 * keeps no count or can't answer, or when only its data is short, as its start
 * still checks.
 */
export function updateRoom(options: {
  manager: Pick<ManagerClient, "capabilities"> &
    Partial<Pick<ManagerClient, "reserveForApp" | "appCapacity">>;
  grants: Pick<AppGrants, "answers">;
}) {
  const { manager } = options;
  return async (pkg: ApartPackage): Promise<number | undefined> => {
    const { id, runtime, permissions } = pkg.apart.manifest;
    if (!manager.capabilities().reserves || !manager.reserveForApp) return;
    const need = needOf(
      { memory: runtime.memory, data: runtime.data, requests: permissions },
      options.grants.answers(id),
    );
    try {
      await manager.reserveForApp(id, need);
      return undefined;
    } catch (error) {
      if (!(error instanceof ManagerRefusal) || error.status !== 409) return;
    }
    const counted = await manager
      .appCapacity?.([{ app: id, ...need }])
      .catch(() => null);
    const room = counted?.[id];
    if (!room) return need.memoryMb;
    const more = Math.ceil(room.memoryNeedsMb - room.memoryFreeMb);
    return more > 0 ? more : undefined;
  };
}

export function createRoomWaits(options: {
  // Tries each update that waits for room again.
  retry: () => Promise<void>;
  log: (message: string) => void;
  everyMs?: number;
}) {
  let timer: NodeJS.Timeout | undefined;
  let trying: Promise<void> | undefined;
  let isClosed = false;

  // One try at a time: the manager may take a while to answer.
  function tryAgain() {
    if (isClosed || trying) return;
    trying = options
      .retry()
      .catch((error: unknown) => {
        options.log(
          `apps: updates waiting for room weren't tried (${String(error)})`,
        );
      })
      .finally(() => {
        trying = undefined;
      });
  }

  return {
    start() {
      if (isClosed || timer) return;
      timer = setInterval(tryAgain, options.everyMs ?? everyMs);
      timer.unref();
    },

    async close() {
      isClosed = true;
      clearInterval(timer);
      await trying;
    },
  };
}

export type RoomWaits = ReturnType<typeof createRoomWaits>;
