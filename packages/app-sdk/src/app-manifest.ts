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

// WCAG's relative luminance of a #rrggbb colour.
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "use a colour such as #0a5c7a");

// The shade the shell lays along the page's top, black at 24%, leaves this
// share of a colour's luminance under it.
const underShade = 0.76 ** 2.2;

/**
 * The colours of the page the shell draws for an app without a page of its
 * own, from its bottom left to its top right. The app's name stands in white
 * on the first, so it must be dark enough for white text to read at 4.5:1;
 * the top bar's white buttons stand on the second under a faint shade, so it
 * must leave them at 3:1.
 */
export const appBackdropSchema = z.strictObject({
  from: hexColor.refine(
    (hex) => 1.05 / (luminance(hex) + 0.05) >= 4.5,
    "use a colour dark enough for white text, at 4.5:1 or more",
  ),
  to: hexColor.refine(
    (hex) => 1.05 / (luminance(hex) * underShade + 0.05) >= 3,
    "use a colour dark enough for the top bar's white buttons, at 3:1 or more",
  ),
});
export type AppBackdrop = z.infer<typeof appBackdropSchema>;

/**
 * The version of the app API this core serves, which a manifest's `core`
 * range must include for the core to run the app. It moves on its own,
 * apart from Sanctum's version: a major only when an app built for the one
 * before can no longer run.
 */
export const appApiVersion = "2.0.0";

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
  // Its own colours, such as its brand's, for the page the shell draws when
  // it brings none; without them that page takes its icon's colour.
  backdrop: appBackdropSchema.optional(),
  // The pages its UI brings, by name. The app overview lists an app that has
  // a `main` page and opens it there.
  pages: z
    .array(z.string().regex(pageId, "use a page name such as main or room"))
    .optional(),
});
export type AppManifestFields = z.infer<typeof appManifestSchema>;
