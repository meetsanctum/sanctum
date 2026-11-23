import {
  modelProviders,
  type AddModelSource,
  type ChangeModelSource,
  type LookAtModelSource,
  type ModelSourceLook,
  type ModelsInfo,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ActionCallError } from "../app-host/errors.js";
import type { Gate, Rule } from "../app-host/gate.js";
import { changedBy, parseRequest } from "../auth/callers.js";
import type { Models } from "./models.js";

// Settings → AI models: the household's to change, on every client. No AI
// agent reads or changes it, and no answer holds a key.
//
//   GET    /api/models                     ModelsInfo
//   POST   /api/models/look                LookAtModelSource → ModelSourceLook
//   POST   /api/models/sources             AddModelSource → ModelsInfo
//   PATCH  /api/models/sources/:id         ChangeModelSource → ModelsInfo
//   GET    /api/models/sources/:id/models  ModelSourceLook
//   POST   /api/models/sources/:id/use     → ModelsInfo
//   POST   /api/models/sources/:id/check   → ModelsInfo
//   DELETE /api/models/sources/:id         → ModelsInfo

const provider = z.enum(modelProviders);
const address = z.string().trim().min(1).max(260);
const key = z.string().trim().min(8).max(512);
const computer = z.string().trim().min(1).max(64);
const model = z.string().min(1).max(256);

const schemas = {
  look: z.union([
    z.strictObject({ kind: z.literal("sanctum") }),
    z.object({ kind: z.literal("computer"), address }),
    z.object({ kind: provider, key }),
  ]) satisfies z.ZodType<LookAtModelSource>,
  add: z.union([
    z.strictObject({ kind: z.literal("sanctum"), model }),
    z.object({ kind: z.literal("computer"), address, computer, model }),
    z.object({ kind: provider, key, model }),
  ]) satisfies z.ZodType<AddModelSource>,
  change: z
    .object({
      computer: computer.optional(),
      key: key.optional(),
      model: model.optional(),
    })
    .strict() satisfies z.ZodType<ChangeModelSource>,
  id: z.object({ id: z.string().min(1).max(64) }),
};

const readRule: Rule = { tier: "read" };
const changeRule: Rule = { tier: "write" };

export function registerModelRoutes(
  app: FastifyInstance,
  options: { models: Models; gate: Gate },
) {
  const { models, gate } = options;
  // Refused here as well as by the auth hook: an AI agent's token never
  // reaches the home's model sources.
  const admit = (request: FastifyRequest, rule: Rule) => {
    if (request.principal?.scope === "agent") {
      throw new ActionCallError("forbidden");
    }
    gate.admit(request.principal!, rule);
  };
  const idOf = (request: FastifyRequest) =>
    parseRequest(schemas.id, request.params).id;

  app.get("/api/models", async (request): Promise<ModelsInfo> => {
    admit(request, readRule);
    return models.info();
  });

  app.post("/api/models/look", async (request): Promise<ModelSourceLook> => {
    admit(request, changeRule);
    return models.look(parseRequest(schemas.look, request.body));
  });

  app.post("/api/models/sources", async (request): Promise<ModelsInfo> => {
    admit(request, changeRule);
    return models.add(
      parseRequest(schemas.add, request.body),
      changedBy(request.principal!),
    );
  });

  app.patch("/api/models/sources/:id", async (request): Promise<ModelsInfo> => {
    admit(request, changeRule);
    return models.change(
      idOf(request),
      parseRequest(schemas.change, request.body),
      changedBy(request.principal!),
    );
  });

  app.get(
    "/api/models/sources/:id/models",
    async (request): Promise<ModelSourceLook> => {
      admit(request, changeRule);
      return models.modelsOf(idOf(request));
    },
  );

  app.post(
    "/api/models/sources/:id/use",
    async (request): Promise<ModelsInfo> => {
      admit(request, changeRule);
      return models.use(idOf(request), changedBy(request.principal!));
    },
  );

  app.post(
    "/api/models/sources/:id/check",
    async (request): Promise<ModelsInfo> => {
      admit(request, changeRule);
      return models.check(idOf(request));
    },
  );

  app.delete(
    "/api/models/sources/:id",
    async (request): Promise<ModelsInfo> => {
      admit(request, changeRule);
      return models.remove(idOf(request), changedBy(request.principal!));
    },
  );
}
