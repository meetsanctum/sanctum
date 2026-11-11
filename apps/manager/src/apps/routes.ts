import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  appIdPattern,
  largestMemoryMb,
  packageFolderPattern,
  smallestMemoryMb,
  type AppContainers,
} from "./containers.js";
import {
  defaultImageMb,
  largestImageMb,
  smallestImageMb,
  type AppImages,
} from "./images.js";
import { maintenanceFilePattern, type Maintenance } from "./maintenance.js";
import { OperationConflictError } from "../operations.js";
import { AppRefusal } from "./refusal.js";
import type { AppUpdates } from "./updates.js";
import type { AppUsage } from "./usage.js";

// Apps' containers, on the manager's socket, which only the core reaches:
//
//   GET    /api/capabilities         what this manager can do; one too old for
//                                    this route answers 404, which means nothing
//   GET    /api/apps/containers      every app's container and its state
//   GET    /api/apps/:app/container  one app's
//   PUT    /api/apps/:app/container  start it: { folder, memoryMb }
//   POST   /api/apps/:app/container/stop  stop it, keeping why it stopped
//   DELETE /api/apps/:app/container  remove it, keeping its data
//   GET    /api/apps/:app/usage      what it holds and uses now, for its settings
//   GET    /api/apps/images          every app's image and its state
//   POST   /api/apps/:app/image/grow     make it larger: { dataMb }, while stopped
//   POST   /api/apps/:app/maintenance    { operation, file, name }: copy its
//                                        database, put a copy back while it's
//                                        stopped, or export one file
//   GET    /api/apps/staged              the packages staged for the core's image,
//                                        as { apps: { [id]: { version, folder } } }
//   GET    /api/apps/updates             what's under way, for the core to catch up
//   GET    /api/apps/:app/update/kept    what Go back would return to, if anything
//   POST   /api/apps/:app/update         { id, from, to, file, restores?, moves? }:
//                                        take the slot, stop it and copy its database,
//                                        then put a kept copy in place if it's going
//                                        back, or on its first move take in its file
//   POST   /api/apps/:app/update/:id/commit  it committed, so the slot frees
//   POST   /api/apps/:app/update/:id/undo    put the copy back, then free the slot

const params = z.object({ app: z.string().regex(appIdPattern) });
const startBody = z.object({
  folder: z.string().regex(packageFolderPattern).max(128),
  memoryMb: z.number().int().min(smallestMemoryMb).max(largestMemoryMb),
  dataMb: z.number().int().min(smallestImageMb).max(largestImageMb).optional(),
});
const growBody = z.object({
  dataMb: z.number().int().min(smallestImageMb).max(largestImageMb),
});
const versionRef = z.object({
  version: z.string().min(1).max(128),
  folder: z.string().regex(packageFolderPattern).max(128),
});
const updateBody = z.object({
  id: z.string().regex(maintenanceFilePattern).max(64),
  from: versionRef.partial({ folder: true }),
  to: versionRef,
  file: z.string().regex(maintenanceFilePattern).max(128),
  restores: z.string().regex(maintenanceFilePattern).max(64).optional(),
  moves: z.string().regex(maintenanceFilePattern).max(128).optional(),
  dataMb: z.number().int().min(smallestImageMb).max(largestImageMb).optional(),
});
const updateParams = z.object({
  id: z.string().regex(maintenanceFilePattern).max(64),
});
const maintenanceBody = z.object({
  operation: z.enum(["copy", "restore", "export"]),
  file: z.string().regex(maintenanceFilePattern).max(128),
  name: z.string().regex(maintenanceFilePattern).max(128),
});

function refuse(reply: FastifyReply, error: unknown) {
  if (error instanceof AppRefusal) {
    return reply.code(error.status).send({ error: error.message });
  }
  // Another operation holds the slot: the core tries again.
  if (error instanceof OperationConflictError) {
    return reply.code(409).send({ error: error.message });
  }
  throw error;
}

