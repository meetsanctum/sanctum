import { appendFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
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

async function recordTouches(
  request: IncomingMessage,
  response: ServerResponse,
  touchLog: string,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxTouchBytes) {
      response.writeHead(413).end();
      request.resume();
      return;
    }
    chunks.push(chunk);
  }

  let gesture: unknown;
  try {
    gesture = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!gesture || typeof gesture !== "object" || Array.isArray(gesture)) {
    response.writeHead(400).end();
    return;
  }
  await appendFile(touchLog, JSON.stringify(gesture) + "\n");
  response.writeHead(204).end();
}

export function displayBridge(touchLog?: string): Plugin {
  return {
    name: "sanctum-display",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const route = request.url?.split("?")[0];
        if (request.method === "POST" && route === "/auth/login_flow") {
          request.resume();
          response.writeHead(200, { "content-type": "application/json" });
          response.end(loginFlow);
          server.config.logger.info(
            `Display bridge: ${request.socket.remoteAddress} checked the address`,
          );
          return;
        }
        if (
          touchLog &&
          request.method === "POST" &&
          route === "/__display/touches"
        ) {
          void recordTouches(request, response, touchLog).catch((error) => {
            if (response.destroyed) return;
            server.config.logger.error(`Could not write ${touchLog}: ${error}`);
            response.writeHead(500).end();
          });
          return;
        }
        next();
      });
    },
    transformIndexHtml: touchLog
      ? () => [
          {
            tag: "script",
            attrs: { type: "module", src: "/dev/display-touches.js" },
            injectTo: "head-prepend",
          },
        ]
      : undefined,
  };
}
