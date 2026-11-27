import type { HostWriteout } from "./manager-answers.js";

// Whether the host is writing out a backlog of the page cache to its disks,
// as the manager last said. Every fsync waits behind such a backlog, the
// apps' database writes and the core's among them, so apps answer late
// meanwhile and get more time before they count as hung (app-host/link.ts).
// It is the host's state, whatever filled the cache: a pull, an update, a
// backup or an app's image growing.
//
// The manager can answer late then too, so while one writeout it reported
// is under way, no answer leaves it under way, for `holdMs` after the last
// answer that said so.

const defaultHoldMs = 2 * 60_000;

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

export function createWriteoutFollower(options: {
  log: (message: string) => void;
  holdMs?: number;
  now?: () => number;
}) {
  const { log } = options;
  const holdMs = options.holdMs ?? defaultHoldMs;
  const now = options.now ?? (() => performance.now());
  let lastSaidAt: number | undefined;

  const isHeld = () => lastSaidAt !== undefined && now() - lastSaidAt < holdMs;

  return {
    /** The manager's answer, or null from one that can't say. */
    heard(answer: HostWriteout | null) {
      if (answer?.writingOut) {
        if (lastSaidAt === undefined) {
          log(
            `host: writing out ${megabytes(answer.pendingBytes)} MB to its disks, past ${megabytes(answer.thresholdBytes)} MB; apps get more time to answer`,
          );
        }
        lastSaidAt = now();
        return;
      }
      if (lastSaidAt !== undefined) {
        lastSaidAt = undefined;
        log("host: done writing out to its disks");
      }
    },

    /** The manager didn't answer. */
    missed() {
      if (lastSaidAt === undefined || isHeld()) return;
      lastSaidAt = undefined;
      log(
        `host: done writing out to its disks, as far as the core knows: the manager hasn't answered for ${Math.round(holdMs / 1000)} s`,
      );
    },

    writingOut: isHeld,
  };
}

export type WriteoutFollower = ReturnType<typeof createWriteoutFollower>;
