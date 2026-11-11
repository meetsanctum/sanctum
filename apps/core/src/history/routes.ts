import type {
  DeviceHistory,
  DeviceStatistics,
  HistoryKept,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Gate } from "../app-host/gate.js";
import { changedBy, parseRequest } from "../auth/callers.js";
import type { View } from "../devices/views.js";
import {
  keepRequest,
  statesQuery,
  statisticsQuery,
  type History,
} from "./history.js";

// History's client routes: a device's history for every client, shared ones
// included, since it names no one. `from` and `to` are ISO times, a day
// until now unless asked: at most the 10 days kept for changes, two days of
// 5-minute roll-ups or a month of hourly ones. Every client chooses whether
// a device's history is kept.
//
//   GET  /api/history/states?device=&capability=&from=&to=           DeviceHistory
//   GET  /api/history/statistics?device=&capability=&period=&from=&to=  DeviceStatistics
//   GET  /api/history/devices          HistoryKept[]
//   POST /api/history/keep             { device, kept } → HistoryKept

export function registerHistoryRoutes(
  app: FastifyInstance,
  options: { history: History; gate: Gate },
) {
  const { history, gate } = options;

  // Every device, for every client.
  const viewFor = (request: FastifyRequest): View => {
    gate.admit(request.principal!, { tier: "read" });
    return {};
  };

  app.get("/api/history/states", async (request): Promise<DeviceHistory> =>
    history.states(viewFor(request), parseRequest(statesQuery, request.query)),
  );

  app.get(
    "/api/history/statistics",
    async (request): Promise<DeviceStatistics> =>
      history.statistics(
        viewFor(request),
        parseRequest(statisticsQuery, request.query),
      ),
  );

  app.get("/api/history/devices", async (request): Promise<HistoryKept[]> =>
    history.kept(viewFor(request)),
  );

  app.post("/api/history/keep", async (request): Promise<HistoryKept> =>
    history.keep(
      changedBy(request.principal!),
      parseRequest(keepRequest, request.body),
    ),
  );
}
