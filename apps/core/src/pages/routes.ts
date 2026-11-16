import type { PageTicket } from "@meetsanctum/auth-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { AuthError } from "../auth/errors.js";
import type { ServedFile } from "./files.js";
import type { Pages } from "./pages.js";

// What a frame loads an app's page from: its entry, its files and the kit,
// at addresses that start with the client's page ticket. A frame's loads
// can't carry the client's token, so these routes take none; the ticket is
// checked before anything is looked up, and one that opens nothing gets the
// same 404 as a file that isn't there, so nobody without a client learns
// which apps a home has or which kit it runs. Every answer says which files
// a page may load, exactly, and that it runs sandboxed, with nothing to
// connect to.
//
//   /pages/<ticket>/kit/<digest>/<file>
//   /pages/<ticket>/apps/<app>/<digest>/          the entry, which the core writes
//   /pages/<ticket>/apps/<app>/<digest>/<file>

// The client's own address; forwarded-for headers are not trusted.
const addressOf = (request: FastifyRequest) =>
  request.socket.remoteAddress ?? "unknown";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

export function registerPageRoutes(
  app: FastifyInstance,
  options: {
    pages: Pages;
    // Who may show a page in a frame: the desktop app's shell, and the
    // shells a development stack allows.
    frameAncestors: readonly string[];
  },
) {
  const { pages, frameAncestors } = options;
  const open = { config: { public: true } };

  app.post("/api/pages/ticket", async (request): Promise<PageTicket> => {
    const principal = request.principal!;
    if (principal.scope !== "full") throw new AuthError("forbidden");
    const { ticket, expiresAt } = pages.tickets.issue(principal.client.id);
    const kit = await pages.kit();
    return {
      ticket,
      expiresAt: expiresAt.toISOString(),
      kit: kit
        ? { version: kit.version, bridge: kit.bridge, digest: kit.digest }
        : null,
    };
  });

  const nothing = (reply: FastifyReply) =>
    reply
      .code(404)
      .header("cache-control", "no-store")
      .send({ error: "not_found" });

  // Whether a request's ticket opens anything; a ticket that doesn't counts
  // against its address.
  function admitted(request: FastifyRequest, ticket: string) {
    const address = addressOf(request);
    if (pages.turnedAway(address)) return "turned away";
    if (pages.tickets.holder(ticket)) return "admitted";
    pages.failed(address);
    return "refused";
  }

  // What every answer carries: the page's own folder and the kit's are the
  // only places it may load from, by exact address, since 'self' would be
  // the core's whole origin.
  function headers(
    reply: FastifyReply,
    places: { page?: string; kit: string; importMap?: string },
  ) {
    const { page, kit, importMap } = places;
    const scripts = [page, kit, importMap && `'sha256-${importMap}'`];
    const policy = [
      "default-src 'none'",
      `script-src ${scripts.filter(Boolean).join(" ")}`,
      `style-src ${[page, kit].filter(Boolean).join(" ")}`,
      `font-src ${kit}`,
      `img-src ${[page, kit].filter(Boolean).join(" ")} data: blob:`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "sandbox allow-scripts",
      `frame-ancestors ${frameAncestors.join(" ")}`,
    ].join("; ");
    return reply
      .header("content-security-policy", policy)
      .header("access-control-allow-origin", "*")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store");
  }

  const origin = (request: FastifyRequest) =>
    `${request.protocol}://${request.host}`;

  async function send(reply: FastifyReply, file: ServedFile) {
    const body = await readFile(file.path);
    return reply.header("content-type", file.type).send(body);
  }

  app.get<{ Params: { ticket: string; digest: string; "*": string } }>(
    "/pages/:ticket/kit/:digest/*",
    open,
    async (request, reply) => {
      const { ticket, digest } = request.params;
      const admission = admitted(request, ticket);
      if (admission === "turned away") {
        return reply.code(429).send({ error: "too_many_attempts" });
      }
      if (admission !== "admitted") return nothing(reply);
      const kit = await pages.kit();
      const file = kit?.digest === digest && kit.files.get(request.params["*"]);
      if (!file) return nothing(reply);
      headers(reply, {
        kit: `${origin(request)}/pages/${ticket}/kit/${digest}/`,
      });
      return send(reply, file);
    },
  );

  app.get<{
    Params: { ticket: string; appId: string; digest: string; "*": string };
  }>("/pages/:ticket/apps/:appId/:digest/*", open, async (request, reply) => {
    const { ticket, appId, digest } = request.params;
    const admission = admitted(request, ticket);
    if (admission === "turned away") {
      return reply.code(429).send({ error: "too_many_attempts" });
    }
    if (admission !== "admitted") return nothing(reply);
    const found = await pages.pagesOf(appId);
    const kit = await pages.kit();
    if (!found || !kit || found.digest !== digest) return nothing(reply);
    const base = `${origin(request)}/pages/${ticket}`;
    const pagePath = `/pages/${ticket}/apps/${appId}/${digest}/`;
    const kitPath = `/pages/${ticket}/kit/${kit.digest}/`;
    const places = {
      page: `${base}/apps/${appId}/${digest}/`,
      kit: `${base}/kit/${kit.digest}/`,
    };

    const name = request.params["*"];
    if (name !== "" && name !== "index.html") {
      const file = found.files.get(name);
      if (!file) return nothing(reply);
      headers(reply, places);
      return send(reply, file);
    }

    // The entry: the kit's import map under this ticket, which the policy
    // allows by its hash, then the kit's stylesheet and the page's own, and
    // the page's code.
    const imports = Object.fromEntries(
      Object.entries(kit.imports).map(([specifier, module]) => [
        specifier,
        `${kitPath}${module}`,
      ]),
    );
    const importMap = JSON.stringify({ imports }).replace(/</g, "\\u003c");
    const hash = createHash("sha256").update(importMap).digest("base64");
    const html = [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>${escapeHtml(found.name)}</title>`,
      `<script type="importmap">${importMap}</script>`,
      `<link rel="stylesheet" href="${kitPath}${kit.stylesheet}">`,
      ...(found.stylesheet
        ? [`<link rel="stylesheet" href="${pagePath}${found.stylesheet}">`]
        : []),
      `<script type="module" src="${pagePath}${found.entry}"></script>`,
      "</head>",
      "<body></body>",
      "</html>",
      "",
    ].join("\n");
    headers(reply, { ...places, importMap: hash });
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });
}
