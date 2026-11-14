import Fastify from "fastify";
import { z } from "zod";

import { registerAppRoutes } from "./apps/routes.js";
import type { AppUsage } from "./apps/usage.js";
import type { AppContainers } from "./apps/containers.js";
import type { AppImages } from "./apps/images.js";
import type { Maintenance } from "./apps/maintenance.js";
import type { AppUpdates } from "./apps/updates.js";
import type { Audit } from "./audit.js";
import { mdnsService, type Discovery } from "./discovery.js";
import type { HostAuthority } from "./certificates/host-ca.js";
import { registerCertificateRoutes } from "./certificates/routes.js";
import type { ManagerConfig } from "./config.js";
import type { DockerClientLike } from "./docker.js";
import type { HostHistory } from "./host/history.js";
import { PowerConflictError, type Power } from "./host/power.js";
import { SpaceConflictError, type Space } from "./host/space.js";
import type { HostStatusReporter } from "./host/status.js";
import { ReleaseError } from "./release.js";
import { registerServiceRoutes } from "./services/routes.js";
import type { Services } from "./services/services.js";
import { UpdateConflictError, type UpdateService } from "./update/service.js";
import { RegistryError } from "./update/registry.js";
import type { VersionList } from "./update/versions.js";

const updateBody = z
  .object({ version: z.string().min(1).max(128).optional() })
  .default({});
const auditQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
});
// The core's question about what is on the home's network: what changed
// after its last answer, for the services apps look for.
const discoveryQuery = z.object({
  after: z.string().max(100).optional(),
  services: z
    .string()
    .max(4_000)
    .default("")
    .transform((list) => (list ? list.split(",") : []))
    .pipe(z.array(z.string().regex(mdnsService)).max(64)),
});
const claimedBody = z.object({
  claimed: z.boolean(),
  homeId: z.string().regex(/^[0-9A-Za-z-]{8,64}$/),
});

export type ServerOptions = {
  // Present when the manager supervises the host.
  host?: {
    docker: DockerClientLike;
    updates: UpdateService;
    versions?: VersionList;
    isReady?: () => boolean;
    services?: Services;
    // Apps' containers (apps/containers.ts), the images with their data
    // (apps/images.ts) and what works on them (apps/maintenance.ts).
    apps?: AppContainers;
    images?: AppImages;
    maintenance?: Maintenance;
    appUpdates?: AppUpdates;
    // The apps' packages staged for the core's image.
    stagedApps?: () => Promise<
      Record<string, { version: string; folder: string }>
    >;
    // What each app holds and uses now (apps/usage.ts).
    appUsage?: (app: string) => Promise<AppUsage>;
    // Restart and Shut down (host/power.ts).
    power?: Power;
    // Free up space (host/space.ts).
    space?: Space;
  };
  // Keeps and announces the home's id and whether the host is claimed.
  setClaimed?: (report: z.output<typeof claimedBody>) => Promise<void>;
  // The host's id, which the core binds sign-ins to.
  hostId?: string;
  // The host CA, which signs the core's certificates.
  authority?: HostAuthority;
  // Whether the host's clock is synchronised (certificates/clock.ts).
  clock?: () => Promise<boolean | null>;
  // What the manager did on its own, which the core copies (audit.ts).
  audit?: Audit;
  // The host's status, for Settings → Status (host/status.ts).
  status?: Pick<HostStatusReporter, "status">;
  // The host's last 24 hours (host/history.ts).
  history?: Pick<HostHistory, "points">;
  // What apps look for on the home's network (discovery.ts).
  discovery?: Pick<Discovery, "poll">;
};

