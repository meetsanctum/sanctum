import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { syncPath } from "./durable.js";

// The manager's small state files live in its data volume. Writes go through
// a temporary file and a rename, so a crash never leaves half a file, and are
// on the disk before this returns, so a power cut never loses one that a later
// step relied on.

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeJson(
  path: string,
  value: unknown,
  options: { mode?: number } = {},
) {
  const created = await mkdir(dirname(path), { recursive: true });
  if (created) {
    const parent = dirname(created);
    let directory = dirname(path);
    do {
      directory = dirname(directory);
      await syncPath(directory);
    } while (directory !== parent);
  }
  // The manager and its updater both run as PID 1 in their containers.
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, options);
  await syncPath(temporary);
  await rename(temporary, path);
  await syncPath(dirname(path));
}

export type HostState = {
  // Identifies the host on the network; paired clients only talk to this id.
  // Kept by the manager, so update rollbacks and core restores leave it alone.
  hostId: string;
  // The home the core serves, as it last reported it, so a restarted
  // manager announces it right away. None until the core first reports.
  homeId?: string;
  // The immutable core image id, pinned on setup and after each commit.
  coreImage?: string;
  // Whether the host is claimed, as the core last reported it, so a restarted
  // manager announces it right away.
  claimed?: boolean;
};

// Merge each change with the last successfully saved state, inside the queue.
// Failed writes leave memory unchanged so callers can retry them.
export function createHostStateWriter(
  state: HostState,
  save: (state: HostState) => Promise<void>,
) {
  let saving: Promise<void> = Promise.resolve();
  return (change: Partial<HostState>) => {
    saving = saving
      .catch(() => undefined)
      .then(async () => {
        const next = { ...state, ...change };
        await save(next);
        Object.assign(state, next);
      });
    return saving;
  };
}

export function createHostStateStore(dataDir: string) {
  const path = join(dataDir, "state.json");
  return {
    async load(): Promise<HostState> {
      const existing = await readJson<Partial<HostState>>(path);
      if (existing?.hostId) {
        return existing as HostState;
      }
      // A file without a host id keeps what else it holds, such as the
      // pinned core image.
      const created = { ...existing, hostId: randomUUID() };
      await writeJson(path, created);
      return created;
    },
    async save(state: HostState) {
      await writeJson(path, state);
    },
  };
}
