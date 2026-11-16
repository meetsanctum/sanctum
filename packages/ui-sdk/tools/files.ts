import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

// The files a build of pages or of the kit holds, which the core serves as
// they are: each with its type, size and hash, and the build's digest, which
// names what it holds rather than when it was built.

/** The only types a frame is served, by extension. */
export const fileTypes: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type BuiltFile = { type: string; size: number; sha256: string };

/** Every file under `root`, by its path there with `/`, in a stable order. */
export async function listFiles(
  root: string,
  leaveOut: readonly string[] = [],
): Promise<Record<string, BuiltFile>> {
  const files: Record<string, BuiltFile> = {};
  async function visit(folder: string, prefix: string) {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        await visit(join(folder, entry.name), `${path}/`);
      } else if (entry.isFile()) {
        if (leaveOut.includes(path)) continue;
        const type = fileTypes[extname(entry.name)];
        if (!type) {
          throw new Error(`${path} isn't a file a page may load`);
        }
        const body = await readFile(join(folder, entry.name));
        files[path] = {
          type,
          size: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        };
      } else {
        throw new Error(`${path} is neither a file nor a folder`);
      }
    }
  }
  await visit(root, "");
  return files;
}

/** A build's digest: its files' paths and hashes, so the same files name the same build. */
export function digestOf(files: Record<string, BuiltFile>) {
  const hash = createHash("sha256");
  for (const [path, file] of Object.entries(files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    hash.update(`${path}\0${file.sha256}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}
