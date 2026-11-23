import { sightingLostSchema, sightingSchema } from "@meetsanctum/app-sdk";
import type { HostResources } from "@meetsanctum/app-sdk";
import { z } from "zod";

// What the manager answers the core, in the shapes the core checks every
// answer against: an answer that doesn't fit is one the core can't take.

export const hostBody = z.object({ id: z.string().min(1).max(64) });

// The core's certificate and the host CA's, as PEM.
export const signedCertificate = z.object({
  certificate: z.string().min(1),
  ca: z.string().min(1),
});

export const channel = z.enum(["stable", "edge", "dev"]);
export type Channel = z.infer<typeof channel>;

// The manager's update journal (apps/manager/src/update/journal.ts), the
// parts the core passes on: where the update is and how it ended. Container
// ids, images and backup paths stay with the manager.
export const updateStep = z.object({
  status: z.string(),
  fromVersion: z.string().optional(),
});
export const updateJournal = z.object({
  id: z.string(),
  version: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  phase: z.enum(["pulling", "core", "manager", "done"]),
  outcome: z.enum(["updated", "unchanged", "rolled-back", "failed"]).optional(),
  error: z.string().optional(),
  core: updateStep,
  manager: updateStep,
  log: z.array(z.object({ at: z.string(), message: z.string() })),
});
export type UpdateJournal = z.infer<typeof updateJournal>;

