import type { DashboardInfo } from "@meetsanctum/app-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Gate } from "../app-host/gate.js";
import { parseRequest } from "../auth/callers.js";
import {
  dashboardChanges,
  dashboardRules,
  homeDevice,
  homeOrder,
  newDashboard,
  removal,
  type DashboardChangedBy,
  type Dashboards,
} from "./dashboards.js";

// Dashboards' client routes. They pass the permission gate as the person or
// shared client behind the request, with dashboardRules, so every client may
// read and change the home's dashboards and what is on Home; widget tokens
// may not. Their shapes are in @meetsanctum/app-sdk (dashboards.ts). Like
// Places' routes they use GET and POST only.
//
//   GET  /api/dashboards              DashboardInfo[], Home first
//   POST /api/dashboards/add          { name, background? } → DashboardInfo
//   POST /api/dashboards/update       { id, name } → DashboardInfo
//   POST /api/dashboards/remove       { id }; refused for Home
//   POST /api/dashboards/home/add     { device } → Home's DashboardInfo
//   POST /api/dashboards/home/remove  { device } → Home's DashboardInfo
//   POST /api/dashboards/home/order   { devices } → Home's DashboardInfo

export function registerDashboardRoutes(
  app: FastifyInstance,
  options: { dashboards: Dashboards; gate: Gate },
) {
  const { dashboards, gate } = options;

  function changedBy(request: FastifyRequest): DashboardChangedBy {
    const principal = request.principal!;
    gate.admit(principal, dashboardRules.change);
    return { personId: principal.person?.id, clientId: principal.client.id };
  }

  app.get("/api/dashboards", async (request): Promise<DashboardInfo[]> => {
    gate.admit(request.principal!, dashboardRules.read);
    return dashboards.list();
  });

  app.post("/api/dashboards/add", async (request) =>
    dashboards.add(
      changedBy(request),
      parseRequest(newDashboard, request.body),
    ),
  );
  app.post("/api/dashboards/update", async (request) =>
    dashboards.update(
      changedBy(request),
      parseRequest(dashboardChanges, request.body),
    ),
  );
  app.post("/api/dashboards/remove", async (request, reply) => {
    dashboards.remove(changedBy(request), parseRequest(removal, request.body));
    return reply.code(204).send();
  });

  app.post("/api/dashboards/home/add", async (request) =>
    dashboards.addToHome(
      changedBy(request),
      parseRequest(homeDevice, request.body),
    ),
  );
  app.post("/api/dashboards/home/remove", async (request) =>
    dashboards.removeFromHome(
      changedBy(request),
      parseRequest(homeDevice, request.body),
    ),
  );
  app.post("/api/dashboards/home/order", async (request) =>
    dashboards.orderHome(
      changedBy(request),
      parseRequest(homeOrder, request.body),
    ),
  );
}
