import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// What the client keeps about how it shows the home, such as the dashboard
// on show, in `preferences.json` in the app's data folder. The page's own
// storage would not keep them: its session is in memory and is replaced
// whenever trust changes (pages.ts). Nothing secret goes here, so the file
// is plain. The page names its preferences; these limits keep the file
// small whatever it asks.

const keyPattern = /^[a-z][a-z0-9.-]{0,63}$/;
const maxValueLength = 4096;
const maxPreferences = 64;

type StoredFile = { version: 1; preferences: Record<string, string> };

function isPreference(key: unknown, value: unknown) {
  return (
    typeof key === "string" &&
    keyPattern.test(key) &&
    typeof value === "string" &&
    value.length <= maxValueLength
  );
}

// The preferences a file holds; none when it is missing or malformed, and
// without any entry this store would not have kept. Any other read error
// throws: an empty store would let the next save replace the file.
async function readPreferences(path: string) {
  const kept = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return kept;
    throw error;
  }
  try {
    const stored = JSON.parse(text) as StoredFile;
    if (stored.version === 1 && typeof stored.preferences === "object") {
      for (const [key, value] of Object.entries(stored.preferences ?? {})) {
        if (kept.size < maxPreferences && isPreference(key, value)) {
          kept.set(key, value);
        }
      }
    }
  } catch {
    // Then saving replaces it.
  }
  return kept;
}

export function createPreferenceStore(path: string) {
  // Read once. A file that could not be read stays as it is until the app
  // starts again: every get and save fails until then.
  let read: Promise<Map<string, string>> | undefined;
  // Saves may overlap: each writes everything kept by then, in order.
  let writing: Promise<unknown> = Promise.resolve();
  const kept = () => (read ??= readPreferences(path));

  async function write(text: string) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text);
      await rename(temporary, path);
    } finally {
      // Preserve the write error if cleaning up also fails.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  return {
    async get(key: string) {
      return (await kept()).get(key) ?? null;
    },

    async set(key: string, value: string) {
      if (!isPreference(key, value)) {
        throw new TypeError("Not a preference to keep");
      }
      const preferences = await kept();
      if (!preferences.has(key) && preferences.size >= maxPreferences) {
        throw new RangeError("Too many preferences");
      }
      preferences.set(key, value);
      // Even an unchanged value must reach disk: an earlier save may still
      // be pending or may have failed after updating the in-memory choice.
      const file: StoredFile = {
        version: 1,
        preferences: Object.fromEntries(preferences),
      };
      const text = JSON.stringify(file);
      const written = writing.then(() => write(text));
      writing = written.catch(() => undefined);
      await written;
    },
  };
}
