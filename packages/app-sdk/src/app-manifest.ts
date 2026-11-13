import { z } from "zod";

import { permissionRequestSchema } from "./permissions.js";

const reverseDnsId = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
// SemVer 2.0: numeric identifiers cannot have leading zeroes; build metadata can.
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const pageId = /^[a-z][a-zA-Z0-9-]*$/;

/** A summary stays short enough to show whole on a phone. */
export const summaryMaxLength = 80;

/** The memory an app's container gets, in MB, unless it asks for more. */
export const defaultMemory = 128;
export const maxMemory = 512;
/** The image an app's data lives on, in MB, unless it asks for more. */
export const defaultData = 256;
export const minData = 64;
export const maxData = 4096;

const packageFolder = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "use a folder inside the app's package, such as migrations",
  );

/**
 * The eight app colours: an app's icon takes one as its fill, and its widget
 * titles the matching text shade.
 */
export const appColors = [
  "ember",
  "sun",
  "ruby",
  "leaf",
  "sky",
  "blossom",
  "iris",
  "graphite",
] as const;
export type AppColor = (typeof appColors)[number];

/** An app's icon: a Lucide glyph name and app colour; the UI supplies matching artwork. */
export const appIconSchema = z.object({
  glyph: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use a name such as sofa"),
  color: z.enum(appColors),
});
export type AppIcon = z.infer<typeof appIconSchema>;

/** The page the app overview opens. */
export const mainPage = "main";

// An app's origin (system, official or third-party) is not part of its
// manifest: the core decides it from where the package came from.
export const appManifestSchema = z.object({
  id: z
    .string()
    .regex(reverseDnsId, "use a reverse-DNS id such as sanctum.example"),
  name: z.string().min(1),
  version: z.string().regex(semver, "use a semver version such as 0.1.0"),
  // The range of the core's app API the app targets.
  core: z.string().min(1),
  // Each with its reason and whether the app needs it to work. Services the
  // manager runs for the app are permissions too, such as
  // services:zigbee2mqtt.
  permissions: z.array(permissionRequestSchema),
  // What it does, in one line its settings page shows, such as "The forecast
  // and sun times for where your home is."
  summary: z
    .string()
    .trim()
    .min(1)
    .max(summaryMaxLength)
    .regex(/^[^\r\n\u2028\u2029]*$/, "use a single line")
    .optional(),
  // What it needs to run beside the core: memory in MB, 128 unless it asks
  // for more, and the image its data lives on, 256 MB unless it asks.
  runtime: z
    .strictObject({
      memory: z.number().int().min(64).max(maxMemory).optional(),
      data: z.number().int().min(minData).max(maxData).optional(),
    })
    .optional(),
  // Drizzle Kit's output for the app's own database, inside its package. The
  // core applies it.
  migrations: packageFolder.optional(),
  icon: appIconSchema.optional(),
  // The pages its UI brings, by name. The app overview lists an app that has
  // a `main` page and opens it there.
  pages: z
    .array(z.string().regex(pageId, "use a page name such as main or room"))
    .optional(),
});
export type AppManifestFields = z.infer<typeof appManifestSchema>;
