import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// The desktop app's own store of apps' page files and the kit. Chromium
// never keeps a sandboxed frame's files in its HTTP cache, so without this
// every open of a page fetches every file again. Each is kept on disk as
// the core served it, with its headers, by the host it came from and its
// address after the ticket, which names a build's digest, so a build's files
// never change under it. The entry, which the core writes under each ticket,
// is never kept, so a ticket that ends opens nothing even here.
//
//   <root>/<host>/kit/<digest>/<file>
//   <root>/<host>/apps/<app>/<digest>/<file>
//
// A build no page has used for a month goes.

const pageFile =
  /^\/pages\/[A-Za-z0-9_-]+\/(kit\/[0-9a-f]+|apps\/[a-z0-9][a-z0-9.-]*\/[0-9a-f]+)\/((?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*)$/;

// The headers kept with a file, and given back with it.
const keptHeaders = [
  "content-type",
  "content-security-policy",
  "access-control-allow-origin",
  "x-content-type-options",
  "referrer-policy",
  "cache-control",
];

const unusedFor = 30 * 24 * 60 * 60_000;

/** Where a page or kit file is kept, from its address, or none for anything else. */
export function keptAs(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.search || parsed.username || parsed.password) return undefined;
  const match = pageFile.exec(parsed.pathname);
  if (!match || match[2] === "index.html") return undefined;
  return { build: match[1]!, file: match[2]! };
}

const isHost = (host: string) => /^[A-Za-z0-9-]{1,64}$/.test(host);

export function createPageStore(root: string, now: () => number = Date.now) {
  // The builds used since the app started, whose folders are touched once.
  const touched = new Set<string>();

  const folderOf = (host: string, build: string) =>
    join(root, host, ...build.split("/"));

  async function touch(folder: string) {
    if (touched.has(folder)) return;
    touched.add(folder);
    const at = new Date(now());
    await utimes(folder, at, at).catch(() => undefined);
  }

  return {
    /** A kept file as the core served it, or none. */
    async get(host: string, url: string): Promise<Response | undefined> {
      const kept = keptAs(url);
      if (!kept || !isHost(host)) return undefined;
      const folder = folderOf(host, kept.build);
      const path = join(folder, kept.file);
      try {
        const [body, meta] = await Promise.all([
          readFile(path),
          readFile(`${path}.headers.json`, "utf8"),
        ]);
        const headers = JSON.parse(meta) as Record<string, string>;
        await touch(folder);
        return new Response(body, { headers });
      } catch {
        return undefined;
      }
    },

    /** Keeps a file the core answered with, whole, before anything reads it. */
    async put(host: string, url: string, response: Response) {
      const kept = keptAs(url);
      if (!kept || !isHost(host) || response.status !== 200) return;
      const headers: Record<string, string> = {};
      for (const name of keptHeaders) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const body = Buffer.from(await response.arrayBuffer());
      const folder = folderOf(host, kept.build);
      const path = join(folder, kept.file);
      await mkdir(dirname(path), { recursive: true });
      // Written aside and moved in, headers first, so a file is either
      // there whole with its headers or not at all.
      const aside = `${path}.${randomUUID()}`;
      await writeFile(`${aside}.headers`, JSON.stringify(headers));
      await rename(`${aside}.headers`, `${path}.headers.json`);
      await writeFile(aside, body);
      await rename(aside, path);
      await touch(folder);
      return body;
    },

    /** Takes away the builds no page has used for a month. */
    async prune() {
      const builds = async (host: string) => {
        const found: string[] = [];
        const kit = join(root, host, "kit");
        for (const digest of await readdir(kit).catch(() => [])) {
          found.push(join(kit, digest));
        }
        const apps = join(root, host, "apps");
        for (const app of await readdir(apps).catch(() => [])) {
          for (const digest of await readdir(join(apps, app)).catch(() => [])) {
            found.push(join(apps, app, digest));
          }
        }
        return found;
      };
      for (const host of await readdir(root).catch(() => [])) {
        for (const folder of await builds(host)) {
          const info = await stat(folder).catch(() => undefined);
          if (info && now() - info.mtimeMs > unusedFor) {
            await rm(folder, { recursive: true, force: true });
          }
        }
      }
    },
  };
}

export type PageStore = ReturnType<typeof createPageStore>;

/**
 * Answers a request of the page's session: a page or kit file from the
 * store, or fetched and kept; anything else passed on as it was.
 */
export async function answer(
  request: Request,
  options: {
    store: PageStore;
    // The host the page's session trusts, whose files these are; none
    // while a first contact is checked.
    host: () => string | null;
    passOn: (request: Request) => Promise<Response>;
  },
): Promise<Response> {
  const host = options.host();
  if (request.method !== "GET" || !host || !keptAs(request.url)) {
    return options.passOn(request);
  }
  const kept = await options.store.get(host, request.url);
  if (kept) return kept;
  const response = await options.passOn(request);
  if (response.status !== 200) return response;
  const headers = new Headers(response.headers);
  const body = await options.store
    .put(host, request.url, response.clone())
    .catch(() => undefined);
  return body ? new Response(body, { status: 200, headers }) : response;
}