export function createServer(
  config: Pick<ManagerConfig, "version">,
  options: ServerOptions = {},
) {
  const { host, setClaimed, hostId, authority } = options;
  const clock = options.clock ?? (async () => null);
  const app = Fastify({
    logger: false,
    // Service routes accept app ids up to 128 characters.
    routerOptions: { maxParamLength: 128 },
  });
  const startedAt = Date.now();

  app.get("/api/health", async (_request, reply) => {
    const health = {
      service: "manager",
      status: "ok",
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
    if (!host) {
      return health;
    }
    // A manager that cannot reach Docker cannot do its job, so an update that
    // brings one up rolls back.
    const docker = await Promise.race([
      host.docker.ping().then(() => "ok" as const),
      new Promise<"unreachable">((resolve) =>
        setTimeout(() => resolve("unreachable"), 2_000).unref(),
      ),
    ]).catch(() => "unreachable" as const);
    if (docker !== "ok") {
      reply.code(503);
      return { ...health, status: "error", docker };
    }
    return { ...health, docker };
  });

  app.get("/api/update", async (_request, reply) => {
    if (!host) {
      return reply.code(503).send({ error: "This manager supervises no host" });
    }
    return {
      channel: host.updates.channel,
      update: await host.updates.status(),
    };
  });

  // What the host can update to: its channel, or on a dev host the builds in
  // its registry (update/versions.ts).
  app.get("/api/update/versions", async (_request, reply) => {
    if (!host?.versions) {
      return reply.code(503).send({ error: "This manager supervises no host" });
    }
    try {
      return await host.versions.list();
    } catch (error) {
      if (error instanceof RegistryError) {
        return reply.code(502).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/update", async (request, reply) => {
    if (!host) {
      return reply.code(503).send({ error: "This manager supervises no host" });
    }
    if (host.isReady && !host.isReady()) {
      return reply
        .code(503)
        .send({ error: "The manager is recovering the host" });
    }
    const body = updateBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid update request" });
    }
    // Freeing space removes images an update has pulled but not run yet.
    if (host.space?.freeing()) {
      return reply.code(409).send({ error: "Space is being freed" });
    }
    if (host.power?.asked()) {
      return reply.code(409).send({ error: "A power request is pending" });
    }
    try {
      const update = await host.updates.start(body.data.version);
      return reply.code(202).send({ update });
    } catch (error) {
      if (error instanceof ReleaseError) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof UpdateConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  // The core asks what the manager did after an entry of its audit, and
  // copies it into the activity log. An update that has ended is recorded
  // first, whichever process finished it.
  app.get("/api/audit", async (request, reply) => {
    if (!options.audit) {
      return reply.code(503).send({ error: "This manager keeps no audit" });
    }
    const query = auditQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid audit request" });
    }
    // An update's status that cannot be read now is recorded once it can;
    // the entries kept meanwhile are answered all the same.
    if (host) {
      await host.updates
        .status()
        .then((journal) => options.audit!.updateEnded(journal))
        .catch(() => undefined);
    }
    return options.audit.after(query.data.after);
  });

  registerServiceRoutes(app, host?.services);
  registerAppRoutes(
    app,
    host?.apps,
    host?.images,
    host?.maintenance,
    host?.appUpdates,
    host?.stagedApps,
    host?.appUsage,
    options.discovery !== undefined,
  );
  registerCertificateRoutes(app, authority, clock);

  // The core asks for the host's id, which the manager keeps and announces,
  // so a sign-in proves the same host the apps found.
  app.get("/api/host", async (_request, reply) => {
    if (!hostId) {
      return reply.code(503).send({ error: "This manager announces no host" });
    }
    return { id: hostId };
  });

  // What the host is and how it is doing: its model and system, memory,
  // storage, processor, power and network, and its services.
  app.get("/api/host/status", async (_request, reply) => {
    if (!options.status) {
      return reply.code(503).send({ error: "This manager reports no host" });
    }
    return options.status.status();
  });

  // How busy, how warm and how full of memory the host was in each 5
  // minutes of the last 24 hours.
  app.get("/api/host/history", async (_request, reply) => {
    if (!options.history) {
      return reply.code(503).send({ error: "This manager reports no host" });
    }
    return { points: options.history.points() };
  });

  // What is on the home's network of the services apps look for: what
  // changed after the core's last answer, waiting up to 30 s for news.
  app.get("/api/discovery", async (request, reply) => {
    if (!options.discovery) {
      return reply
        .code(503)
        .send({ error: "This manager doesn't look for devices" });
    }
    const query = discoveryQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "That isn't a question it takes" });
    }
    return options.discovery.poll(
      query.data.after ?? null,
      query.data.services,
    );
  });

  // Restarts or shuts down the host, a moment after answering.
  for (const action of ["restart", "shutdown"] as const) {
    app.post(`/api/host/${action}`, async (_request, reply) => {
      if (!host?.power) {
        return reply
          .code(503)
          .send({ error: "This manager supervises no host" });
      }
      try {
        await host.power.request(action);
      } catch (error) {
        if (error instanceof PowerConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
      return reply.code(202).send({ action });
    });
  }

  // What Free up space would remove and keep, and doing it.
  app.get("/api/host/space", async (_request, reply) => {
    if (!host?.space) {
      return reply.code(503).send({ error: "This manager supervises no host" });
    }
    try {
      return await host.space.plan();
    } catch (error) {
      if (error instanceof RegistryError) {
        return reply.code(502).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/host/space/free", async (_request, reply) => {
    if (!host?.space) {
      return reply.code(503).send({ error: "This manager supervises no host" });
    }
    if (host.power?.asked()) {
      return reply.code(409).send({ error: "A power request is pending" });
    }
    try {
      return await host.space.free();
    } catch (error) {
      if (error instanceof SpaceConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof RegistryError) {
        return reply.code(502).send({ error: error.message });
      }
      throw error;
    }
  });

  // The core reports the home's id and whether the host is claimed, which
  // only it knows, so the manager can announce them.
  app.put("/api/claimed", async (request, reply) => {
    if (!setClaimed) {
      return reply.code(503).send({ error: "This manager announces no host" });
    }
    const body = claimedBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid claimed state" });
    }
    await setClaimed(body.data);
    return reply.code(204).send();
  });

  return app;
}