export const updateStatus = z.object({
  channel,
  update: updateJournal.nullable(),
});
export const startedUpdate = z.object({ update: updateJournal });
// The manager's audit (apps/manager/src/audit.ts): its id, and its entries
// after the number asked.
export const managerAudit = z.object({
  audit: z.string().min(1).max(64),
  entries: z.array(
    z.object({
      n: z.number().int().positive(),
      at: z.string(),
      action: z.string().min(1).max(64),
      outcome: z.enum(["ok", "refused", "failed"]),
      reason: z.string().nullable().optional(),
      detail: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  ),
});
export const versionList = z.object({
  channel,
  versions: z.array(
    z.object({ version: z.string(), builtAt: z.string().optional() }),
  ),
});
export type VersionList = z.infer<typeof versionList>;

// The host's status (apps/manager/src/host/status.ts), for Settings →
// Status. Sizes and memory are in bytes.
export const hostStatus = z.object({
  channel,
  model: z.string().nullable(),
  os: z.string().nullable(),
  architecture: z.string().nullable(),
  uptimeSeconds: z.number().nullable(),
  hostname: z.string().nullable(),
  // An older manager doesn't say.
  memoryLimits: z.boolean().nullable().optional(),
  memory: z
    .object({
      total: z.number(),
      available: z.number(),
      swapTotal: z.number(),
      swapFree: z.number(),
      containers: z.array(
        z.object({
          role: z.enum(["core", "app", "manager", "service", "registry"]),
          service: z.string().optional(),
          // Which apps a service is for. An older manager doesn't say.
          apps: z.array(z.string()).optional(),
          app: z.string().optional(),
          bytes: z.number(),
        }),
      ),
    })
    .nullable(),
  storage: z
    .object({
      total: z.number(),
      free: z.number(),
      software: z.number().nullable(),
      devBuilds: z.number().nullable(),
      backups: z.number().nullable(),
      services: z.array(
        z.object({
          service: z.string(),
          apps: z.array(z.string()),
          bytes: z.number(),
        }),
      ),
      // An older manager has none.
      images: z
        .array(
          z.object({
            app: z.string(),
            state: z.enum(["ok", "missing", "damaged"]),
            sizeMb: z.number(),
            bytes: z.number(),
          }),
        )
        .optional(),
    })
    .nullable(),
  processor: z.object({
    // An older manager says neither.
    name: z.string().nullable().optional(),
    cores: z.number(),
    matrixInstructions: z.boolean().nullable().optional(),
    usage: z.number().nullable(),
    mhz: z.number().nullable(),
    celsius: z.number().nullable(),
  }),
  power: z
    .object({ low: z.boolean(), lastLowAt: z.string().nullable() })
    .nullable(),
  network: z
    .object({
      interface: z.string(),
      kind: z.enum(["wifi", "ethernet", "other"]),
      address: z.string().nullable(),
      signalDbm: z.number().nullable(),
      speedMbps: z.number().nullable(),
    })
    .nullable(),
  clock: z.boolean().nullable(),
  services: z.array(
    z.object({
      name: z.string(),
      apps: z.array(z.string()),
      state: z.enum(["off", "starting", "running", "waiting", "failed"]),
      problem: z.string().optional(),
      // It waits for what the home has never had; an older manager says
      // nothing of it.
      neverSetUp: z.boolean().optional(),
    }),
  ),
});
export type HostStatus = z.infer<typeof hostStatus>;

// Apps only see the resource readings, even if an older manager sends
// the full status.
export const hostResources = hostStatus
  .pick({ model: true })
  .extend({
    processor: hostStatus.shape.processor.pick({
      name: true,
      cores: true,
      matrixInstructions: true,
    }),
    memory: hostStatus.shape.memory
      .unwrap()
      .pick({ total: true, available: true })
      .nullable(),
    storage: hostStatus.shape.storage.unwrap().pick({ free: true }).nullable(),
  })
  .transform((status): HostResources => ({
    processor: {
      name: status.model ?? status.processor.name ?? null,
      cores: status.processor.cores,
      matrixInstructions: status.processor.matrixInstructions ?? null,
    },
    memory: status.memory && {
      totalBytes: status.memory.total,
      availableBytes: status.memory.available,
    },
    storage: status.storage && { freeBytes: status.storage.free },
  }));

// One service, as GET /api/services/:service answers it: where it answers
// over HTTP while it runs, as Ollama does.
export const serviceStatus = z.object({
  service: z.looseObject({ url: z.string().optional() }),
});

// The host's last 24 hours (apps/manager/src/host/history.ts): each 5
// minutes' mean, oldest first.
export const hostHistory = z.object({
  points: z.array(
    z.object({
      at: z.string(),
      usage: z.number().nullable(),
      celsius: z.number().nullable(),
      memoryUsed: z.number().nullable(),
    }),
  ),
});
export type HostHistory = z.infer<typeof hostHistory>;

// What Free up space would remove and keep (apps/manager/src/host/space.ts).
export const spacePlan = z.object({
  bytes: z.number(),
  images: z.array(
    z.object({ service: z.string(), version: z.string().nullable() }),
  ),
  devBuilds: z.number(),
  keeps: z.object({
    running: z.string(),
    before: z.string().nullable(),
    newest: z.string().nullable(),
  }),
});
export type SpacePlan = z.infer<typeof spacePlan>;
export const spaceFreed = z.object({ freed: z.number().nullable() });

// What an app gets for a service (apps/manager/src/services/services.ts):
// its own broker account, or where the service answers over HTTP, and
// anything else the service hands out, such as Zigbee2MQTT's base topic.
export const serviceGrant = z.object({
  connection: z.looseObject({
    mqtt: z
      .object({
        url: z.string(),
        username: z.string(),
        password: z.string(),
        topics: z.array(z.string()),
      })
      .optional(),
    http: z.object({ url: z.string() }).optional(),
  }),
});

// How an app's container stands.
export const appContainer = z.object({
  state: z.enum(["running", "stopped", "none"]),
  exitCode: z.number().optional(),
  outOfMemory: z.boolean().optional(),
});

export const appUsage = z.object({
  memoryBytes: z.number().nullable(),
  processor: z.number().nullable(),
  dataBytes: z.number().nullable(),
});

// Which policy of what an app's network may reach the manager has loaded
// (app-host/lan.ts): the core's run and its count for it, and the manager's
// run and the holder, the container that owns the app's network, it's in.
export const lanVersion = z.object({
  core: z.string().min(1).max(64),
  count: z.number().int().min(1),
  manager: z.string().min(1).max(64),
  holder: z.string().min(1).max(128),
});
export type LanVersion = z.infer<typeof lanVersion>;

// What a start did: whether it kept the one running, and which policy its
// network's rules hold, for an app that reaches devices.
export const startedBody = z.object({
  kept: z.boolean().optional(),
  lan: lanVersion.optional(),
});

// What the manager can do. An update replaces the core before the manager, so a
// new core can find itself under an old manager, which knows no such question.
export const capabilities = z.object({
  appContainers: z.boolean(),
  memoryLimits: z.boolean(),
  // Whether it looks for devices on the home's network, and whether it gives
  // an app that reaches them a network of its own with Sanctum's rules; a
  // manager from before either doesn't say.
  discovery: z.boolean().default(false),
  lan: z.boolean().default(false),
  // Whether it deletes a removed app's data, and a service's.
  deletesData: z.boolean().default(false),
  // Whether it keeps one count of the memory and disk it has promised, which
  // an add reserves from and the add sheet reads.
  reserves: z.boolean().default(false),
});
export type ManagerCapabilities = z.infer<typeof capabilities>;
export const noCapabilities: ManagerCapabilities = {
  appContainers: false,
  memoryLimits: false,
  discovery: false,
  lan: false,
  deletesData: false,
  reserves: false,
};

// What's left for another app, by the count a start uses.
const appCapacity = z.object({
  memoryNeedsMb: z.number().nonnegative(),
  memoryFreeMb: z.number().nonnegative(),
  dataNeedsMb: z.number().nonnegative(),
  dataFreeBytes: z.number().nonnegative().nullable(),
});
export type AppCapacity = z.infer<typeof appCapacity>;
export const appCapacities = z.record(z.string(), appCapacity);

export const appReservation = z.object({
  id: z.string(),
  until: z.string(),
});

// What the manager found on the home's network: what changed after the
// core's last answer, or every sighting, and where the next question starts.
export const discoveryAnswer = z.object({
  after: z.string().min(1).max(100),
  full: z.boolean(),
  found: z.array(sightingSchema).max(10_000),
  lost: z.array(sightingLostSchema).max(10_000),
});
export type DiscoveryAnswer = z.infer<typeof discoveryAnswer>;

export const appUpdatesHeld = z.object({
  updates: z.record(z.string(), z.object({ id: z.string() })),
});

export const keptCopy = z.object({
  kept: z
    .object({
      id: z.string(),
      from: z.object({ version: z.string(), folder: z.string() }),
      at: z.string(),
    })
    .nullable(),
});

export const stagedApps = z.object({
  apps: z.record(
    z.string(),
    z.object({ version: z.string(), folder: z.string() }),
  ),
});

export const zigbeeSticks = z.object({
  candidates: z.array(
    z.object({
      path: z.string(),
      label: z.string(),
      profileId: z.string().nullable(),
    }),
  ),
});

export const heldServices = z.object({
  services: z.array(z.object({ name: z.string(), apps: z.array(z.string()) })),
});
