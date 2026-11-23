import { appendFile, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { Plugin } from "vite";

// The wall display checks for Home Assistant's first sign-in form before
// opening the address in its browser.
const loginFlow = JSON.stringify({
  type: "form",
  flow_id: "0".repeat(32),
  handler: ["homeassistant", null],
  step_id: "init",
  data_schema: [
    { type: "string", name: "username", required: true },
    { type: "string", name: "password", required: true },
  ],
  errors: {},
  description_placeholders: null,
  last_step: null,
  preview: null,
});

const maxTouchBytes = 64 * 1024;
const maxFrameBytes = 512 * 1024;

/**
 * Where the client built for the display is served, beside the dev one, so
 * it keeps the display's sign-in, which belongs to this address.
 */
export const builtPath = "/__display/built/";
const blankPath = "/__display/blank";
const controlPath = "/__display/control";
const framesScript = "/dev/display-frames.js";
const missingBuild =
  "No client built for the display: pnpm --filter @meetsanctum/client build:display";

/**
 * What the display is told on its next look: which page to show, the run its
 * timings belong to, and effects turned off by hand to see what they cost.
 */
type DisplayControl = {
  page: "dev" | "built" | "blank";
  label: string;
  blur: boolean;
  masks: boolean;
  /** What to do now, shown on the display while a run needs a hand on it. */
  prompt: string;
  /** Raised to have the display load its page again. */
  reload: number;
};

const pages = { dev: "/", built: builtPath, blank: blankPath } as const;

async function readBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      request.resume();
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function parseObject(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function recordLine(
  request: IncomingMessage,
  response: ServerResponse,
  log: string,
  maxBytes: number,
) {
  const text = await readBody(request, maxBytes);
  if (text === undefined) {
    response.writeHead(413).end();
    return;
  }
  const value = parseObject(text);
  if (!value) {
    response.writeHead(400).end();
    return;
  }
  await appendFile(log, JSON.stringify(value) + "\n");
  response.writeHead(204).end();
}

const isLoopback = (request: IncomingMessage) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    request.socket.remoteAddress ?? "",
  );

function sendControl(response: ServerResponse, control: DisplayControl) {
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ ...control, path: pages[control.page] }));
}

// Only local command-line tooling changes the control. The display and other
// browsers on the network can read it.
async function changeControl(
  request: IncomingMessage,
  response: ServerResponse,
  control: DisplayControl,
  builtDir?: string,
) {
  if (!isLoopback(request) || request.headers.origin !== undefined) {
    request.resume();
    response.writeHead(403).end();
    return;
  }
  const text = await readBody(request, 4096);
  if (text === undefined) {
    response.writeHead(413).end();
    return;
  }
  const change = parseObject(text);
  const page = change?.page;
  if (
    !change ||
    (page !== undefined &&
      page !== "dev" &&
      page !== "built" &&
      page !== "blank")
  ) {
    response.writeHead(400).end();
    return;
  }
  if (page === "built") {
    const index =
      builtDir &&
      (await stat(join(builtDir, "index.html")).catch(() => undefined));
    if (!index || !index.isFile()) {
      response
        .writeHead(409, { "content-type": "text/plain" })
        .end(missingBuild);
      return;
    }
  }
  if (page !== undefined) control.page = page;
  if (typeof change.label === "string") control.label = change.label;
  if (typeof change.prompt === "string") control.prompt = change.prompt;
  if (typeof change.blur === "boolean") control.blur = change.blur;
  if (typeof change.masks === "boolean") control.masks = change.masks;
  if (change.reload === true) control.reload += 1;
  sendControl(response, control);
}

const scriptTag = (src: string) =>
  `<script type="module" src="${src}"></script>`;

const blankPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${scriptTag(framesScript)}</head>
<body style="margin:0;height:100vh;background:#222326"></body>
</html>`;

const types: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

// The client built with its base at builtPath (`vite build --base`): its
// files, and its page with the recorder in it for anything else, as for the
// shell's own routes.
async function serveBuilt(
  route: string,
  response: ServerResponse,
  builtDir: string,
  scripts: string[],
) {
  const relative = normalize(route.slice(builtPath.length));
  const extension = extname(relative);
  if (extension && extension !== ".html") {
    const file = join(builtDir, relative);
    if (!file.startsWith(builtDir + sep)) {
      response.writeHead(404).end();
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": types[extension] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(body);
    return;
  }
  let page: string;
  try {
    page = await readFile(join(builtDir, "index.html"), "utf8");
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(missingBuild);
    return;
  }
  if (scripts.length) {
    page = page.replace("<head>", `<head>${scripts.map(scriptTag).join("")}`);
  }
  response.writeHead(200, {
    "content-type": "text/html",
    "cache-control": "no-cache",
  });
  response.end(page);
}

export function displayBridge(
  options: {
    /** Each gesture's pointer and touch events, as JSON lines. */
    touchLog?: string;
    /** Frame and input timings as JSON lines, and the control and blank page. */
    frameLog?: string;
    /** The client built for the display, served at builtPath. */
    builtDir?: string;
  } = {},
): Plugin {
  const { touchLog, frameLog, builtDir } = options;
  const control: DisplayControl = {
    page: "dev",
    label: "",
    blur: true,
    masks: true,
    prompt: "",
    reload: 0,
  };
  const scripts = [
    touchLog && "/dev/display-touches.js",
    frameLog && framesScript,
  ].filter((src): src is string => Boolean(src));
  return {
    name: "sanctum-display",
    apply: "serve",
    configureServer(server) {
      const failed =
        (response: ServerResponse, log: string) => (error: unknown) => {
          if (response.destroyed) return;
          server.config.logger.error(`Could not write ${log}: ${error}`);
          response.writeHead(500).end();
        };
      server.middlewares.use((request, response, next) => {
        const route = request.url?.split("?")[0] ?? "";
        const method = request.method;
        if (method === "POST" && route === "/auth/login_flow") {
          request.resume();
          response.writeHead(200, { "content-type": "application/json" });
          response.end(loginFlow);
          server.config.logger.info(
            `Display bridge: ${request.socket.remoteAddress} checked the address`,
          );
          return;
        }
        if (touchLog && method === "POST" && route === "/__display/touches") {
          void recordLine(request, response, touchLog, maxTouchBytes).catch(
            failed(response, touchLog),
          );
          return;
        }
        if (frameLog && method === "POST" && route === "/__display/frames") {
          void recordLine(request, response, frameLog, maxFrameBytes).catch(
            failed(response, frameLog),
          );
          return;
        }
        if (frameLog && route === controlPath) {
          if (method === "GET") return sendControl(response, control);
          if (method === "POST") {
            void changeControl(request, response, control, builtDir).catch(
              next,
            );
            return;
          }
        }
        if (frameLog && method === "GET" && route === blankPath) {
          response.writeHead(200, {
            "content-type": "text/html",
            "cache-control": "no-cache",
          });
          response.end(blankPage);
          return;
        }
        if (builtDir && method === "GET" && `${route}/`.startsWith(builtPath)) {
          void serveBuilt(route, response, builtDir, scripts).catch(next);
          return;
        }
        next();
      });
    },
    transformIndexHtml: scripts.length
      ? () =>
          scripts.map((src) => ({
            tag: "script",
            attrs: { type: "module", src },
            injectTo: "head-prepend" as const,
          }))
      : undefined,
  };
}
