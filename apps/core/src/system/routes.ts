import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Gate } from "../app-host/gate.js";
import { changedBy, parseRequest } from "../auth/callers.js";
import type { Power } from "./power.js";
import type { Restores } from "./restore.js";
import type { Space } from "./space.js";
import type { Status } from "./status.js";
import type { Updates } from "./updates.js";

// System's client routes: updates, the last restore, the host's status and
// its last 24 hours, Restart and Shut down, and Free up space, for
// Settings → System and Status. Every client may use them, shared ones too;
// restarting, shutting down and freeing space are destructive, so the gate
// holds them back from anything without a person or a shared client behind
// it. Anyone sees the core's version on /api/health.
//
//   GET  /api/system/status            the host and what needs someone
//   GET  /api/system/history           { points }, each 5 minutes of a day
//   POST /api/system/restart           → 202, and every client hears it
//   POST /api/system/shutdown          → 202, and every client hears it
//   GET  /api/system/space             what Free up space removes and keeps
//   POST /api/system/space/free        { freed }
//   GET  /api/system/update            { version, channel, update }
//   GET  /api/system/update/versions   { channel, versions }
//   POST /api/system/update/start      { version? } → 202 { update }
//   GET  /api/system/restore           { restore }
//   POST /api/system/restore/dismiss   → 204

const start = z.object({ version: z.string().min(1).max(128).optional() });

export function registerSystemRoutes(
  app: FastifyInstance,
  options: {
    updates: Updates;
    restores: Restores;
    status: Status;
    power: Power;
    space: Space;
    gate: Gate;
  },
) {
  const { updates, restores, status, power, space, gate } = options;
  const by = (request: FastifyRequest) => changedBy(request.principal!);
  const destructive = (request: FastifyRequest) =>
    gate.admit(request.principal!, { tier: "destructive" });

  app.get("/api/system/status", async () => status.status());

  app.get("/api/system/history", async () => status.history());

  for (const action of ["restart", "shutdown"] as const) {
    app.post(`/api/system/${action}`, async (request, reply) => {
      destructive(request);
      await power.request(by(request), action);
      return reply.code(202).send({ action });
    });
  }

  app.get("/api/system/space", async () => space.plan());

  app.post("/api/system/space/free", async (request) => {
    destructive(request);
    return space.free(by(request));
  });

  app.get("/api/system/update", async () => updates.status());

  app.get("/api/system/update/versions", async () => updates.versions());

  app.post("/api/system/update/start", async (request, reply) => {
    const { version } = parseRequest(start, request.body ?? {});
    const update = await updates.start(by(request), version);
    return reply.code(202).send({ update });
  });

  app.get("/api/system/restore", async () => ({
    restore: restores.current(),
  }));

  app.post("/api/system/restore/dismiss", async (request, reply) => {
    restores.dismiss(by(request));
    return reply.code(204).send();
  });
}
