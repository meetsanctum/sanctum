import type { StaticManifest } from "@meetsanctum/app-sdk";
import {
  loadPackagedApp,
  manifestDigest,
  manifestFileName,
} from "@meetsanctum/app-sdk/package";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApartPackage, AppPackage, Origin } from "./host.js";

// Finds app packages in a folder, such as the workspace's catalog/apps: one
// folder per package, whose entry's default export is its defineApp(). The
// core gives each the origin of the place it was found, never one from the
// package.

type Log = (message: string) => void;

export async function loadAppPackage(
  packageDir: string,
  origin: Origin,
): Promise<AppPackage> {
  const { app, migrationsFolder } = await loadPackagedApp(packageDir);
  const manifest = await readFile(join(packageDir, manifestFileName), "utf8")
    .then((text) => JSON.parse(text) as StaticManifest)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  return {
    app,
    ...(manifest ? { manifest } : {}),
    origin,
    ...(migrationsFolder ? { migrationsFolder } : {}),
  };
}

// An app that runs apart, at the version staged in its folder: the core reads
// its manifest there and imports nothing of it.
export async function loadApartPackage(
  packagesDir: string,
  appId: string,
  folder: string,
  origin: Origin,
): Promise<ApartPackage> {
  const text = await readFile(
    join(packagesDir, appId, folder, manifestFileName),
  );
  const manifest = JSON.parse(text.toString("utf8")) as StaticManifest;
  if (manifest.id !== appId) {
    throw new Error(`This package holds ${manifest.id}, not ${appId}`);
  }
  return { apart: { manifest, digest: manifestDigest(text), folder }, origin };
}

// Every app the core is told runs apart, as `id@folder`. One that doesn't load is
// logged and left out, as any other package.
export async function loadApartPackages(
  apart: readonly string[],
  packagesDir: string,
  log: Log,
): Promise<ApartPackage[]> {
  const packages: ApartPackage[] = [];
  for (const each of apart) {
    const [appId = "", folder = ""] = each.split("@");
    try {
      packages.push(
        await loadApartPackage(packagesDir, appId, folder, "official"),
      );
    } catch (error) {
      log(
        `apps: ${each} was not loaded (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return packages;
}

// Every package in `dir` that loads. One that does not is logged and left
// out, so it cannot keep the core or the other apps from starting.
export async function loadAppPackages(
  dir: string,
  origin: Origin,
  log: Log,
): Promise<AppPackage[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const packages: AppPackage[] = [];
  for (const entry of entries
    .filter((each) => each.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      packages.push(await loadAppPackage(join(dir, entry.name), origin));
    } catch (error) {
      log(
        `apps: ${entry.name} was not loaded (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return packages;
}