export function registerAppRoutes(
  app: FastifyInstance,
  apps: AppContainers | undefined,
  images?: AppImages,
  maintenance?: Maintenance,
  updates?: AppUpdates,
  staged?: () => Promise<Record<string, { version: string; folder: string }>>,
  usage?: (app: string) => Promise<AppUsage>,
) {
  app.get("/api/capabilities", async () => {
    if (!apps) return { appContainers: false, memoryLimits: false };
    const [appContainers, memoryLimits] = await Promise.all([
      apps.ready(),
      apps.memoryLimits(),
    ]);
    return { appContainers, memoryLimits };
  });

  app.get("/api/apps/staged", async () => ({
    apps: (await staged?.()) ?? {},
  }));

  if (!apps) {
    const unavailable = async (_request: unknown, reply: FastifyReply) =>
      reply.code(503).send({ error: "This manager supervises no host" });
    app.all("/api/apps/*", unavailable);
    return;
  }

  app.get("/api/apps/containers", async () => ({
    containers: await apps.list(),
  }));

  // Each answers an id it can't use as refused, before it reaches Docker.
  const withApp = (
    handler: (
      id: string,
      body: unknown,
      reply: FastifyReply,
    ) => Promise<unknown>,
  ) => {
    return async (
      request: { params: unknown; body?: unknown },
      reply: FastifyReply,
    ) => {
      const parsed = params.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "That isn't an app's id" });
      }
      try {
        return await handler(parsed.data.app, request.body, reply);
      } catch (error) {
        return refuse(reply, error);
      }
    };
  };

  app.get(
    "/api/apps/:app/container",
    withApp((id) => apps.status(id)),
  );

  app.put(
    "/api/apps/:app/container",
    withApp(async (id, body, reply) => {
      const parsed = startBody.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid container request" });
      }
      return apps.start({ app: id, ...parsed.data });
    }),
  );

  app.post(
    "/api/apps/:app/container/stop",
    withApp((id) => apps.stop(id)),
  );

  app.delete(
    "/api/apps/:app/container",
    withApp(async (id, _body, reply) => {
      await apps.remove(id);
      return reply.code(204).send();
    }),
  );

  if (usage) {
    app.get(
      "/api/apps/:app/usage",
      withApp((id) => usage(id)),
    );
  }

  if (!images || !maintenance) return;

  app.get("/api/apps/images", async () => ({ images: await images.list() }));

  app.post(
    "/api/apps/:app/image/grow",
    withApp(async (id, body, reply) => {
      const parsed = growBody.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid image request" });
      }
      await apps.onItsImage(id, () => images.grow(id, parsed.data.dataMb));
      return reply.code(204).send();
    }),
  );

  app.post(
    "/api/apps/:app/maintenance",
    withApp(async (id, body, reply) => {
      const parsed = maintenanceBody.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid maintenance request" });
      }
      return apps.onItsImage(
        id,
        async (releaseVolume) => {
          if (!(await images.has(id))) {
            throw new AppRefusal(`${id} has no data to work on`, 404);
          }
          const volume = await images.ensure(id, defaultImageMb, releaseVolume);
          return maintenance.run(id, volume, parsed.data);
        },
        // SQLite's backup and reading a file both work beside a running app.
        { whileRunning: parsed.data.operation !== "restore" },
      );
    }),
  );

  if (!updates) return;

  app.get("/api/apps/updates", async () => ({ updates: updates.list() }));

  app.get(
    "/api/apps/:app/update/kept",
    withApp(async (id) => ({ kept: await updates.kept(id) })),
  );

  app.post(
    "/api/apps/:app/update",
    withApp(async (id, body, reply) => {
      const parsed = updateBody.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid update request" });
      }
      return updates.begin(id, parsed.data);
    }),
  );

  // Asked again after it's over, each does nothing.
  const ending =
    (work: (app: string, id: string) => Promise<void>) =>
    async (request: { params: unknown }, reply: FastifyReply) => {
      const app = params.safeParse(request.params);
      const update = updateParams.safeParse(request.params);
      if (!app.success || !update.success) {
        return reply.code(400).send({ error: "Invalid update request" });
      }
      try {
        await work(app.data.app, update.data.id);
        return await reply.code(204).send();
      } catch (error) {
        return refuse(reply, error);
      }
    };
  app.post("/api/apps/:app/update/:id/commit", ending(updates.commit));
  app.post("/api/apps/:app/update/:id/undo", ending(updates.undo));
}
