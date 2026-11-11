import {
  placesReadPermission,
  type DeviceInfo,
  type EntityInfo,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { viewOf } from "../devices/views.js";
import { deviceKinds, entityTypes } from "./calls.js";
import { ActionCallError } from "./errors.js";
import type { AppHost } from "./host.js";

// A request from an app's page names its app: the shell's bridge sends the
// app's id in a header, and the core answers with what both the client and
// the app may see, so a page can't see more than its app even by mistake. A
// page reaches only the routes an app's client uses, and its own app's
// actions and settings; the routes it reads, places, devices and entities,
// and the commands it sends, keep to the app's grants as they are now. A
// request without the header is the shell's own.

/** The header the shell's bridge names an app's page's requests with. */
export const appHeader = "x-sanctum-app";

/** The app a page's request is for, with what it holds now. */
export type PageApp = { app: string; granted: readonly string[] };

// The routes an app's client uses (ui-sdk's client.ts), besides its own
// app's actions and settings.
const pageRoutes = new Set([
  "GET /api/places",
  "GET /api/devices",
  "GET /api/entities",
  "POST /api/devices/command",
  "POST /api/devices/lights",
  "POST /api/devices/capture/start",
  "POST /api/devices/capture/stop",
]);
const ownRoutes = new Set([
  "POST /api/apps/:appId/actions/:actionId",
  "GET /api/apps/:appId/settings",
]);

// Whether an app's page may reach a route at all.
function pageMayReach(request: FastifyRequest, app: string) {
  const route = `${request.method} ${request.routeOptions.url ?? ""}`;
  if (pageRoutes.has(route)) return true;
  const { appId } = (request.params ?? {}) as { appId?: unknown };
  return ownRoutes.has(route) && appId === app;
}

declare module "fastify" {
  interface FastifyRequest {
    pageApp: PageApp | null;
  }
}

/**
 * Reads the app each request names, after Auth: one that is not installed
 * is refused, as its page would have nothing to ask for.
 */
export function registerPageRequests(
  app: FastifyInstance,
  options: { host: Pick<AppHost, "holds"> },
) {
  app.decorateRequest("pageApp", null);
  app.addHook("preHandler", async (request) => {
    const named = request.headers[appHeader];
    if (named === undefined) return;
    const holding =
      typeof named === "string" ? options.host.holds(named) : null;
    if (!holding) {
      throw new ActionCallError("not_found");
    }
    if (!pageMayReach(request, holding.app)) {
      throw new ActionCallError("forbidden");
    }
    request.pageApp = holding;
  });
}

/** Refuses an app's page what its app does not hold. */
export function needFromPage(request: FastifyRequest, permission: string) {
  if (request.pageApp && !request.pageApp.granted.includes(permission)) {
    throw new ActionCallError("forbidden");
  }
}

/** Places, which an app's page reads only with `places.read`. */
export function placesForPage(request: FastifyRequest) {
  needFromPage(request, placesReadPermission);
}

/** The devices as an app's page may see them: only the kinds its app reads. */
export function devicesForPage(
  request: FastifyRequest,
  devices: readonly DeviceInfo[],
): DeviceInfo[] {
  const page = request.pageApp;
  if (!page) return [...devices];
  const kinds = deviceKinds(page.granted).reads;
  return devices.flatMap((device) => viewOf(device, { kinds }) ?? []);
}

/** A command from an app's page, which needs its app to control the kind. */
export function commandFromPage(
  request: FastifyRequest,
  kind: DeviceInfo["capabilities"][number]["kind"] | undefined,
) {
  const page = request.pageApp;
  if (page && (!kind || !deviceKinds(page.granted).controls.has(kind))) {
    throw new ActionCallError("forbidden");
  }
}

/** The entities an app's page may see: its app's own, and the standard types it reads. */
export function entitiesForPage(
  request: FastifyRequest,
  entities: readonly EntityInfo[],
): EntityInfo[] {
  const page = request.pageApp;
  if (!page) return [...entities];
  const types = new Set(entityTypes(page.granted));
  return entities.filter(
    (entity) => entity.app === page.app || types.has(entity.type),
  );
}
