import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  // The manager's API listens only on this Unix socket.
  MANAGER_SOCKET: z.string().min(1).default("./data/manager.sock"),
  // The manager's own state: host identity and update journal.
  MANAGER_DATA_DIR: z.string().default("./data"),
  // The core's data volume, as mounted into the manager, for update backups.
  MANAGER_CORE_DATA_DIR: z.string().default("./data/core"),
  // On a host and in a development stack the manager owns the core's
  // container and updates; without this it leaves Docker alone.
  MANAGER_SUPERVISE: booleanFlag,
  // Announce the host on the local network over mDNS.
  MANAGER_ANNOUNCE: booleanFlag,
  // The host's /dev, mounted read-only, to find a Zigbee coordinator.
  MANAGER_HOST_DEV_DIR: z.string().min(1).default("/dev"),
  // Where the core answers on this host, for update health checks.
  MANAGER_CORE_URL: z.url().default("https://127.0.0.1:4100"),
  // How long the core's certificates last, in days. Shorter only to watch
  // renewals on a dev host, and never under about seven minutes: the core
  // checks once a minute and renews with a third left.
  MANAGER_CERTIFICATE_DAYS: z.coerce.number().min(0.005).max(90).default(90),
  // stable (tagged releases), edge (main, published by hand) or dev (builds
  // pushed from a developer's machine). Chosen when a host is set up, never at
  // runtime.
  SANCTUM_CHANNEL: z.enum(["stable", "edge", "dev"]).default("stable"),
  SANCTUM_IMAGE_OWNER: z.string().min(1).default("meetsanctum"),
  // The dev channel's registry, as seen by the host's Docker daemon.
  SANCTUM_DEV_REGISTRY: z.string().min(1).default("localhost:5000"),
  SANCTUM_VERSION: z.string().default("dev"),
});

export type Channel = z.infer<typeof envSchema>["SANCTUM_CHANNEL"];

export type ManagerConfig = {
  socket: string;
  dataDir: string;
  coreDataDir: string;
  supervise: boolean;
  announce: boolean;
  hostDevDir: string;
  coreUrl: string;
  certificateDays: number;
  channel: Channel;
  imageOwner: string;
  devRegistry: string;
  version: string;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ManagerConfig {
  const parsed = envSchema.parse(env);
  if (
    parsed.MANAGER_CERTIFICATE_DAYS !== 90 &&
    parsed.SANCTUM_CHANNEL !== "dev"
  ) {
    throw new Error("MANAGER_CERTIFICATE_DAYS is only for a dev host");
  }
  return {
    socket: parsed.MANAGER_SOCKET,
    dataDir: parsed.MANAGER_DATA_DIR,
    coreDataDir: parsed.MANAGER_CORE_DATA_DIR,
    supervise: parsed.MANAGER_SUPERVISE,
    announce: parsed.MANAGER_ANNOUNCE,
    hostDevDir: parsed.MANAGER_HOST_DEV_DIR,
    coreUrl: parsed.MANAGER_CORE_URL,
    certificateDays: parsed.MANAGER_CERTIFICATE_DAYS,
    channel: parsed.SANCTUM_CHANNEL,
    imageOwner: parsed.SANCTUM_IMAGE_OWNER,
    devRegistry: parsed.SANCTUM_DEV_REGISTRY,
    version: parsed.SANCTUM_VERSION,
  };
}
