import {
  assistantPromptSchema,
  type AppGoBack,
  type AppRunning,
  type AppInfo,
  type AppSettings,
  type AppRemoval,
  type AvailableApp,
  type HardwareOffer,
  type Language,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Auth } from "../auth/auth.js";
import { AuthError } from "../auth/errors.js";
import { bearerToken } from "../auth/tokens.js";
import type { AppAdding } from "./adding.js";
import type { AppDeleting } from "./deleting.js";
import type { HardwareOffers } from "./hardware-offers.js";
import type { AppRemoving } from "./removing.js";
import type { AvailableApps } from "./available.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import type { AppHost } from "./host.js";

// The client routes to apps:
//
//   GET  /api/apps                            AppInfo[]: the installed apps,
//                                             for the app overview
//   GET  /api/apps/available                  AvailableApp[]: the apps
//                                             Sanctum brings that the home
//                                             hasn't added, each with what
//                                             keeps it from being added now
//   POST /api/apps/add                        { id, version, offerId? }: adds one of
//                                             those at the version its sheet
//                                             showed, and answers its
//                                             AppInfo once it's installed;
//                                             refused as a conflict once it's
//                                             added, another version is
//                                             there or its offer has ended,
//                                             and as unavailable while
//                                             something keeps it from being
//                                             added
//   GET  /api/apps/:appId/removal             AppRemoval: what removing it
//                                             takes from the home, for its
//                                             dialog
//   POST /api/apps/:appId/remove              removes it, but a system app
//                                             (forbidden), and not while it
//                                             updates or goes back (conflict)
//   GET  /api/hardware/offer                  { offer }: the app a Zigbee
//                                             stick plugged in offers, or null
//   POST /api/hardware/offer/dismiss          { id }: no to it, on every
//                                             client; conflict once it ended
//   POST /api/apps/:appId/data/delete         deletes a removed app's data
//                                             now; refused (conflict) while
//                                             its removal is under way or
//                                             it's added again, and
//                                             unavailable with a manager
//                                             that can't
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
//   POST /api/apps/:appId/update/allow        { id }: allows the version that
//                                             waits (AppInfo.waiting), granting
//                                             what it newly needs and starting
//                                             its update; conflict for another id
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

