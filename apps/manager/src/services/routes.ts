import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  ServiceRequestError,
  UnknownServiceError,
  type Services,
} from "./services.js";
import { zigbeeAdapters } from "./zigbee-coordinator-profiles.js";

// The services API on the manager's socket, which only the core reaches. The
// core asks on behalf of an app that holds a `services:<name>` permission:
//
//   GET    /api/services                         every service and its state
//   GET    /api/services/:service                one service
//   PUT    /api/services/:service/apps/:app      the app needs it; returns
//                                                its connection details
//   DELETE /api/services/:service/apps/:app      the app no longer needs it
//   GET    /api/services/zigbee2mqtt/coordinator the coordinators plugged in
//   PUT    /api/services/zigbee2mqtt/coordinator choose one: { path, adapter? }

const params = z.object({ service: z.string(), app: z.string() });
const coordinatorBody = z.object({
  path: z.string().min(1).max(512),
  adapter: z.enum(zigbeeAdapters).optional(),
});

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof UnknownServiceError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof ServiceRequestError) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

export function registerServiceRoutes(
  app: FastifyInstance,
  services: Services | undefined,
) {
  if (!services) {
    const unavailable = async (_request: unknown, reply: FastifyReply) =>
      reply.code(503).send({ error: "This manager supervises no host" });
    app.all("/api/services", unavailable);
    app.all("/api/services/*", unavailable);
    return;
  }

  app.get("/api/services", async () => ({ services: services.list() }));

  app.get<{ Params: { service: string } }>(
    "/api/services/:service",
    async (request, reply) => {
      const service = services
        .list()
        .find((each) => each.name === request.params.service);
      if (!service) {
        return reply.code(404).send({ error: "No such service" });
      }
      return { service };
    },
  );

  app.put("/api/services/:service/apps/:app", async (request, reply) => {
    const { service, app } = params.parse(request.params);
    try {
      return await services.need(service, app);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete("/api/services/:service/apps/:app", async (request, reply) => {
    const { service, app } = params.parse(request.params);
    try {
      await services.release(service, app);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/services/zigbee2mqtt/coordinator", async () =>
    services.zigbeeCoordinators(),
  );

  app.put("/api/services/zigbee2mqtt/coordinator", async (request, reply) => {
    const body = coordinatorBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid coordinator choice" });
    }
    try {
      return await services.chooseZigbeeCoordinator(
        body.data.path,
        body.data.adapter,
      );
    } catch (error) {
      return fail(reply, error);
    }
  });
}
