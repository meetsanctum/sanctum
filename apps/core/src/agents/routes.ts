import type {
  AiCanUse,
  SwitchAiArea,
  SwitchAiOffer,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ActionCallError } from "../app-host/errors.js";
import type { Gate, Rule } from "../app-host/gate.js";
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
  // Refused here as well as by the auth hook: an AI agent's token never
  // reads or changes what AI agents can use.
  const admit = (request: FastifyRequest, rule: Rule) => {
    if (request.principal?.scope === "agent") {
      throw new ActionCallError("forbidden");
    }
    gate.admit(request.principal!, rule);
  };

  app.get("/api/agents/can-use", async (request): Promise<AiCanUse> => {
    admit(request, { tier: "read" });
    return canUse.list();
  });

  app.post("/api/agents/can-use/area", async (request): Promise<AiCanUse> => {
    admit(request, permissionsRule);
    const { id: area, on } = parseRequest(schemas.area, request.body);
    canUse.setArea(area, on, changedBy(request.principal!));
    return canUse.list();
  });

  app.post("/api/agents/can-use/offer", async (request): Promise<AiCanUse> => {
    admit(request, permissionsRule);
    const body = parseRequest(schemas.offer, request.body);
    canUse.setOffer(body.app, body.id, body.on, changedBy(request.principal!));
    return canUse.list();
  });
}
