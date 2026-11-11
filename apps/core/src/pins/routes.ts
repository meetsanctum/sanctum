import type { FastifyInstance } from "fastify";

import type { Gate } from "../app-host/gate.js";
import { parseRequest } from "../auth/callers.js";
import { pinRules, pinsUpdate, type Pins } from "./pins.js";

// Pins' client routes. They pass the permission gate as the person or shared
// client behind the request, with pinRules, so every client may read and
// change the household's pinned apps; widget tokens may not. Their shapes
// are in @meetsanctum/app-sdk (pins.ts). Like Dashboards' routes they use
// GET and POST only.
//
//   GET  /api/pins         the pinned apps' ids, in their order
//   POST /api/pins/update  { apps }, the whole list → the list as stored

export function registerPinRoutes(
  app: FastifyInstance,
  options: { pins: Pins; gate: Gate },
) {
  const { pins, gate } = options;

  app.get("/api/pins", async (request): Promise<string[]> => {
    gate.admit(request.principal!, pinRules.read);
    return pins.list();
  });

  app.post("/api/pins/update", async (request): Promise<string[]> => {
    gate.admit(request.principal!, pinRules.change);
    return pins.update(parseRequest(pinsUpdate, request.body));
  });
}
