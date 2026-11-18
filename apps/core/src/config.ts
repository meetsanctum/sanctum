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
  // The official apps' packages in the core's image, one folder each, which
  // the manager stages for it. The core reads only their ids there, to know
  // which it waits for: it runs each from what's staged.
  CORE_OFFICIAL_APPS_DIR: z.string().min(1).default("/app/catalog/official"),
  // More apps to run, as `id@folder` with commas between: the folder of the
  // version staged for each, which the manager keeps here. Official apps come
  // from what the manager staged for this image, so this is for tests.
  CORE_APPS_APART: z.string().default(""),
  CORE_PACKAGES_DIR: z.string().min(1).default("/packages"),
  // The kit in the core's image: React and ui-sdk as the modules apps' pages
  // import.
  CORE_KIT_DIR: z.string().min(1).default("/app/kit"),
  // The manager's socket. The default is where the manager puts it when run
  // from the workspace.
  CORE_MANAGER_SOCKET: z
    .string()
    .min(1)
    .default("../manager/data/manager.sock"),
  // The apps a new home starts with, with commas between: those every home
  // with lights uses. Every other app the image ships waits to be added.
  CORE_NEW_HOME_APPS: z
    .string()
    .default("sanctum.moods,sanctum.natural-light,sanctum.weather"),
  SANCTUM_VERSION: z.string().default("dev"),
});

export type CoreConfig = {
  host: string;
  port: number;
  allowedOrigins: string[];
  dataDir: string;
  plainHttp: boolean;
  officialAppsDir: string;
  appsApart: string[];
  packagesDir: string;
  kitDir: string;
  managerSocket: string;
  newHomeApps: string[];
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
    officialAppsDir: parsed.CORE_OFFICIAL_APPS_DIR,
    appsApart: parsed.CORE_APPS_APART.split(",")
      .map((app) => app.trim())
      .filter((app) => app.length > 0),
    packagesDir: parsed.CORE_PACKAGES_DIR,
    kitDir: parsed.CORE_KIT_DIR,
    managerSocket: parsed.CORE_MANAGER_SOCKET,
    newHomeApps: parsed.CORE_NEW_HOME_APPS.split(",")
      .map((app) => app.trim())
      .filter((app) => app.length > 0),
    version: parsed.SANCTUM_VERSION,
  };
}
