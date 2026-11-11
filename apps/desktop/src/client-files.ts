import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";

// The desktop app loads the built client from its own origin, never from the
// core. The core lets this origin read its responses: the manager passes it
// in CORE_ALLOWED_ORIGINS (apps/manager/src/core-container.ts).

export const clientScheme = "app";
export const clientHost = "sanctum";
export const clientOrigin = `${clientScheme}://${clientHost}`;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// The page runs only its own scripts, and OPAQUE's WebAssembly, with the
// fonts it ships. It reaches the core wherever the host is on the home
// network, so connections may go to any address: over HTTPS and WSS, and
// plain HTTP only in development. Every one is checked against the pin
// (trust.ts).
export function contentSecurityPolicy(allowPlainHttp: boolean) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src https: wss:${allowPlainHttp ? " http: ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Whether `url` is the client's own. URL's origin is "null" for schemes it
// does not know, so the scheme and host are compared instead.
export function isClientUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${clientScheme}:` && parsed.host === clientHost;
  } catch {
    return false;
  }
}

// The file under `root` that `url` asks for: the page itself for the app's
// own paths, and nothing outside `root`.
export function clientFile(root: string, url: string) {
  if (!isClientUrl(url)) {
    return undefined;
  }
  const parsed = new URL(url);
  const file = normalize(join(root, decodeURIComponent(parsed.pathname)));
  const inside = relative(root, file);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    return undefined;
  }
  return extname(file) ? file : join(root, "index.html");
}

export async function serveClient(
  root: string,
  url: string,
  options: { allowPlainHttp: boolean },
): Promise<Response> {
  const file = clientFile(root, url);
  if (!file) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const body = await readFile(file);
    const headers = new Headers({
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
    });
    if (extname(file) === ".html") {
      headers.set(
        "content-security-policy",
        contentSecurityPolicy(options.allowPlainHttp),
      );
    }
    return new Response(body, { headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
