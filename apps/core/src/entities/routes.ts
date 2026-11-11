import type { EntityInfo } from "@meetsanctum/app-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Gate } from "../app-host/gate.js";
import { entitiesForPage } from "../app-host/page-requests.js";
import { parseRequest } from "../auth/callers.js";
import type { Entities } from "./entities.js";

// Entities' client route: what the installed apps bring to the home, for
// dashboards, app pages and each app's catalog in Settings → Apps, for every
// client.
//
//   GET /api/entities?app=&type=   EntityInfo[], of one app or one type if
//                                  asked

const query = z.object({
  app: z.string().min(1).max(128).optional(),
  type: z.string().min(1).max(128).optional(),
});

export function registerEntityRoutes(
  app: FastifyInstance,
  options: { entities: Entities; gate: Gate },
) {
  const { entities, gate } = options;

  app.get("/api/entities", async (request): Promise<EntityInfo[]> => {
    gate.admit(request.principal!, { tier: "read" });
    return entitiesForPage(
      request,
      entities.list(parseRequest(query, request.query)),
    );
  });
}
