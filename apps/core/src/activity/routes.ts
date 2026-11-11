import { activityKinds, type ActivityPage } from "@meetsanctum/app-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Gate } from "../app-host/gate.js";
import { parseRequest } from "../auth/callers.js";
import type { Activity } from "./activity.js";
import type { ActivityViews } from "./views.js";

// The activity log's client route: newest first, 50 at a time unless asked,
// about one device or of one kind, older than an entry's id. Every client
// reads all of it, shared ones too, the same for everyone.
//
//   GET /api/activity?device=&kind=&before=&limit=   ActivityPage

export const activityQuery = z.object({
  device: z.string().min(1).max(64).optional(),
  kind: z.enum(activityKinds).optional(),
  before: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerActivityRoutes(
  app: FastifyInstance,
  options: { activity: Activity; views: ActivityViews; gate: Gate },
) {
  const { activity, views, gate } = options;

  app.get("/api/activity", async (request): Promise<ActivityPage> => {
    gate.admit(request.principal!, { tier: "read" });
    const query = parseRequest(activityQuery, request.query);
    const page = activity.page({
      subjectId: query.device,
      kind: query.kind,
      before: query.before,
      limit: query.limit,
    });
    return { entries: page.entries.map(views.info), more: page.more };
  });
}
