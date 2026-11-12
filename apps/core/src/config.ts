import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  CORE_HOST: z.string().default("127.0.0.1"),
  CORE_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  // Comma-separated origins that may call the core from a browser, such as
  // http://localhost:5173.
  CORE_ALLOWED_ORIGINS: z.string().default(""),
  CORE_DATA_DIR: z.string().default("./data"),
  // Plain HTTP, for `pnpm dev` only. Otherwise the core serves HTTPS with a
  // certificate the manager signs, and waits for one.
  CORE_PLAIN_HTTP: booleanFlag,
  // The app packages the core ships with, one folder each, kept apart by
  // origin: system apps are part of the host, official ones are Sanctum's
  // own apps. The workspace's catalog, where the default looks, holds
  // official apps; on a host no system app is a package.
  CORE_SYSTEM_APPS_DIR: z.string().min(1).optional(),
  CORE_OFFICIAL_APPS_DIR: z.string().min(1).default("../../catalog/apps"),
  // Apps that run in their own containers, as `id@folder` with commas between:
  // the folder of the version staged for each, which the manager keeps here.
  // Official apps that run apart come from CORE_OFFICIAL_APPS_APART, so this
  // is for tests.
  CORE_APPS_APART: z.string().default(""),
  // The official apps that run apart, from what the manager staged for this image.
  CORE_OFFICIAL_APPS_APART: z
    .string()
    .default("sanctum.weather,sanctum.natural-light,sanctum.moods"),
  CORE_PACKAGES_DIR: z.string().min(1).default("/packages"),
  // The manager's socket. The default is where the manager puts it when run
  // from the workspace.
  CORE_MANAGER_SOCKET: z
    .string()
    .min(1)
    .default("../manager/data/manager.sock"),
  SANCTUM_VERSION: z.string().default("dev"),
});

export type CoreConfig = {
  host: string;
  port: number;
  allowedOrigins: string[];
  dataDir: string;
  plainHttp: boolean;
  systemAppsDir?: string;
  officialAppsDir: string;
  appsApart: string[];
  officialAppsApart: string[];
  packagesDir: string;
  managerSocket: string;
  version: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const parsed = envSchema.parse(env);
  return {
    host: parsed.CORE_HOST,
    port: parsed.CORE_PORT,
    allowedOrigins: parsed.CORE_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    dataDir: parsed.CORE_DATA_DIR,
    plainHttp: parsed.CORE_PLAIN_HTTP,
    ...(parsed.CORE_SYSTEM_APPS_DIR
      ? { systemAppsDir: parsed.CORE_SYSTEM_APPS_DIR }
      : {}),
    officialAppsDir: parsed.CORE_OFFICIAL_APPS_DIR,
    appsApart: parsed.CORE_APPS_APART.split(",")
      .map((app) => app.trim())
      .filter((app) => app.length > 0),
    officialAppsApart: parsed.CORE_OFFICIAL_APPS_APART.split(",")
      .map((app) => app.trim())
      .filter((app) => app.length > 0),
    packagesDir: parsed.CORE_PACKAGES_DIR,
    managerSocket: parsed.CORE_MANAGER_SOCKET,
    version: parsed.SANCTUM_VERSION,
  };
}
