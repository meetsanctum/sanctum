import cors from "@fastify/cors";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerFactory,
} from "fastify";
import fastifyPlugin from "fastify-plugin";
import { createServer as createHttpsServer, type Server } from "node:https";

import { registerActivityRoutes } from "./activity/routes.js";
import { ActionCallError } from "./app-host/errors.js";
import { registerPageRequests } from "./app-host/page-requests.js";
import { registerAppRoutes } from "./app-host/routes.js";
import { AuthError } from "./auth/errors.js";
import { registerAuth } from "./auth/routes.js";
import type { CoreConfig } from "./config.js";
import { DashboardsError } from "./dashboards/dashboards.js";
import { registerDashboardRoutes } from "./dashboards/routes.js";
import { registerDeviceRoutes } from "./devices/routes.js";
import { registerEntityRoutes } from "./entities/routes.js";
import { registerHistoryRoutes } from "./history/routes.js";
import type { Modules } from "./modules.js";
import { PeopleError } from "./people/people.js";
import { registerPeopleRoutes } from "./people/routes.js";
import { PlacesError } from "./places/places.js";
import { registerPinRoutes } from "./pins/routes.js";
import { registerPlacesRoutes } from "./places/routes.js";
import { registerSystemRoutes } from "./system/routes.js";
import { SystemError } from "./system/errors.js";
import { registerWorkflowRoutes } from "./workflows/routes.js";
import { WorkflowsError } from "./workflows/workflows.js";

// The core's private key and the chain it serves (certificate.ts).
export type CoreHttps = { key: string; cert: string };

export function createServer(
  config: Pick<CoreConfig, "allowedOrigins" | "version">,
  options: Pick<
    Modules,
    | "auth"
    | "people"
    | "system"
    | "places"
    | "dashboards"
    | "pins"
    | "devices"
    | "lights"
    | "pairing"
    | "presses"
    | "firmware"
    | "entities"
    | "history"
    | "gate"
    | "activity"
    | "activityViews"
    | "apps"
    | "workflows"
  > & {
    // True while the manager has not committed the update that started this
    // core (update-pending.ts).
    updatePending?: () => boolean;
    // HTTPS and WSS on the host; none only for `pnpm dev` and tests.
    https?: CoreHttps;
  },
) {
  const updatePending = options.updatePending ?? (() => false);
  const { https } = options;
  // The live WebSocket upgrades on the same server, so it is WSS too.
  const serverFactory: FastifyServerFactory | undefined =
    https && ((handler) => createHttpsServer(https, handler));
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    ...(serverFactory && { serverFactory }),
  });
  const startedAt = Date.now();

  // Clients are not always served by the core (native shells load the UI from
  // their own origin), so listed origins may read the core's responses,
  // refusals included.
  app.register(cors, { origin: config.allowedOrigins });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (
      error instanceof AuthError ||
      error instanceof ActionCallError ||
      error instanceof SystemError
    ) {
      return reply.code(error.status).send({ error: error.code });
    }
    if (error instanceof PeopleError) {
      return reply
        .code(error.code === "last_login" ? 409 : 404)
        .send({ error: error.code });
    }
    if (error instanceof PlacesError) {
      const status = {
        not_found: 404,
        location_unavailable: 502,
        time_zone_needed: 400,
      } as const;
      return reply.code(status[error.code]).send({ error: error.code });
    }
    if (error instanceof DashboardsError) {
      return reply
        .code(error.code === "not_found" ? 404 : 409)
        .send({ error: error.code });
    }
    if (error instanceof WorkflowsError) {
      if (error.code === "invalid_workflow") {
        return reply
          .code(400)
          .send({ error: error.code, problems: error.problems });
      }
      return reply
        .code(error.code === "not_found" ? 404 : 409)
        .send({ error: error.code });
    }
    // Fastify's own refusals, such as a malformed or oversized body.
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "invalid_request" });
    }
    console.error(error);
    return reply.code(500).send({ error: "internal" });
  });

  // Registered after CORS, so its hooks run first and every answer carries
  // its headers.
  app.register(
    fastifyPlugin(async (core) => {
      core.addHook("onRequest", async (request, reply) => {
        if (updatePending() && request.url.split("?")[0] !== "/api/health") {
          return reply
            .code(503)
            .header("retry-after", "5")
            .send({ error: "update_pending" });
        }
      });

      core.get("/api/health", { config: { public: true } }, async () => ({
        service: "core",
        status: "ok",
        version: config.version,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        updatePending: updatePending(),
      }));

      const { auth, people, places, devices, lights, pairing, gate, activity } =
        options;
      await registerAuth(core, { auth, people });
      registerPageRequests(core, { host: options.apps });
      registerPeopleRoutes(core, { people, connections: auth.connections });
      registerSystemRoutes(core, { ...options.system, gate });
      registerPlacesRoutes(core, {
        places,
        devices,
        entities: options.entities,
        apps: options.apps,
        workflows: options.workflows,
      });
      registerDashboardRoutes(core, { dashboards: options.dashboards, gate });
      registerPinRoutes(core, { pins: options.pins, gate });
      registerDeviceRoutes(core, {
        devices,
        lights,
        pairing,
        presses: options.presses,
        firmware: options.firmware,
        gate,
        activity,
      });
      registerEntityRoutes(core, { entities: options.entities, gate });
      registerHistoryRoutes(core, { history: options.history, gate });
      registerActivityRoutes(core, {
        activity,
        views: options.activityViews,
        gate,
      });
      registerAppRoutes(core, { host: options.apps, gate });
      registerWorkflowRoutes(core, { workflows: options.workflows, gate });
    }),
  );

  return app;
}

// Swaps in a renewed certificate: new connections get it, and open ones,
// WebSockets included, carry on.
export function renewCertificate(app: FastifyInstance, next: CoreHttps) {
  // An HTTPS server whenever the core was created with `https`.
  (app.server as unknown as Server).setSecureContext(next);
}
