import type {
  AiCanUse,
  SwitchAiArea,
  SwitchAiOffer,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Gate } from "../app-host/gate.js";
import { permissionsRule } from "../app-host/grants.js";
import { changedBy, parseRequest } from "../auth/callers.js";
import type { AgentsCanUse } from "./can-use.js";

// What AI agents can use, on Settings and each app's settings page. Like an
// app's grants it's the household's to choose, on every client, and no AI
// agent reads or changes it here.
//
//   GET  /api/agents/can-use          AiCanUse
//   POST /api/agents/can-use/area     SwitchAiArea → AiCanUse
//   POST /api/agents/can-use/offer    SwitchAiOffer → AiCanUse

const id = z.string().min(1);

const schemas = {
  area: z.object({ id, on: z.boolean() }) satisfies z.ZodType<SwitchAiArea>,
  offer: z.object({
    app: id,
    id,
    on: z.boolean(),
  }) satisfies z.ZodType<SwitchAiOffer>,
};

export function registerAgentRoutes(
  app: FastifyInstance,
  options: { canUse: AgentsCanUse; gate: Gate },
) {
  const { canUse, gate } = options;

  app.get("/api/agents/can-use", async (request): Promise<AiCanUse> => {
    gate.admit(request.principal!, { tier: "read" });
    return canUse.list();
  });

  app.post("/api/agents/can-use/area", async (request): Promise<AiCanUse> => {
    gate.admit(request.principal!, permissionsRule);
    const { id: area, on } = parseRequest(schemas.area, request.body);
    canUse.setArea(area, on, changedBy(request.principal!));
    return canUse.list();
  });

  app.post("/api/agents/can-use/offer", async (request): Promise<AiCanUse> => {
    gate.admit(request.principal!, permissionsRule);
    const body = parseRequest(schemas.offer, request.body);
    canUse.setOffer(body.app, body.id, body.on, changedBy(request.principal!));
    return canUse.list();
  });
}
