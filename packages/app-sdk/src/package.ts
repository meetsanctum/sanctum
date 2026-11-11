import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { defineApp, type AppDefinition } from "./index.js";

// An app's package as it stands in a folder: one whose entry's default export
// is its defineApp(), with its static manifest beside it. The core and an
// app's runner read it the same way.

export const manifestFileName = "sanctum-app.json";

const target = z.union([
  z.string(),
  z.object({ import: z.string().optional(), default: z.string().optional() }),
]);
const packageJson = z.object({
  exports: z.union([z.object({ ".": target }), target]).optional(),
  main: z.string().optional(),
});

// The package's main entry: exports["."], then main.
function entryOf(manifest: z.output<typeof packageJson>) {
  const root =
    typeof manifest.exports === "object" && "." in manifest.exports
      ? manifest.exports["."]
      : manifest.exports;
  const entry =
    typeof root === "string" ? root : (root?.import ?? root?.default);
  return entry ?? manifest.main ?? "index.js";
}

// A path inside the package; nothing it names may lead out of it.
async function inside(packageDir: string, path: string) {
  const root = resolve(packageDir);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`${path} leads out of the package`);
  }
  const [realRoot, realFull] = await Promise.all([
    realpath(root),
    realpath(full),
  ]);
  if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) {
    throw new Error(`${path} leads out of the package`);
  }
  return realFull;
}

/** Runs the package's entry, and answers with its app and where its migrations are. */
export async function loadPackagedApp(packageDir: string): Promise<{
  app: AppDefinition;
  migrationsFolder?: string;
}> {
  const packaged = packageJson.parse(
    JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")),
  );
  const loaded = (await import(
    pathToFileURL(await inside(packageDir, entryOf(packaged))).href
  )) as { default?: unknown };
  if (!loaded.default || typeof loaded.default !== "object") {
    throw new Error("Its entry has no app as its default export");
  }
  const app = defineApp(loaded.default as Parameters<typeof defineApp>[0]);
  return {
    app,
    ...(app.migrations
      ? { migrationsFolder: await inside(packageDir, app.migrations) }
      : {}),
  };
}

/** A manifest's digest, as an app's runner names it to the core. */
export function manifestDigest(manifest: string | Buffer) {
  return createHash("sha256").update(manifest).digest("hex");
}
