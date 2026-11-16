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

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function describe(path: string, body: Uint8Array): BuiltFile {
  const type = fileTypes[extname(path)];
  if (!type) throw new Error(`${path} isn't a file a page may load`);
  return {
    type,
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

/** What a build wrote, from Vite's own result: each file as it went to disk. */
export type BuildOutput = {
  fileName: string;
} & (
  | { type: "chunk"; code: string }
  | { type: "asset"; source: string | Uint8Array }
);

/** The files a build wrote, by path, from what it wrote rather than reading them back. */
export function filesOf(result: unknown): Record<string, BuiltFile> {
  const results = (Array.isArray(result) ? result : [result]) as {
    output?: BuildOutput[];
  }[];
  const outputs = results.flatMap((each) => each.output ?? []);
  if (outputs.length === 0) throw new Error("The build wrote nothing");
  const files: Record<string, BuiltFile> = {};
  for (const output of [...outputs].sort((a, b) =>
    byPath(a.fileName, b.fileName),
  )) {
    const body =
      output.type === "chunk"
        ? Buffer.from(output.code)
        : typeof output.source === "string"
          ? Buffer.from(output.source)
          : output.source;
    files[output.fileName] = describe(output.fileName, body);
  }
  return files;
}

/** Every file under `root`, by its path there with `/`, in a stable order. */
export async function listFiles(
  root: string,
  leaveOut: readonly string[] = [],
): Promise<Record<string, BuiltFile>> {
  const files: Record<string, BuiltFile> = {};
  async function visit(folder: string, prefix: string) {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => byPath(a.name, b.name));
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        await visit(join(folder, entry.name), `${path}/`);
      } else if (entry.isFile()) {
        if (leaveOut.includes(path)) continue;
        files[path] = describe(path, await readFile(join(folder, entry.name)));
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
    byPath(a, b),
  )) {
    hash.update(`${path}\0${file.sha256}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}
