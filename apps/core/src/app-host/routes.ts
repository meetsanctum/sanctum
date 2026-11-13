import type {
  AppGoBack,
  AppRunning,
  AppInfo,
  AppSettings,
  StaticManifest,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import type { AppHost } from "./host.js";

// The client routes to apps:
//
//   GET  /api/apps                            AppInfo[]: the installed apps,
//                                             for the app overview
//   GET  /api/apps/:appId/manifest            StaticManifest: its
//                                             sanctum-app.json, for its
//                                             settings page
//   POST /api/apps/:appId/actions/:actionId   the body is the action's input;
//                                             the answer is its output
//   GET  /api/apps/:appId/settings            AppSettings: its settings,
//                                             with its schema's defaults
//   POST /api/apps/:appId/settings/update     { [name]: value | null }:
//                                             changes some, null goes back
//                                             to the default; answers
//                                             AppSettings
//   POST /api/apps/:appId/off                 { off }: turns it off or on
//   POST /api/apps/:appId/restart             starts again an app its supervisor
//                                             gave up on
//   GET  /api/apps/:appId/go-back             { to }: what going back from its
//                                             last update would return to, or null
//   POST /api/apps/:appId/go-back             { id }: goes back to the confirmed copy
//   GET  /api/apps/:appId/running             { running }: how one in its own
//                                             container is running now, or null
//   POST /api/apps/:appId/permissions/update  { permission, granted }:
//                                             grants one it asks for or
//                                             takes it away; answers its
//                                             AppInfo, paused while one it
//                                             needs is off. A service
//                                             goes off once the manager has
//                                             taken it back, and the change
//                                             fails as unavailable when it
//                                             cannot
//
// They sit behind Auth's request check like every route that is not public,
// so the host always gets the caller's principal.

const appParams = z.object({ appId: z.string().min(1).max(128) });
const params = appParams.extend({ actionId: z.string().min(1).max(128) });
const turnOff = z.strictObject({ off: z.boolean() });
const confirmedCopy = z.strictObject({ id: z.string().min(1).max(64) });

const grant = z.strictObject({
  permission: z.string().min(1).max(256),
  granted: z.boolean(),
});

function appIdOf(requestParams: unknown) {
  const parsed = appParams.safeParse(requestParams);
  if (!parsed.success) {
    throw new ActionCallError("not_found");
  }
  return parsed.data.appId;
}

export function registerAppRoutes(
  app: FastifyInstance,
  options: { host: AppHost; gate: Gate },
) {
  const { host, gate } = options;

  // The installed apps as clients see them. The origin stays the core's.
  const infos = (): AppInfo[] =>
    host.list().map(({ origin: _origin, ...info }) => info);

  // Which apps the home has is household information, for every client.
  app.get("/api/apps", async (request): Promise<AppInfo[]> => {
    gate.admit(request.principal!, { tier: "read" });
    return infos().sort((a, b) => a.name.localeCompare(b.name));
  });

  // What it is, asks for and brings, with its samples: as public as the
  // package it comes in.
  app.get(
    "/api/apps/:appId/manifest",
    async (request): Promise<StaticManifest> => {
      gate.admit(request.principal!, { tier: "read" });
      const manifest = host.manifest(appIdOf(request.params));
      if (!manifest) {
        throw new ActionCallError("not_found");
      }
      return manifest;
    },
  );

  app.post("/api/apps/:appId/actions/:actionId", async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) {
      throw new ActionCallError("not_found");
    }
    const output = await host.call({
      principal: request.principal!,
      appId: parsed.data.appId,
      actionId: parsed.data.actionId,
      input: request.body === undefined ? {} : request.body,
    });
    // An output may be any JSON value, a bare string included.
    return reply
      .type("application/json; charset=utf-8")
      .send(JSON.stringify(output ?? null));
  });

  // An app's settings are the household's preferences: every client reads
  // and changes them (settings.ts).
  app.get(
    "/api/apps/:appId/settings",
    async (request): Promise<AppSettings> => {
      gate.admit(request.principal!, { tier: "read" });
      return host.settings(appIdOf(request.params));
    },
  );

  app.post(
    "/api/apps/:appId/settings/update",
    async (request): Promise<AppSettings> =>
      host.updateSettings({
        principal: request.principal!,
        appId: appIdOf(request.params),
        changes: request.body,
      }),
  );

  // Turning an app off or on, as its settings do.
  app.post("/api/apps/:appId/off", async (request): Promise<AppInfo> => {
    const appId = appIdOf(request.params);
    const parsed = turnOff.safeParse(request.body);
    if (!parsed.success) {
      throw new ActionCallError("invalid_request");
    }
    host.setOff({ principal: request.principal!, appId, ...parsed.data });
    return infos().find((info) => info.id === appId)!;
  });

  // An app its supervisor gave up on, started again by someone.
  app.post("/api/apps/:appId/restart", async (request): Promise<AppInfo> => {
    const appId = appIdOf(request.params);
    host.restart({ principal: request.principal!, appId });
    return infos().find((info) => info.id === appId)!;
  });

  // How it's running, which its settings ask for while they're open.
  app.get(
    "/api/apps/:appId/running",
    async (request): Promise<{ running: AppRunning | null }> => {
      gate.admit(request.principal!, { tier: "read" });
      return { running: await host.running(appIdOf(request.params)) };
    },
  );

  // Going back from its last update, which its settings offer while they can.
  app.get(
    "/api/apps/:appId/go-back",
    async (request): Promise<{ to: AppGoBack | null }> => {
      gate.admit(request.principal!, { tier: "read" });
      const appId = appIdOf(request.params);
      return { to: await host.goBackOption(appId).catch(() => null) };
    },
  );

  // What it says next arrives as it changes, as any app's does.
  app.post("/api/apps/:appId/go-back", async (request) => {
    const confirmed = confirmedCopy.safeParse(request.body);
    if (!confirmed.success) throw new ActionCallError("invalid_request");
    await host.goBack({
      principal: request.principal!,
      appId: appIdOf(request.params),
      copyId: confirmed.data.id,
    });
    return {};
  });

  // Like its settings, an app's grants are the household's to choose, on
  // every client (grants.ts).
  app.post(
    "/api/apps/:appId/permissions/update",
    async (request): Promise<AppInfo> => {
      const appId = appIdOf(request.params);
      const parsed = grant.safeParse(request.body);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      await host.setPermission({
        principal: request.principal!,
        appId,
        ...parsed.data,
      });
      return infos().find((info) => info.id === appId)!;
    },
  );
}
