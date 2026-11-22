import { blobHashPattern } from "@meetsanctum/app-sdk";
import type { FastifyInstance } from "fastify";

import { ActionCallError } from "../app-host/errors.js";
import type { Gate } from "../app-host/gate.js";
import type { Blobs } from "./blobs.js";

// GET /api/blobs/:hash: a blob's bytes for a client, such as the picture of
// what a media player plays, for any client that may see the home, with its
// token as every route has. A hash names the same bytes for good, so a
// client keeps the answer; a blob that has gone, or never was, is not
// found.
export function registerBlobRoutes(
  app: FastifyInstance,
  options: { blobs: Blobs; gate: Gate },
) {
  app.get<{ Params: { hash: string } }>(
    "/api/blobs/:hash",
    async (request, reply) => {
      options.gate.admit(request.principal!, { tier: "read" });
      const { hash } = request.params;
      const blob = blobHashPattern.test(hash) ? options.blobs.get(hash) : null;
      if (!blob) throw new ActionCallError("not_found");
      return reply
        .header("content-type", blob.type)
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .send(Buffer.from(blob.bytes));
    },
  );
}
