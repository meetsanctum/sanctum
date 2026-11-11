import { execFile as execFileCallback } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

// What the manager writes counts as written only once it's on the disk. Until
// then a power cut can lose it, while a later step that relies on it has
// already happened: an update must not stop the core on a snapshot that goes
// missing with the power.

const execFile = promisify(execFileCallback);

// One file, or one folder's list of names: a rename is only safe once the
// folder holding it is synced.
export async function syncPath(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Everything written so far on the file system `path` is on, whoever wrote it.
// For a whole tree: syncing thousands of files one by one costs an SD card a
// journal commit each, which can take minutes, where this takes one.
export async function syncFileSystem(path: string) {
  await execFile("sync", ["-f", path]);
}