const askBody = assistantPromptSchema.partial({ language: true });
const params = appParams.extend({ actionId: z.string().min(1).max(128) });
const turnOff = z.strictObject({ off: z.boolean() });
const confirmedId = z.string().min(1).max(64);
const confirmation = z.strictObject({ id: confirmedId });
const toAdd = z.strictObject({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  offerId: confirmedId.optional(),
});

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
  options: {
    host: AppHost;
    available: AvailableApps;
    adding: AppAdding;
    removing: AppRemoving;
    deleting: AppDeleting;
    offers: HardwareOffers;
    gate: Gate;
    authenticate: Auth["authenticate"];
    // The home's language for speech, which typed requests are in unless
    // they say otherwise.
    language: () => Language;
  },
) {
  const { host, available, adding, removing, deleting, offers, gate } = options;

  // The installed apps as clients see them. The origin stays the core's.
  const infos = (): AppInfo[] =>
    host.list().map(({ origin: _origin, ...info }) => info);

  // Which apps the home has is household information, for every client. The
  // core serves before its apps' packages are staged, which takes a while
  // after an update: until they are installed it refuses, since an empty
  // list would say the home has none, and a client asks again.
  app.get("/api/apps", async (request): Promise<AppInfo[]> => {
    gate.admit(request.principal!, { tier: "read" });
    if (!host.hasInstalled()) throw new ActionCallError("unavailable");
    return infos().sort((a, b) => a.name.localeCompare(b.name));
  });

  // Which apps the home could add is household information too.
  app.get("/api/apps/available", async (request): Promise<AvailableApp[]> => {
    gate.admit(request.principal!, { tier: "read" });
    return available.list();
  });

  // Adding one is the household's to choose, like its grants, on every
  // client. Return its current state so the client can show it immediately.
  app.post("/api/apps/add", async (request): Promise<AppInfo> => {
    const parsed = toAdd.safeParse(request.body);
    if (!parsed.success) throw new ActionCallError("invalid_request");
    const { id, version, offerId } = parsed.data;
    return adding.add(request.principal!, id, version, offerId);
  });

  // What removing it takes, which its dialog names first.
  app.get("/api/apps/:appId/removal", async (request): Promise<AppRemoval> => {
    gate.admit(request.principal!, { tier: "read" });
    return removing.removal(appIdOf(request.params));
  });

  // Removing it is the household's to choose, like adding it. Every client
  // hears it's gone as it is.
  app.post("/api/apps/:appId/remove", async (request) => {
    await removing.remove(request.principal!, appIdOf(request.params));
    return {};
  });

  // A Zigbee stick plugged in offers its app on every client, and an answer
  // on any of them ends it: Add through POST /api/apps/add, no here.
  app.get(
    "/api/hardware/offer",
    async (request): Promise<{ offer: HardwareOffer | null }> => {
      gate.admit(request.principal!, { tier: "read" });
      return { offer: offers.current() };
    },
  );

  app.post("/api/hardware/offer/dismiss", async (request) => {
    const named = confirmation.safeParse(request.body);
    if (!named.success) throw new ActionCallError("invalid_request");
    await offers.dismiss(request.principal!, named.data.id);
    return {};
  });

  // Deleting a removed app's data at once, rather than after its 30 days:
  // the household's to choose, like removing it.
  app.post("/api/apps/:appId/data/delete", async (request) => {
    await deleting.deleteNow(request.principal!, appIdOf(request.params));
    return {};
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
      caller: request.principal!,
      appId: parsed.data.appId,
      actionId: parsed.data.actionId,
      input: request.body === undefined ? {} : request.body,
    });
    // An output may be any JSON value, a bare string included.
    return reply
      .type("application/json; charset=utf-8")
      .send(JSON.stringify(output ?? null));
  });

  // Someone's typed request, for Sanctum's Assistant: a person's or a shared
  // device's, never an AI agent's or a widget's. It answers with the reply,
  // or null when the Assistant gave none, once the Assistant replies.
  app.post("/api/assistant/ask", async (request) => {
    const principal = request.principal!;
    if (principal.scope !== "full") {
      throw new ActionCallError("forbidden");
    }
    const parsed = askBody.safeParse(request.body);
    if (!parsed.success) {
      throw new ActionCallError("invalid_request");
    }
    const actor = gate.admit(principal, { tier: "write" });
    if (actor.kind !== "user" && actor.kind !== "client") {
      throw new ActionCallError("forbidden");
    }
    const token = bearerToken(request.headers.authorization);
    const reply = await host.ask({
      actor,
      key: principal.client.id,
      who: { personId: principal.person?.id, clientId: principal.client.id },
      asked: {
        text: parsed.data.text,
        language: parsed.data.language ?? options.language(),
        room: null,
        from: { kind: "client", name: principal.client.name },
      },
      check() {
        if (
          !token ||
          options.authenticate(token)?.client.id !== principal.client.id
        ) {
          throw new AuthError("invalid_client_token");
        }
      },
    });
    return { reply: reply?.text ?? null };
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
    const confirmed = confirmation.safeParse(request.body);
    if (!confirmed.success) throw new ActionCallError("invalid_request");
    await host.goBack({
      principal: request.principal!,
      appId: appIdOf(request.params),
      copyId: confirmed.data.id,
    });
    return {};
  });

  // A newer version that waits for what it newly needs, as its Review sheet
  // showed it. What it says next arrives as it changes.
  app.post("/api/apps/:appId/update/allow", async (request) => {
    const named = confirmation.safeParse(request.body);
    if (!named.success) throw new ActionCallError("invalid_request");
    await host.allowUpdate({
      principal: request.principal!,
      appId: appIdOf(request.params),
      id: named.data.id,
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
