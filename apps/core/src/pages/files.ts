import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { z } from "zod";

// What the core serves app pages from: the kit in its own image, and each
// running app's pages/ in its staged package, as indexes it builds itself. A
// request is answered only by an entry of an index, so no part of an
// address ever becomes a path on disk. A package is the app developer's, so
// its pages.json is only a list to check: each file it names must be in its
// pages/, a plain file there, of a type a page may load, and the size and
// hash it says; a build that doesn't check out is served not at all.

/** The only types the core serves a frame, by extension. */
export const servedTypes: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type ServedFile = {
  path: string;
  type: string;
  size: number;
  sha256: string;
};

export type FileIndex = {
  /** Names what the files hold, as the build that made them does. */
  digest: string;
  files: ReadonlyMap<string, ServedFile>;
};

export type KitIndex = FileIndex & {
  version: string;
  bridge: number;
  stylesheet: string;
  imports: Readonly<Record<string, string>>;
};

export type PagesIndex = FileIndex & {
  kit: string;
  entry: string;
  stylesheet: string | null;
};

// A file's name in a build: folders and names of letters, digits, dots,
// dashes and underscores, none of them dots alone.
const safeName =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const sha256 = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");

/** A build's digest from its files' names and hashes, as ui-sdk's tools name it. */
export function digestOf(files: Iterable<[string, { sha256: string }]>) {
  const hash = createHash("sha256");
  for (const [name, file] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    hash.update(`${name}\0${file.sha256}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

// A plain file inside `root`, by a safe name, or nothing.
async function plainFileIn(root: string, name: string) {
  if (!safeName.test(name)) return undefined;
  const type = servedTypes[extname(name)];
  if (!type) return undefined;
  const path = join(root, name);
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const real = await realpath(path);
  const realRoot = await realpath(root);
  if (!real.startsWith(realRoot + sep)) return undefined;
  return { path: real, type };
}

/** The kit in `kitDir`, or none where there isn't one. */
export async function indexKit(
  kitDir: string,
  log: (message: string) => void,
): Promise<KitIndex | null> {
  let text: string;
  try {
    text = await readFile(join(kitDir, "kit.json"), "utf8");
  } catch (error) {
    // No kit, where the image has none. Anything else may pass, so it's
    // thrown for the next request to try again.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let manifest: Omit<KitIndex, "files" | "digest"> & { digest?: string };
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    log(`pages: the kit's kit.json isn't JSON (${String(error)})`);
    return null;
  }
  const files = new Map<string, ServedFile>();
  async function visit(folder: string, prefix: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        await visit(join(folder, entry.name), `${name}/`);
      } else if (entry.isFile() && name !== "kit.json") {
        const found = await plainFileIn(kitDir, name);
        if (!found) continue;
        const body = await readFile(found.path);
        files.set(name, { ...found, size: body.length, sha256: sha256(body) });
      }
    }
  }
  await visit(kitDir, "");
  const digest = digestOf(files);
  if (manifest.digest !== digest) {
    log(
      `pages: the kit says it is ${manifest.digest}, but what it holds is ${digest}`,
    );
  }
  return {
    version: manifest.version,
    bridge: manifest.bridge,
    stylesheet: manifest.stylesheet,
    imports: manifest.imports,
    digest,
    files,
  };
}

const pagesManifest = z.object({
  kit: z.string(),
  entry: z.string(),
  stylesheet: z.string().nullable().optional(),
  files: z.record(
    z.string(),
    z.object({
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});

/** An app's pages in its package's `pages/`, checked file by file, or none. */
export async function indexPages(
  pagesDir: string,
  log: (message: string) => void,
): Promise<PagesIndex | null> {
  let text: string;
  try {
    // A linked pages folder could make its own files appear to belong to
    // the package even when they live outside it.
    if (!(await lstat(pagesDir)).isDirectory()) return null;
    text = await readFile(join(pagesDir, "pages.json"), "utf8");
  } catch (error) {
    // No pages, where the package has none. Anything else may pass, so it's
    // thrown for the next request to try again.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    log(`pages: ${pagesDir} isn't served: its pages.json isn't JSON`);
    return null;
  }
  const refuse = (why: string) => {
    log(`pages: ${pagesDir} isn't served: ${why}`);
    return null;
  };
  const parsed = pagesManifest.safeParse(source);
  if (!parsed.success) return refuse("its pages.json is invalid");
  const manifest = parsed.data;
  const files = new Map<string, ServedFile>();
  for (const [name, said] of Object.entries(manifest.files)) {
    const found = await plainFileIn(pagesDir, name);
    if (!found) return refuse(`${name} isn't a file it may serve`);
    const body = await readFile(found.path);
    if (body.length !== said.size || sha256(body) !== said.sha256) {
      return refuse(`${name} isn't what its pages.json says`);
    }
    files.set(name, { ...found, size: body.length, sha256: said.sha256 });
  }
  const stylesheet =
    typeof manifest.stylesheet === "string" ? manifest.stylesheet : null;
  if (!files.has(manifest.entry))
    return refuse("its entry isn't among its files");
  if (stylesheet !== null && !files.has(stylesheet)) {
    return refuse("its stylesheet isn't among its files");
  }
  return {
    kit: manifest.kit,
    entry: manifest.entry,
    stylesheet,
    digest: digestOf(files),
    files,
  };
}
