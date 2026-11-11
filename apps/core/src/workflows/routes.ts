import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Gate } from "../app-host/gate.js";
import { parseRequest } from "../auth/callers.js";
import {
  newWorkflow,
  workflowChanges,
  workflowRef,
  workflowRules,
  type WorkflowChangedBy,
  type Workflows,
} from "./workflows.js";

// Workflows' client routes, for the Automations app. Automations belong to
// the whole household, so they pass the permission gate as the person or
// shared client behind the request with workflowRules: every person,
// children and guests too, and every shared client reads, adds, changes,
// removes and runs them; widget tokens may not. A run by hand on a shared
// client has no person behind it and keeps the client's name. Like the other
// modules' routes they use GET and POST only.
//
//   GET  /api/workflows                     WorkflowInfo[]
//   GET  /api/workflows/pieces              PieceInfo[]
//   GET  /api/workflows/runs?workflow=<id>  WorkflowRunInfo[], newest first
//   POST /api/workflows/add                 { name, enabled?, runMode?, graph }
//   POST /api/workflows/update              { id, name?, enabled?, runMode?, graph? }
//   POST /api/workflows/remove              { id }
//   POST /api/workflows/run                 { id }: the run, as it started
//
// A graph that is not whole is refused as invalid_workflow, with its
// problems: { node, field, message }[].

const runsQuery = z.object({ workflow: z.string().min(1).max(64) });

export function registerWorkflowRoutes(
  app: FastifyInstance,
  options: { workflows: Workflows; gate: Gate },
) {
  const { workflows, gate } = options;

  const read = (request: FastifyRequest) =>
    gate.admit(request.principal!, workflowRules.read);

  function changedBy(request: FastifyRequest): WorkflowChangedBy {
    const principal = request.principal!;
    gate.admit(principal, workflowRules.change);
    return { personId: principal.person?.id, clientId: principal.client.id };
  }

  app.get("/api/workflows", async (request) => {
    read(request);
    return workflows.list();
  });

  app.get("/api/workflows/pieces", async (request) => {
    read(request);
    return workflows.pieces();
  });

  app.get("/api/workflows/runs", async (request) => {
    read(request);
    return workflows.runs(parseRequest(runsQuery, request.query).workflow);
  });

  app.post("/api/workflows/add", async (request) =>
    workflows.add(changedBy(request), parseRequest(newWorkflow, request.body)),
  );

  app.post("/api/workflows/update", async (request) =>
    workflows.update(
      changedBy(request),
      parseRequest(workflowChanges, request.body),
    ),
  );

  app.post("/api/workflows/remove", async (request, reply) => {
    workflows.remove(
      changedBy(request),
      parseRequest(workflowRef, request.body),
    );
    return reply.code(204).send();
  });

  app.post("/api/workflows/run", async (request) =>
    workflows.runByHand(
      { ...changedBy(request), clientName: request.principal!.client.name },
      parseRequest(workflowRef, request.body),
    ),
  );
}
